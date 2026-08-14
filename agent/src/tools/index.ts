import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile as readTextFile, readdir, realpath, rm, stat, writeFile as writeTextFile } from "node:fs/promises";
import { isAbsolute, dirname, posix, relative, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";
import { tool } from "@openai/agents";
import { z } from "zod";

const execFile = promisify(execFileCallback);

const MAX_READ_CHARACTERS = 30_000;
const MAX_WRITE_CHARACTERS = 250_000;
const MAX_LIST_ENTRIES = 500;
const COMMAND_TIMEOUT_MS = 300_000;
const IGNORED_RECURSIVE_DIRECTORIES = new Set([
  ".git",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
]);

export const allowedCommands = [
  "npm install",
  "npm run typecheck",
  "npm test",
  "npm run build",
] as const;

type AllowedCommand = (typeof allowedCommands)[number];

export type ToolFailure = {
  ok: false;
  error: string;
  code: string;
};

export type ToolSuccess<T extends object> = { ok: true } & T;

export type AgentToolEvent =
  | {
      type: "tool_started";
      tool: string;
      detail: string;
    }
  | {
      type: "tool_completed";
      tool: string;
      detail: string;
      ok: boolean;
      durationMs: number;
    };

export type AgentToolOptions = {
  onEvent?: (event: AgentToolEvent) => void | Promise<void>;
  requireInspectionBeforeWrite?: boolean;
  allowedWritePaths?: readonly string[];
};

export type WorkspaceFileSnapshot = {
  path: string;
  existed: boolean;
  content?: string;
};

export class ToolWorkspaceError extends Error {
  constructor(
    message: string,
    public readonly code = "WORKSPACE_ERROR",
  ) {
    super(message);
    this.name = "ToolWorkspaceError";
  }
}

function failure(error: unknown): ToolFailure {
  if (error instanceof ToolWorkspaceError) {
    return { ok: false, error: error.message, code: error.code };
  }

  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    code: "TOOL_ERROR",
  };
}

function isWithinDirectory(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))
  );
}

function toToolRelativePath(workspaceRoot: string, filePath: string): string {
  const relativePath = relative(workspaceRoot, filePath);
  return relativePath === "" ? "." : relativePath.split(sep).join("/");
}

function assertRelativePath(inputPath: string): void {
  if (
    inputPath.trim() === "" ||
    inputPath.includes("\0") ||
    isAbsolute(inputPath) ||
    posix.isAbsolute(inputPath) ||
    win32.isAbsolute(inputPath)
  ) {
    throw new ToolWorkspaceError(
      `Path must be a non-empty relative path inside the workspace: ${inputPath}`,
      "INVALID_PATH",
    );
  }
}

