import "dotenv/config";

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, Runner } from "@openai/agents";
import { z } from "zod";
import {
  createAgentTools,
  type AgentToolSet,
} from "./tools/index.js";
import type {
  GenerationPhaseContext,
  PhaseExecutor,
} from "./orchestrator.js";

const generatorInstructionsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "generator-instructions.md",
);

export const generationResultSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["completed", "blocked"]),
  changedFiles: z.array(z.string().min(1)).max(100),
  summary: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  validationNotes: z.array(z.string()).default([]),
});

export type GenerationResult = z.infer<typeof generationResultSchema>;

export type GeneratorOptions = {
  instructions?: string;
  model?: string;
  runner?: Runner;
  maxTurns?: number;
};

export class GeneratorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeneratorValidationError";
  }
}

export async function loadGeneratorInstructions(): Promise<string> {
  return readFile(generatorInstructionsPath, "utf8");
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

export function validateGenerationResult(
  input: unknown,
  expectedTaskId?: string,
): GenerationResult {
  const parsedResult = generationResultSchema.safeParse(input);
  if (!parsedResult.success) {
    throw new GeneratorValidationError(
      `Generator output does not match the expected schema: ${parsedResult.error.message}`,
    );
  }

  if (expectedTaskId && parsedResult.data.taskId !== expectedTaskId) {
    throw new GeneratorValidationError(
      `Generator returned task ${parsedResult.data.taskId}; expected ${expectedTaskId}`,
    );
  }

  for (const filePath of parsedResult.data.changedFiles) {
    if (!isSafeRelativePath(filePath)) {
      throw new GeneratorValidationError(
        `Generator reported an unsafe changed file path: ${filePath}`,
      );
    }
  }

  return parsedResult.data;
}

function buildGeneratorInput(context: GenerationPhaseContext): string {
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
    "## COMPLETED_DEPENDENCIES",
    JSON.stringify(context.completedDependencies, null, 2),
    "",
    "## PROJECT_SUMMARY",
    JSON.stringify(context.projectSummary, null, 2),
    "",
    "## RELEVANT_FILES",
    relevantFiles || "No directly related files were provided.",
    "",
    "Implement only the current task. Use the available tools to inspect and modify files, then return the requested JSON summary.",
  ].join("\n");
}

export function createGeneratorAgent(
  workspaceRoot: string,
  instructions: string,
  model = process.env.OPENAI_MODEL,
) {
  const agentTools: AgentToolSet = createAgentTools(workspaceRoot);

  return new Agent({
    name: "Phase Code Generator",
    instructions,
    ...(model ? { model } : {}),
    outputType: generationResultSchema,
    tools: Object.values(agentTools),
  });
}

export async function runGenerator(
  context: GenerationPhaseContext,
  options: GeneratorOptions = {},
): Promise<GenerationResult> {
  const instructions = options.instructions ?? (await loadGeneratorInstructions());
  const generator = createGeneratorAgent(context.projectSummary.workspaceRoot, instructions, options.model);
  const runner = options.runner ?? new Runner();
  const result = await runner.run(generator, buildGeneratorInput(context), {
    maxTurns: options.maxTurns ?? 20,
  });

  if (result.finalOutput === undefined) {
    throw new GeneratorValidationError("Generator run completed without a final output");
  }

  return validateGenerationResult(result.finalOutput, context.task.id);
}

export function createGeneratorExecutor(
  options: GeneratorOptions = {},
): PhaseExecutor {
  return (context) => runGenerator(context, options);
}

export { buildGeneratorInput };
