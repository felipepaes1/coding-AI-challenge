import "dotenv/config";

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, Runner } from "@openai/agents";
import { z } from "zod";
import { createAgentTools, type AgentToolSet } from "./tools/index.js";
import type {
  GenerationPhaseContext,
  PhaseRepairer,
  PhaseValidationResult,
} from "./orchestrator.js";

const repairInstructionsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "repair-instructions.md",
);

export const repairResultSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["fixed", "unresolved"]),
  rootCause: z.string().min(1),
  changedFiles: z.array(z.string().min(1)).max(100),
  summary: z.string().min(1),
  nextValidation: z.string().min(1),
});

export type RepairResult = z.infer<typeof repairResultSchema>;

export type RepairOptions = {
  instructions?: string;
  model?: string;
  runner?: Runner;
  maxTurns?: number;
};

export class RepairValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairValidationError";
  }
}

export async function loadRepairInstructions(): Promise<string> {
  return readFile(repairInstructionsPath, "utf8");
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.trim() !== "" &&
    !path.includes("\0") &&
    !isAbsolute(path) &&
    !posix.isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    !path.split(/[\\/]+/u).includes("..")
  );
}

export function validateRepairResult(
  input: unknown,
  expectedTaskId?: string,
): RepairResult {
  const parsedResult = repairResultSchema.safeParse(input);
  if (!parsedResult.success) {
    throw new RepairValidationError(
      `Repair output does not match the expected schema: ${parsedResult.error.message}`,
    );
  }

  if (expectedTaskId && parsedResult.data.taskId !== expectedTaskId) {
    throw new RepairValidationError(
      `Repair returned task ${parsedResult.data.taskId}; expected ${expectedTaskId}`,
    );
  }

  for (const filePath of parsedResult.data.changedFiles) {
    if (!isSafeRelativePath(filePath)) {
      throw new RepairValidationError(
        `Repair reported an unsafe changed file path: ${filePath}`,
      );
    }
  }

  return parsedResult.data;
}

function buildValidationContext(validation: PhaseValidationResult): string {
  return JSON.stringify(
    {
      passed: validation.passed,
      summary: validation.summary,
      command: validation.command,
      stdout: validation.stdout,
      stderr: validation.stderr,
      results: validation.results,
    },
    null,
    2,
  );
}

export function buildRepairInput(
  context: GenerationPhaseContext,
  validation: PhaseValidationResult,
  attempt: number,
  maxAttempts: number,
): string {
  const relevantFiles = context.relevantFiles
    .map(
      (file) =>
        `### ${file.path} (${file.exists ? "existing" : "new file"})\n\n\`\`\`text\n${file.content}\n\`\`\``,
    )
    .join("\n\n");

  return [
    "## APPLICATION_SPECIFICATION",
    context.specification.trim(),
    "",
    "## CURRENT_TASK",
    JSON.stringify(context.task, null, 2),
    "",
    "## REPAIR_ATTEMPT",
    JSON.stringify({ attempt, maxAttempts }, null, 2),
    "",
    "## VALIDATION_FAILURE",
    buildValidationContext(validation),
    "",
    "## COMPLETED_DEPENDENCIES",
    JSON.stringify(context.completedDependencies, null, 2),
    "",
    "## PROJECT_SUMMARY",
    JSON.stringify(context.projectSummary, null, 2),
    "",
    "## RELEVANT_FILES",
    relevantFiles || "No directly related files were provided.",
    "",
    "Fix only the current validation failure, then return the requested JSON summary.",
  ].join("\n");
}

export function createRepairAgent(
  workspaceRoot: string,
  instructions: string,
  model = process.env.OPENAI_MODEL,
) {
  const agentTools: AgentToolSet = createAgentTools(workspaceRoot);
  const repairTools = [
    agentTools.listFiles,
    agentTools.readFile,
    agentTools.writeFile,
    agentTools.getProjectSummary,
  ];

  return new Agent({
    name: "Validation Repair Agent",
    instructions,
    ...(model ? { model } : {}),
    outputType: repairResultSchema,
    tools: repairTools,
  });
}

export async function runRepairAgent(
  context: GenerationPhaseContext,
  validation: PhaseValidationResult,
  attempt: number,
  maxAttempts: number,
  options: RepairOptions = {},
): Promise<RepairResult> {
  const instructions = options.instructions ?? (await loadRepairInstructions());
  const repairAgent = createRepairAgent(
    context.projectSummary.workspaceRoot,
    instructions,
    options.model,
  );
  const runner = options.runner ?? new Runner();
  const result = await runner.run(
    repairAgent,
    buildRepairInput(context, validation, attempt, maxAttempts),
    { maxTurns: options.maxTurns ?? 15 },
  );

  if (result.finalOutput === undefined) {
    throw new RepairValidationError("Repair run completed without a final output");
  }

  return validateRepairResult(result.finalOutput, context.task.id);
}

export function createRepairExecutor(options: RepairOptions = {}): PhaseRepairer {
  return (context, validation, attempt, maxAttempts) =>
    runRepairAgent(context, validation, attempt, maxAttempts, options);
}