function normalizeWorkspaceRelativePath(inputPath: string): string {
  assertRelativePath(inputPath);
  return posix.normalize(inputPath.replace(/\\/gu, "/")).replace(/^\.\//u, "");
}

async function assertRealPathInside(
  workspaceRootRealPath: string,
  candidatePath: string,
): Promise<string> {
  const candidateRealPath = await realpath(candidatePath);
  if (!isWithinDirectory(workspaceRootRealPath, candidateRealPath)) {
    throw new ToolWorkspaceError(
      `Resolved path escapes the workspace: ${candidatePath}`,
      "PATH_ESCAPE",
    );
  }

  return candidateRealPath;
}

async function resolveExistingPath(
  workspaceRoot: string,
  relativePath: string,
): Promise<{ absolutePath: string; workspaceRootRealPath: string }> {
  assertRelativePath(relativePath);
  const absolutePath = resolve(workspaceRoot, relativePath);
  const workspaceRootRealPath = await realpath(workspaceRoot);

  if (!isWithinDirectory(workspaceRootRealPath, absolutePath)) {
    throw new ToolWorkspaceError(
      `Path escapes the workspace: ${relativePath}`,
      "PATH_ESCAPE",
    );
  }

  try {
    await assertRealPathInside(workspaceRootRealPath, absolutePath);
  } catch (error) {
    if (error instanceof ToolWorkspaceError) {
      throw error;
    }

    throw new ToolWorkspaceError(
      `Path does not exist: ${relativePath}`,
      "FILE_NOT_FOUND",
    );
  }

  return { absolutePath, workspaceRootRealPath };
}

async function resolveWritablePath(
  workspaceRoot: string,
  relativePath: string,
): Promise<{ absolutePath: string; workspaceRootRealPath: string }> {
  assertRelativePath(relativePath);
  const absolutePath = resolve(workspaceRoot, relativePath);
  const workspaceRootRealPath = await realpath(workspaceRoot);

  if (!isWithinDirectory(workspaceRootRealPath, absolutePath)) {
    throw new ToolWorkspaceError(
      `Path escapes the workspace: ${relativePath}`,
      "PATH_ESCAPE",
    );
  }

  const topLevelEntry = relative(workspaceRoot, absolutePath).split(sep)[0];
  if (topLevelEntry === ".git" || topLevelEntry === "node_modules") {
    throw new ToolWorkspaceError(
      `Writing to ${topLevelEntry} is not allowed: ${relativePath}`,
      "PROTECTED_PATH",
    );
  }

  let existingPath = absolutePath;
  while (true) {
    try {
      await assertRealPathInside(workspaceRootRealPath, existingPath);
      break;
    } catch (error) {
      if (error instanceof ToolWorkspaceError && error.code === "PATH_ESCAPE") {
        throw error;
      }

      const parentPath = dirname(existingPath);
      if (parentPath === existingPath) {
        throw new ToolWorkspaceError(
          `Could not find a safe parent directory for: ${relativePath}`,
          "INVALID_PATH",
        );
      }
      existingPath = parentPath;
    }
  }

  return { absolutePath, workspaceRootRealPath };
}

function truncateText(value: string, maxCharacters: number): {
  value: string;
  truncated: boolean;
} {
  if (value.length <= maxCharacters) {
    return { value, truncated: false };
  }

  return {
    value: `${value.slice(0, maxCharacters)}\n...[truncated]`,
    truncated: true,
  };
}

export function sanitizeCommandOutput(value: string): string {
  return value.replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu, "");
}

const listFilesParameters = z.object({
  relativePath: z.string().default("."),
  recursive: z.boolean().default(false),
  maxEntries: z.number().int().min(1).max(MAX_LIST_ENTRIES).default(200),
});

const readFileParameters = z.object({
  path: z.string().min(1),
  maxCharacters: z.number().int().min(1).max(MAX_READ_CHARACTERS).default(MAX_READ_CHARACTERS),
});

const writeFileParameters = z.object({
  path: z.string().min(1),
  content: z.string().max(MAX_WRITE_CHARACTERS),
});

const runCommandParameters = z.object({
  command: z.enum(allowedCommands),
});

const emptyParameters = z.object({});

export type ListedEntry = {
  path: string;
  type: "file" | "directory" | "symlink";
};

export type WorkspaceSummary = {
  workspaceRoot: string;
  packageJson: Record<string, unknown> | null;
  files: ListedEntry[];
  filesTruncated: boolean;
};

