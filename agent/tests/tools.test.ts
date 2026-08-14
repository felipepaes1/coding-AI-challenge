import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  allowedCommands,
  createAgentTools,
  sanitizeCommandOutput,
  toolSchemas,
} from "../src/tools/index.js";

async function createFixture(): Promise<string> {
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), "agent-tools-"));
  await mkdir(resolve(workspaceRoot, "src"), { recursive: true });
  await writeFile(
    resolve(workspaceRoot, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "echo test" } }),
    "utf8",
  );
  await writeFile(resolve(workspaceRoot, "src", "existing.ts"), "export const value = 1;", "utf8");
  return workspaceRoot;
}

describe("agent tools", () => {
  it("exposes all tools with Zod schemas", () => {
    const tools = createAgentTools(".");

    expect(Object.keys(tools).sort()).toEqual([
      "getProjectSummary",
      "listFiles",
      "readFile",
      "runCommand",
      "writeFile",
    ]);
    expect(toolSchemas.writeFile.safeParse({ path: "src/App.tsx", content: "export {};" }).success).toBe(true);
    expect(toolSchemas.runCommand.safeParse({ command: "npm test" }).success).toBe(true);
    expect(toolSchemas.runCommand.safeParse({ command: "npm run dev" }).success).toBe(false);
  });

  it("lists and reads files through the SDK tool interface", async () => {
    const workspaceRoot = await createFixture();
    try {
      const tools = createAgentTools(workspaceRoot);
      const listed = await tools.listFiles.invoke(
        {} as never,
        JSON.stringify({ relativePath: ".", recursive: true }),
      );
      const read = await tools.readFile.invoke(
        {} as never,
        JSON.stringify({ path: "src/existing.ts" }),
      );

      expect(listed).toMatchObject({ ok: true });
      expect(JSON.stringify(listed)).toContain("src/existing.ts");
      expect(read).toMatchObject({
        ok: true,
        path: "src/existing.ts",
        content: "export const value = 1;",
      });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("emits safe lifecycle events without file contents", async () => {
    const workspaceRoot = await createFixture();
    const events: Array<{ type: string; tool: string; detail: string }> = [];
    try {
      const tools = createAgentTools(workspaceRoot, {
        onEvent: (event) => {
          events.push(event);
        },
      });
      await tools.readFile.invoke(
        {} as never,
        JSON.stringify({ path: "src/existing.ts" }),
      );

      expect(events).toMatchObject([
        {
          type: "tool_started",
          tool: "readFile",
          detail: "path=src/existing.ts",
        },
        {
          type: "tool_completed",
          tool: "readFile",
          detail: "path=src/existing.ts",
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("export const value");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("writes nested files and reports the exact relative path", async () => {
    const workspaceRoot = await createFixture();
    try {
      const tools = createAgentTools(workspaceRoot);
      const result = await tools.writeFile.invoke(
        {} as never,
        JSON.stringify({
          path: "src/generated/feature.ts",
          content: "export const feature = true;",
        }),
      );

      expect(result).toMatchObject({
        ok: true,
        path: "src/generated/feature.ts",
        created: true,
      });
      await expect(readFile(resolve(workspaceRoot, "src/generated/feature.ts"), "utf8")).resolves.toBe(
        "export const feature = true;",
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("can require workspace inspection before a repair writes", async () => {
    const workspaceRoot = await createFixture();
    try {
      const tools = createAgentTools(workspaceRoot, {
        requireInspectionBeforeWrite: true,
      });
      const blocked = await tools.writeFile.invoke(
        {} as never,
        JSON.stringify({ path: "src/existing.ts", content: "blocked" }),
      );

      expect(blocked).toMatchObject({ ok: false, code: "INSPECTION_REQUIRED" });

      await tools.readFile.invoke(
        {} as never,
        JSON.stringify({ path: "src/existing.ts" }),
      );
      const written = await tools.writeFile.invoke(
        {} as never,
        JSON.stringify({ path: "src/existing.ts", content: "repaired" }),
      );

      expect(written).toMatchObject({ ok: true, path: "src/existing.ts" });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("restricts writes to the current task file list", async () => {
    const workspaceRoot = await createFixture();
    try {
      const tools = createAgentTools(workspaceRoot, {
        allowedWritePaths: ["src/existing.ts"],
      });
      const allowed = await tools.writeFile.invoke(
        {} as never,
        JSON.stringify({ path: "src/existing.ts", content: "allowed" }),
      );
      const blocked = await tools.writeFile.invoke(
        {} as never,
        JSON.stringify({ path: "src/unplanned.ts", content: "blocked" }),
      );

      expect(allowed).toMatchObject({ ok: true, path: "src/existing.ts" });
      expect(blocked).toMatchObject({ ok: false, code: "WRITE_NOT_ALLOWED" });
      await expect(readFile(resolve(workspaceRoot, "src/unplanned.ts"), "utf8")).rejects.toThrow();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("rejects absolute and escaping write paths", async () => {
    const workspaceRoot = await createFixture();
    try {
      const tools = createAgentTools(workspaceRoot);
      const outside = await tools.writeFile.invoke(
        {} as never,
        JSON.stringify({ path: "../outside.txt", content: "blocked" }),
      );
      const absolute = await tools.writeFile.invoke(
        {} as never,
        JSON.stringify({ path: resolve(workspaceRoot, "outside.txt"), content: "blocked" }),
      );

      expect(outside).toMatchObject({ ok: false, code: "PATH_ESCAPE" });
      expect(absolute).toMatchObject({ ok: false, code: "INVALID_PATH" });
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("returns package metadata and the workspace tree", async () => {
    const workspaceRoot = await createFixture();
    try {
      const tools = createAgentTools(workspaceRoot);
      const summary = await tools.getProjectSummary.invoke({} as never, JSON.stringify({}));

      expect(summary).toMatchObject({
        ok: true,
        workspaceRoot,
        packageJson: { name: "fixture" },
      });
      expect(JSON.stringify(summary)).toContain("package.json");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("excludes generated dependency and build directories from recursive summaries", async () => {
    const workspaceRoot = await createFixture();
    try {
      await mkdir(resolve(workspaceRoot, "node_modules", "dependency"), { recursive: true });
      await mkdir(resolve(workspaceRoot, "dist"), { recursive: true });
      await writeFile(resolve(workspaceRoot, "node_modules", "dependency", "index.js"), "noise", "utf8");
      await writeFile(resolve(workspaceRoot, "dist", "bundle.js"), "noise", "utf8");

      const tools = createAgentTools(workspaceRoot);
      const summary = await tools.getProjectSummary.invoke({} as never, JSON.stringify({}));
      const serializedSummary = JSON.stringify(summary);

      expect(serializedSummary).toContain("src/existing.ts");
      expect(serializedSummary).not.toContain("node_modules/dependency/index.js");
      expect(serializedSummary).not.toContain("dist/bundle.js");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("keeps the command allowlist explicit", () => {
    expect(allowedCommands).toEqual([
      "npm install",
      "npm run typecheck",
      "npm test",
      "npm run build",
    ]);
  });

  it("removes ANSI control sequences from persisted command output", () => {
    expect(sanitizeCommandOutput("\u001b[31mfailed\u001b[39m")).toBe("failed");
  });

  it("runs an allowlisted command in the generated workspace", async () => {
    const workspaceRoot = await createFixture();
    try {
      const tools = createAgentTools(workspaceRoot);
      const result = await tools.runCommand.invoke(
        {} as never,
        JSON.stringify({ command: "npm test" }),
      );

      expect(result).toMatchObject({
        ok: true,
        command: "npm test",
        passed: true,
        exitCode: 0,
      });
      expect(JSON.stringify(result)).toContain("test");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
