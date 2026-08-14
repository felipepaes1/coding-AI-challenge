import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  combineProgressListeners,
  createJsonlProgressListener,
  createTerminalProgressListener,
} from "../src/progress.js";

describe("terminal progress logger", () => {
  it("prefixes scopes and hides verbose events by default", async () => {
    const lines: string[] = [];
    const progress = createTerminalProgressListener("run-123", {
      writer: {
        log: (line) => lines.push(`log:${line}`),
        warn: (line) => lines.push(`warn:${line}`),
        error: (line) => lines.push(`error:${line}`),
      },
    });

    await progress({ scope: "planner", message: "Planning started" });
    await progress({
      scope: "generator:readFile",
      message: "Read src/App.tsx",
      verbose: true,
    });
    await progress({
      scope: "validator",
      message: "Typecheck failed",
      level: "error",
    });

    expect(lines).toEqual([
      "log:[run-123] [planner] Planning started",
      "error:[run-123] [validator] Typecheck failed",
    ]);
  });

  it("shows detailed events when verbose mode is enabled", async () => {
    const lines: string[] = [];
    const progress = createTerminalProgressListener("run-verbose", {
      verbose: true,
      writer: {
        log: (line) => lines.push(line),
        warn: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
    });

    await progress({
      scope: "generator:readFile",
      message: "Completed (path=src/App.tsx)",
      verbose: true,
    });

    expect(lines).toEqual([
      "[run-verbose] [generator:readFile] Completed (path=src/App.tsx)",
    ]);
  });

  it("persists every event as JSONL even when terminal verbosity hides it", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "agent-progress-"));
    const eventsPath = resolve(directory, "nested", "events.jsonl");
    const terminalLines: string[] = [];
    const progress = combineProgressListeners(
      createTerminalProgressListener("run-jsonl", {
        writer: {
          log: (line) => terminalLines.push(line),
          warn: (line) => terminalLines.push(line),
          error: (line) => terminalLines.push(line),
        },
      }),
      createJsonlProgressListener(
        "run-jsonl",
        eventsPath,
        () => new Date("2026-08-14T18:00:00.000Z"),
      ),
    );

    try {
      await progress({
        scope: "generator:readFile",
        message: "Read src/App.tsx",
        verbose: true,
      });
      await progress({ scope: "validator", message: "Tests passed", level: "success" });

      expect(terminalLines).toEqual([
        "[run-jsonl] [validator] Tests passed",
      ]);
      const events = (await readFile(eventsPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(events).toEqual([
        {
          timestamp: "2026-08-14T18:00:00.000Z",
          runId: "run-jsonl",
          scope: "generator:readFile",
          message: "Read src/App.tsx",
          verbose: true,
        },
        {
          timestamp: "2026-08-14T18:00:00.000Z",
          runId: "run-jsonl",
          scope: "validator",
          message: "Tests passed",
          level: "success",
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
