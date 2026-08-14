import { access, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunId,
  loadSpecification,
  prepareOutputWorkspace,
  projectRoot,
  resolveOutputPath,
  WorkspaceError,
} from "../src/workspace.js";
import { runWorkspaceCommand } from "../src/tools/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("workspace utilities", () => {
  it("creates a run identifier with a timestamp and unique suffix", () => {
    expect(createRunId(new Date("2026-01-02T03:04:05.000Z"))).toMatch(
      /^20260102030405-[0-9a-f]{8}$/,
    );
  });

  it("loads a non-empty UTF-8 specification relative to the project root", async () => {
    const specification = await loadSpecification("README.md");

    expect(specification.path).toBe(resolve(projectRoot, "README.md"));
    expect(specification.content.length).toBeGreaterThan(0);
  });

  it("rejects missing specifications", async () => {
    await expect(loadSpecification("missing-spec.txt")).rejects.toThrow(
      WorkspaceError,
    );
  });

  it("rejects protected output directories", () => {
    expect(() => resolveOutputPath("src")).toThrow(WorkspaceError);
    expect(() => resolveOutputPath("sample-output")).toThrow(WorkspaceError);
    expect(() => resolveOutputPath("../outside-project")).toThrow(WorkspaceError);
  });

  it("copies and validates the boilerplate without agent dependencies or caches", async () => {
    const projectRelativeOutput = resolve(projectRoot, "tmp", "workspace-test-output");
    temporaryDirectories.push(projectRelativeOutput);

    const preparedPath = await prepareOutputWorkspace("tmp/workspace-test-output");

    expect(preparedPath).toBe(projectRelativeOutput);
    await expect(access(resolve(preparedPath, "package.json"))).resolves.toBeUndefined();
    await expect(access(resolve(preparedPath, "src", "App.tsx"))).resolves.toBeUndefined();
    await expect(access(resolve(preparedPath, "agent"))).rejects.toThrow();
    await expect(access(resolve(preparedPath, "sample-output"))).rejects.toThrow();
    await expect(access(resolve(preparedPath, "node_modules"))).rejects.toThrow();
    await expect(access(resolve(preparedPath, ".env.example"))).rejects.toThrow();
    await expect(access(resolve(preparedPath, "README.md"))).rejects.toThrow();
    await expect(access(resolve(preparedPath, "tsconfig.tsbuildinfo"))).rejects.toThrow();
    await expect(readFile(resolve(preparedPath, "vitest.config.ts"), "utf8"))
      .resolves.toContain('setupFiles: [resolve(__dirname, "src/test-setup.ts")]');

    const nestedTest = await runWorkspaceCommand(preparedPath, "npm test");
    expect(nestedTest).toMatchObject({ passed: true, exitCode: 0 });
  }, 30_000);
});