export async function listWorkspaceFiles(
  workspaceRoot: string,
  relativePath: string,
  recursive: boolean,
  maxEntries: number,
): Promise<ToolSuccess<{ basePath: string; entries: ListedEntry[]; truncated: boolean }>> {
  const { absolutePath, workspaceRootRealPath } = await resolveExistingPath(
    workspaceRoot,
    relativePath,
  );
  const directoryStats = await stat(absolutePath);
  if (!directoryStats.isDirectory()) {
    throw new ToolWorkspaceError(`Path is not a directory: ${relativePath}`, "NOT_A_DIRECTORY");
  }

  const entries: ListedEntry[] = [];
  let truncated = false;

  async function collect(directoryPath: string): Promise<void> {
    const directoryEntries = await readdir(directoryPath, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of directoryEntries) {
      if (
        recursive &&
        entry.isDirectory() &&
        IGNORED_RECURSIVE_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }

      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }

      const entryPath = resolve(directoryPath, entry.name);
      const entryRelativePath = toToolRelativePath(workspaceRoot, entryPath);
      const type = entry.isSymbolicLink()
        ? "symlink"
        : entry.isDirectory()
          ? "directory"
          : "file";

      if (!entry.isSymbolicLink()) {
        await assertRealPathInside(workspaceRootRealPath, entryPath);
      }

      entries.push({ path: entryRelativePath, type });

      if (recursive && entry.isDirectory()) {
        await collect(entryPath);
      }
    }
  }

  await collect(absolutePath);

  return {
    ok: true,
    basePath: toToolRelativePath(workspaceRoot, absolutePath),
    entries,
    truncated,
  };
}

export async function readWorkspaceFile(
  workspaceRoot: string,
  path: string,
  maxCharacters: number,
): Promise<ToolSuccess<{ path: string; content: string; truncated: boolean }>> {
  const { absolutePath } = await resolveExistingPath(workspaceRoot, path);
  const fileStats = await stat(absolutePath);
  if (!fileStats.isFile()) {
    throw new ToolWorkspaceError(`Path is not a file: ${path}`, "NOT_A_FILE");
  }

  const content = await readTextFile(absolutePath, "utf8");
  const truncatedContent = truncateText(content, maxCharacters);
  return {
    ok: true,
    path: toToolRelativePath(workspaceRoot, absolutePath),
    content: truncatedContent.value,
    truncated: truncatedContent.truncated,
  };
}

export async function writeWorkspaceFile(
  workspaceRoot: string,
  path: string,
  content: string,
): Promise<ToolSuccess<{ path: string; bytesWritten: number; created: boolean }>> {
  const { absolutePath, workspaceRootRealPath } = await resolveWritablePath(workspaceRoot, path);
  const existed = await stat(absolutePath).then(() => true).catch(() => false);

  await mkdir(dirname(absolutePath), { recursive: true });
  await assertRealPathInside(workspaceRootRealPath, dirname(absolutePath));
  await writeTextFile(absolutePath, content, "utf8");
  await assertRealPathInside(workspaceRootRealPath, absolutePath);

  return {
    ok: true,
    path: toToolRelativePath(workspaceRoot, absolutePath),
    bytesWritten: Buffer.byteLength(content, "utf8"),
    created: !existed,
  };
}

export async function snapshotWorkspaceFiles(
  workspaceRoot: string,
  paths: readonly string[],
): Promise<WorkspaceFileSnapshot[]> {
  const snapshots: WorkspaceFileSnapshot[] = [];
  const uniquePaths = [...new Set(paths.map(normalizeWorkspaceRelativePath))];

  for (const path of uniquePaths) {
    try {
      const file = await readWorkspaceFile(workspaceRoot, path, MAX_WRITE_CHARACTERS);
      if (file.truncated) {
        throw new ToolWorkspaceError(
          `Cannot snapshot a file larger than the writable file limit: ${path}`,
          "SNAPSHOT_TOO_LARGE",
        );
      }
      snapshots.push({ path: file.path, existed: true, content: file.content });
    } catch (error) {
      if (error instanceof ToolWorkspaceError && error.code === "FILE_NOT_FOUND") {
        await resolveWritablePath(workspaceRoot, path);
        snapshots.push({ path, existed: false });
        continue;
      }
      throw error;
    }
  }

  return snapshots;
}

export async function restoreWorkspaceFiles(
  workspaceRoot: string,
  snapshots: readonly WorkspaceFileSnapshot[],
): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.existed) {
      await writeWorkspaceFile(workspaceRoot, snapshot.path, snapshot.content ?? "");
      continue;
    }

    const { absolutePath } = await resolveWritablePath(workspaceRoot, snapshot.path);
    await rm(absolutePath, { force: true });
  }
}

