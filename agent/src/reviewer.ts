import "dotenv/config";

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, Runner } from "@openai/agents";
import { z } from "zod";
import type {
  FinalReviewContext,
  OrchestrationReport,
} from "./orchestrator.js";
import {
  getWorkspaceSummary,
  listWorkspaceFiles,
  readWorkspaceFile,
  type WorkspaceSummary,
} from "./tools/index.js";
import { createAgentTools, type AgentToolSet } from "./tools/index.js";

const reviewerInstructionsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "reviewer-instructions.md",
);

const requirementReviewSchema = z.object({
  requirement: z.string().min(1),
  status: z.enum(["passed", "partial", "failed"]),
  evidence: z.string().min(1),
});

export const reviewReportSchema = z.object({
  requirements: z.array(requirementReviewSchema).max(100),
  warnings: z.array(z.string().min(1)).max(100),
  recommendation: z.enum(["ready", "needs_changes"]),
});

export type ReviewReport = z.infer<typeof reviewReportSchema>;

export type ReviewFile = {
  path: string;
  content: string;
  exists: boolean;
  truncated: boolean;
};

export type ReviewerContext = {
  specification: string;
  projectSummary: WorkspaceSummary;
  orchestrationReport: OrchestrationReport;
  relevantFiles: ReviewFile[];
};

export type ReviewerOptions = {
  instructions?: string;
  model?: string;
  runner?: Runner;
  maxTurns?: number;
  relevantFilePaths?: string[];
};

export class ReviewerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewerValidationError";
  }
}

export async function loadReviewerInstructions(): Promise<string> {
  return readFile(reviewerInstructionsPath, "utf8");
}

export function validateReviewReport(input: unknown): ReviewReport {
  const parsedReport = reviewReportSchema.safeParse(input);
  if (!parsedReport.success) {
    throw new ReviewerValidationError(
      `Reviewer output does not match the expected schema: ${parsedReport.error.message}`,
    );
  }

  return parsedReport.data;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim() !== ""))].slice(0, 32);
}

function isReviewCandidate(path: string): boolean {
  return (
    path === "package.json" ||
    path === "README.md" ||
    /(^|\/)(tests?|__tests__)(\/|$)/u.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/u.test(path)
  );
}

async function readReviewFile(
  workspaceRoot: string,
  path: string,
): Promise<ReviewFile> {
  try {
    const result = await readWorkspaceFile(workspaceRoot, path, 20_000);
    return {
      path: result.path,
      content: result.content,
      exists: true,
      truncated: result.truncated,
    };
  } catch {
    return {
      path,
      content: "[File does not exist]",
      exists: false,
      truncated: false,
    };
  }
}

export async function collectReviewerContext(
  context: FinalReviewContext,
  relevantFilePaths: string[] = [],
): Promise<ReviewerContext> {
  if (context.orchestrationReport.status !== "completed") {
    throw new ReviewerValidationError(
      "The final reviewer can run only after all generation phases pass",
    );
  }

  const projectSummary = await getWorkspaceSummary(context.workspaceRoot);
  const listedFiles = await listWorkspaceFiles(
    context.workspaceRoot,
    ".",
    true,
    500,
  );
  const changedFiles = context.orchestrationReport.phases.flatMap(
    (phase) => phase.changedFiles,
  );
  const candidateFiles = listedFiles.entries
    .filter((entry) => entry.type === "file" && isReviewCandidate(entry.path))
    .map((entry) => entry.path);
  const paths = uniquePaths([
    "package.json",
    ...changedFiles,
    ...candidateFiles,
    ...relevantFilePaths,
  ]);
  const relevantFiles = await Promise.all(
    paths.map((path) => readReviewFile(context.workspaceRoot, path)),
  );

  return {
    specification: context.specification,
    projectSummary,
    orchestrationReport: context.orchestrationReport,
    relevantFiles,
  };
}

export function buildReviewerInput(context: ReviewerContext): string {
  const relevantFiles = context.relevantFiles
    .map(
      (file) =>
        `### ${file.path} (${file.exists ? "existing" : "missing"})\n\n\`\`\`text\n${file.content}\n\`\`\``,
    )
    .join("\n\n");

  return [
    "## APPLICATION_SPECIFICATION",
    context.specification.trim(),
    "",
    "## ORCHESTRATION_REPORT",
    JSON.stringify(context.orchestrationReport, null, 2),
    "",
    "## BOILERPLATE_WORKSPACE",
    JSON.stringify(context.projectSummary, null, 2),
    "",
    "## RELEVANT_FILES",
    relevantFiles || "No relevant files were provided.",
    "",
    "Review the completed application against every requirement. Inspect more files with the read-only tools when evidence is missing, then return only the requested JSON report.",
  ].join("\n");
}

export function createReviewerAgent(
  workspaceRoot: string,
  instructions: string,
  model = process.env.OPENAI_MODEL,
) {
  const agentTools: AgentToolSet = createAgentTools(workspaceRoot);
  const reviewerTools = [
    agentTools.listFiles,
    agentTools.readFile,
    agentTools.getProjectSummary,
  ];

  return new Agent({
    name: "Final Requirements Reviewer",
    instructions,
    ...(model ? { model } : {}),
    outputType: reviewReportSchema,
    tools: reviewerTools,
  });
}

export async function runReviewer(
  context: FinalReviewContext,
  options: ReviewerOptions = {},
): Promise<ReviewReport> {
  const reviewerContext = await collectReviewerContext(
    context,
    options.relevantFilePaths,
  );
  const instructions = options.instructions ?? (await loadReviewerInstructions());
  const reviewer = createReviewerAgent(
    context.workspaceRoot,
    instructions,
    options.model,
  );
  const runner = options.runner ?? new Runner();
  const result = await runner.run(reviewer, buildReviewerInput(reviewerContext), {
    maxTurns: options.maxTurns ?? 10,
  });

  if (result.finalOutput === undefined) {
    throw new ReviewerValidationError("Reviewer run completed without a final output");
  }

  return validateReviewReport(result.finalOutput);
}

export function createFinalReviewer(options: ReviewerOptions = {}) {
  return (context: FinalReviewContext): Promise<ReviewReport> =>
    runReviewer(context, options);
}
