import { cp, lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const agentDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const projectRoot = resolve(agentDirectory, "..");

const protectedTopLevelDirectories = new Set([
  ".git",
  "agent",
  "dist",
  "node_modules",
  "public",
  "src",
]);

const ignoredTopLevelEntries = new Set([
  ".git",
  ".next",
  ".openai",
  ".turbo",
  ".vite",
  "agent",
  "coverage",
  "dist",
  "generated-app",
  "node_modules",
  "tmp",
]);

const ignoredFiles = new Set([".env", "AGENTS.md", "tsconfig.tsbuildinfo"]);

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export type LoadedSpecification = {
  path: string;
  content: string;
};

function isWithinDirectory(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath !== "" &&
    !relativePath.startsWith(`..${sep}`) &&
    relativePath !== ".." &&
    !isAbsolute(relativePath)
  );
}

export function createRunId(now = new Date()): string {
  const timestamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export async function loadSpecification(inputPath: string): Promise<LoadedSpecification> {
  const specificationPath = resolve(projectRoot, inputPath);

  let fileStats;
  try {
    fileStats = await stat(specificationPath);
  } catch {
    throw new WorkspaceError(`Specification file not found: ${specificationPath}`);
  }

  if (!fileStats.isFile()) {
    throw new WorkspaceError(`Specification path is not a file: ${specificationPath}`);
  }

  const content = await readFile(specificationPath, "utf8");
  if (content.trim().length === 0) {
    throw new WorkspaceError(`Specification file is empty: ${specificationPath}`);
  }

  return { path: specificationPath, content };
}

export function resolveOutputPath(inputPath: string): string {
  const outputPath = resolve(projectRoot, inputPath);

  if (!isWithinDirectory(projectRoot, outputPath)) {
    throw new WorkspaceError(
      `Output directory must be a child of the project root: ${projectRoot}`,
    );
  }

  const relativeOutputPath = relative(projectRoot, outputPath);
  const topLevelEntry = relativeOutputPath.split(sep)[0];

  if (topLevelEntry && protectedTopLevelDirectories.has(topLevelEntry)) {
    throw new WorkspaceError(
      `Refusing to use a protected project directory as output: ${outputPath}`,
    );
  }

  return outputPath;
}

async function copyProjectEntry(
  sourcePath: string,
  destinationPath: string,
  outputRelativePath: string,
): Promise<void> {
  const relativeSourcePath = relative(projectRoot, sourcePath);

  if (
    relativeSourcePath === "" ||
    relativeSourcePath === outputRelativePath ||
    relativeSourcePath.startsWith(`${outputRelativePath}${sep}`)
  ) {
    return;
  }

  const topLevelEntry = relativeSourcePath.split(sep)[0];
  if (ignoredFiles.has(relativeSourcePath)) {
    return;
  }

  if (topLevelEntry && ignoredTopLevelEntries.has(topLevelEntry)) {
    return;
  }

  const sourceStats = await lstat(sourcePath);
  if (sourceStats.isDirectory()) {
    await mkdir(destinationPath, { recursive: true });
    const children = await readdir(sourcePath);
    await Promise.all(
      children.map((child) =>
        copyProjectEntry(
          resolve(sourcePath, child),
          resolve(destinationPath, child),
          outputRelativePath,
        ),
      ),
    );
    return;
  }

  await mkdir(dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath);
}

export async function prepareOutputWorkspace(inputPath: string): Promise<string> {
  const outputPath = resolveOutputPath(inputPath);
  const relativeOutputPath = relative(projectRoot, outputPath);

  await rm(outputPath, { recursive: true, force: true });
  await mkdir(outputPath, { recursive: true });

  const entries = await readdir(projectRoot);
  await Promise.all(
    entries.map((entry) =>
      copyProjectEntry(
        resolve(projectRoot, entry),
        resolve(outputPath, entry),
        relativeOutputPath,
      ),
    ),
  );

  return outputPath;
}