function commandParts(command: AllowedCommand): [string, string[]] {
  const npmExecutable = process.platform === "win32" ? "npm.cmd" : "npm";
  switch (command) {
    case "npm install":
      return [npmExecutable, ["install"]];
    case "npm run typecheck":
      return [npmExecutable, ["run", "typecheck"]];
    case "npm test":
      return [npmExecutable, ["test"]];
    case "npm run build":
      return [npmExecutable, ["run", "build"]];
  }
}

export async function runWorkspaceCommand(
  workspaceRoot: string,
  command: AllowedCommand,
): Promise<ToolSuccess<{
  command: AllowedCommand;
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}>> {
  await stat(workspaceRoot);
  const [executable, args] = commandParts(command);
  const outputLimit = MAX_READ_CHARACTERS;

  try {
    const commandExecutable = process.platform === "win32" ? "cmd.exe" : executable;
    const commandArguments =
      process.platform === "win32"
        ? ["/d", "/s", "/c", [executable, ...args].join(" ")]
        : args;
    const result = await execFile(commandExecutable, commandArguments, {
      cwd: workspaceRoot,
      env: { ...process.env, NO_COLOR: "1" },
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    const stdout = truncateText(sanitizeCommandOutput(result.stdout), outputLimit);
    const stderr = truncateText(sanitizeCommandOutput(result.stderr), outputLimit);
    return {
      ok: true,
      command,
      passed: true,
      exitCode: 0,
      stdout: stdout.value,
      stderr: stderr.value,
      outputTruncated: stdout.truncated || stderr.truncated,
    };
  } catch (error) {
    const commandError = error as {
      code?: number | string;
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      signal?: string;
      message?: string;
    };
    const stdout = truncateText(
      sanitizeCommandOutput(commandError.stdout ?? ""),
      outputLimit,
    );
    const stderr = truncateText(
      sanitizeCommandOutput(
        commandError.stderr || commandError.message || "Command failed",
      ),
      outputLimit,
    );
    const numericExitCode = typeof commandError.code === "number" ? commandError.code : 1;

    return {
      ok: true,
      command,
      passed: false,
      exitCode: numericExitCode,
      stdout: stdout.value,
      stderr: stderr.value,
      outputTruncated: stdout.truncated || stderr.truncated || Boolean(commandError.killed),
    };
  }
}

export async function getWorkspaceSummary(
  workspaceRoot: string,
): Promise<ToolSuccess<WorkspaceSummary>> {
  let packageJson: Record<string, unknown> | null = null;
  try {
    const packageContent = await readWorkspaceFile(workspaceRoot, "package.json", 20_000);
    packageJson = JSON.parse(packageContent.content) as Record<string, unknown>;
  } catch {
    packageJson = null;
  }

  const files = await listWorkspaceFiles(workspaceRoot, ".", true, MAX_LIST_ENTRIES);
  return {
    ok: true,
    workspaceRoot,
    packageJson,
    files: files.entries,
    filesTruncated: files.truncated,
  };
}

export function createAgentTools(
  workspaceRootInput: string,
  options: AgentToolOptions = {},
) {
  const workspaceRoot = resolve(workspaceRootInput);
  let workspaceInspected = !options.requireInspectionBeforeWrite;
  const allowedWritePaths = options.allowedWritePaths === undefined
    ? undefined
    : new Set(options.allowedWritePaths.map(normalizeWorkspaceRelativePath));

  const emit = async (event: AgentToolEvent): Promise<void> => {
    try {
      await options.onEvent?.(event);
    } catch {
      // Observability must never interrupt a tool operation.
    }
  };

  const executeObserved = async <T extends { ok: boolean }>(
    toolName: string,
    detail: string,
    operation: () => Promise<T>,
  ): Promise<T | ToolFailure> => {
    const startedAt = Date.now();
    await emit({ type: "tool_started", tool: toolName, detail });

    let result: T | ToolFailure;
    try {
      result = await operation();
    } catch (error) {
      result = failure(error);
    }

    await emit({
      type: "tool_completed",
      tool: toolName,
      detail,
      ok: result.ok,
      durationMs: Date.now() - startedAt,
    });
    return result;
  };

  const listFiles = tool({
    name: "listFiles",
    description: "List files and directories inside the generated application workspace.",
    parameters: listFilesParameters,
    execute: async ({ relativePath, recursive, maxEntries }) => {
      const result = await executeObserved(
        "listFiles",
        `path=${relativePath} recursive=${String(recursive)} maxEntries=${maxEntries}`,
        () => listWorkspaceFiles(workspaceRoot, relativePath, recursive, maxEntries),
      );
      if (result.ok) workspaceInspected = true;
      return result;
    },
  });

  const readFile = tool({
    name: "readFile",
    description: "Read a UTF-8 text file inside the generated application workspace.",
    parameters: readFileParameters,
    execute: async ({ path, maxCharacters }) => {
      const result = await executeObserved("readFile", `path=${path}`, () =>
        readWorkspaceFile(workspaceRoot, path, maxCharacters),
      );
      if (result.ok) workspaceInspected = true;
      return result;
    },
  });

  const writeFile = tool({
    name: "writeFile",
    description: "Create or replace a UTF-8 text file inside the generated application workspace.",
    parameters: writeFileParameters,
    execute: async ({ path, content }) =>
      executeObserved(
        "writeFile",
        `path=${path} bytes=${Buffer.byteLength(content, "utf8")}`,
        () => {
          const normalizedPath = normalizeWorkspaceRelativePath(path);
          if (allowedWritePaths && !allowedWritePaths.has(normalizedPath)) {
            throw new ToolWorkspaceError(
              `Writing outside the current task file list is not allowed: ${path}`,
              "WRITE_NOT_ALLOWED",
            );
          }
          if (!workspaceInspected) {
            throw new ToolWorkspaceError(
              "Inspect the workspace with listFiles, readFile, or getProjectSummary before writing a repair.",
              "INSPECTION_REQUIRED",
            );
          }
          return writeWorkspaceFile(workspaceRoot, normalizedPath, content);
        },
      ),
  });

  const runCommand = tool({
    name: "runCommand",
    description: "Run one approved npm validation command inside the generated application workspace.",
    parameters: runCommandParameters,
    timeoutMs: COMMAND_TIMEOUT_MS + 10_000,
    execute: async ({ command }) =>
      executeObserved("runCommand", `command=${command}`, () =>
        runWorkspaceCommand(workspaceRoot, command),
      ),
  });

  const getProjectSummary = tool({
    name: "getProjectSummary",
    description: "Summarize the generated application's package metadata and file tree.",
    parameters: emptyParameters,
    execute: async () => {
      const result = await executeObserved("getProjectSummary", "workspace summary", () =>
        getWorkspaceSummary(workspaceRoot),
      );
      if (result.ok) workspaceInspected = true;
      return result;
    },
  });

  return {
    listFiles,
    readFile,
    writeFile,
    runCommand,
    getProjectSummary,
  };
}

export type AgentToolSet = ReturnType<typeof createAgentTools>;

export const toolSchemas = {
  listFiles: listFilesParameters,
  readFile: readFileParameters,
  writeFile: writeFileParameters,
  runCommand: runCommandParameters,
  getProjectSummary: emptyParameters,
};

export const toolLimits = {
  maxReadCharacters: MAX_READ_CHARACTERS,
  maxWriteCharacters: MAX_WRITE_CHARACTERS,
  maxListEntries: MAX_LIST_ENTRIES,
  commandTimeoutMs: COMMAND_TIMEOUT_MS,
};
