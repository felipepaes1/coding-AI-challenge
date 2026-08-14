export type ProgressLevel = "info" | "success" | "warning" | "error";

export type WorkflowProgressEvent = {
  scope: string;
  message: string;
  level?: ProgressLevel;
  verbose?: boolean;
};

export type ProgressListener = (
  event: WorkflowProgressEvent,
) => void | Promise<void>;

export type TerminalWriter = {
  log: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export function combineProgressListeners(
  ...listeners: Array<ProgressListener | undefined>
): ProgressListener {
  return async (event) => {
    for (const listener of listeners) {
      await listener?.(event);
    }
  };
}

export function createJsonlProgressListener(
  runId: string,
  eventsPath: string,
  now: () => Date = () => new Date(),
): ProgressListener {
  let writeQueue = Promise.resolve();

  return (event) => {
    const line = `${JSON.stringify({
      timestamp: now().toISOString(),
      runId,
      ...event,
    })}\n`;

    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(eventsPath), { recursive: true });
      await appendFile(eventsPath, line, "utf8");
    });
    return writeQueue;
  };
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  return `${(durationMs / 1_000).toFixed(1)}s`;
}

export function createTerminalProgressListener(
  runId: string,
  options: {
    verbose?: boolean;
    writer?: TerminalWriter;
  } = {},
): ProgressListener {
  const writer = options.writer ?? console;

  return (event) => {
    if (event.verbose && !options.verbose) {
      return;
    }

    const line = `[${runId}] [${event.scope}] ${event.message}`;
    switch (event.level) {
      case "error":
        writer.error(line);
        break;
      case "warning":
        writer.warn(line);
        break;
      default:
        writer.log(line);
    }
  };
}
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
