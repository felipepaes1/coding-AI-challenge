import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, resolve, win32 } from "node:path";
import { Agent, Runner } from "@openai/agents";
import { z } from "zod";
import { fileURLToPath } from "node:url";

const plannerInstructionsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "prompts",
  "planner-instructions.md",
);

const taskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  files: z.array(z.string().min(1)).max(50),
  dependsOn: z.array(z.string().min(1)).max(50),
  validation: z.array(z.string().min(1)).max(20),
});

export const implementationPlanSchema = z.object({
  summary: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  tasks: z.array(taskSchema).min(1).max(50),
  acceptanceCriteria: z.array(z.string().min(1)).min(1).max(50),
});

export type ImplementationPlan = z.infer<typeof implementationPlanSchema>;
export type ImplementationTask = ImplementationPlan["tasks"][number];

export type RelevantProjectFile = {
  path: string;
  content: string;
};

export type PlannerRequest = {
  specification: string;
  projectContext: string;
  relevantFiles: RelevantProjectFile[];
};

export type PlannerOptions = {
  instructions?: string;
  model?: string;
  runner?: Runner;
  maxTurns?: number;
};

export class PlannerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerValidationError";
  }
}

export async function loadPlannerInstructions(): Promise<string> {
  return readFile(plannerInstructionsPath, "utf8");
}

function isSafeRelativePlanPath(path: string): boolean {
  return (
    path.trim() !== "" &&
    !path.includes("\0") &&
    !isAbsolute(path) &&
    !posix.isAbsolute(path) &&
    !win32.isAbsolute(path) &&
    !path.split(/[\\/]+/u).includes("..")
  );
}

function validateTaskDependencies(tasks: ImplementationTask[]): void {
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) {
      throw new PlannerValidationError(`Duplicate task ID: ${task.id}`);
    }
    taskIds.add(task.id);

    for (const filePath of task.files) {
      if (!isSafeRelativePlanPath(filePath)) {
        throw new PlannerValidationError(
          `Task ${task.id} contains an unsafe file path: ${filePath}`,
        );
      }
    }

    for (const dependencyId of task.dependsOn) {
      if (dependencyId === task.id) {
        throw new PlannerValidationError(`Task ${task.id} cannot depend on itself`);
      }
      if (!tasks.some((candidate) => candidate.id === dependencyId)) {
        throw new PlannerValidationError(
          `Task ${task.id} depends on an unknown task: ${dependencyId}`,
        );
      }
    }
  }

  const dependencies = new Map(
    tasks.map((task) => [task.id, task.dependsOn]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(taskId: string): void {
    if (visiting.has(taskId)) {
      throw new PlannerValidationError(`Circular task dependency detected at: ${taskId}`);
    }
    if (visited.has(taskId)) {
      return;
    }

    visiting.add(taskId);
    for (const dependencyId of dependencies.get(taskId) ?? []) {
      visit(dependencyId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const task of tasks) {
    visit(task.id);
  }

  const taskIndexes = new Map(tasks.map((task, index) => [task.id, index]));
  for (const [taskIndex, task] of tasks.entries()) {
    for (const dependencyId of task.dependsOn) {
      const dependencyIndex = taskIndexes.get(dependencyId);
      if (dependencyIndex !== undefined && dependencyIndex >= taskIndex) {
        throw new PlannerValidationError(
          `Task ${task.id} must appear after its dependency: ${dependencyId}`,
        );
      }
    }
  }
}

export function validateImplementationPlan(input: unknown): ImplementationPlan {
  const parsedPlan = implementationPlanSchema.safeParse(input);
  if (!parsedPlan.success) {
    throw new PlannerValidationError(
      `Planner output does not match the implementation plan schema: ${parsedPlan.error.message}`,
    );
  }

  validateTaskDependencies(parsedPlan.data.tasks);
  return parsedPlan.data;
}

export function buildPlannerInput(request: PlannerRequest): string {
  const relevantFiles = request.relevantFiles
    .map(
      (file) =>
        `### ${file.path}\n\n\`\`\`text\n${file.content}\n\`\`\``,
    )
    .join("\n\n");

  return [
    "## APPLICATION_SPECIFICATION",
    request.specification.trim(),
    "",
    "## PROJECT_CONTEXT",
    request.projectContext.trim(),
    "",
    "## RELEVANT_FILES",
    relevantFiles || "No relevant files were provided.",
    "",
    "Create the implementation plan now. Return only the requested JSON object.",
  ].join("\n");
}

export function createPlannerAgent(
  instructions: string,
  model = process.env.OPENAI_MODEL,
) {
  return new Agent({
    name: "Implementation Planner",
    instructions,
    ...(model ? { model } : {}),
    outputType: implementationPlanSchema,
    tools: [],
  });
}

export async function runPlanner(
  request: PlannerRequest,
  options: PlannerOptions = {},
): Promise<ImplementationPlan> {
  const instructions = options.instructions ?? (await loadPlannerInstructions());
  const planner = createPlannerAgent(instructions, options.model);
  const runner = options.runner ?? new Runner();
  const result = await runner.run(planner, buildPlannerInput(request), {
    maxTurns: options.maxTurns ?? 1,
  });

  if (result.finalOutput === undefined) {
    throw new PlannerValidationError("Planner run completed without a final output");
  }

  return validateImplementationPlan(result.finalOutput);
}
