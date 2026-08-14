import type {
  ImplementationPlan,
  ImplementationTask,
  RelevantProjectFile,
} from "./planner.js";
import {
  getWorkspaceSummary,
  readWorkspaceFile,
  ToolWorkspaceError,
  type WorkspaceSummary,
} from "./tools/index.js";
import type { ValidationResult } from "./validator.js";

const MAX_RELEVANT_FILES = 24;
const MAX_RELEVANT_FILE_CHARACTERS = 20_000;

export type CompletedTaskSummary = {
  taskId: string;
  title: string;
  changedFiles: string[];
  summary: string;
};

export type RelatedFileContext = RelevantProjectFile & {
  exists: boolean;
  truncated: boolean;
};

export type GenerationPhaseContext = {
  specification: string;
  task: ImplementationTask;
  projectSummary: WorkspaceSummary;
  completedDependencies: CompletedTaskSummary[];
  relevantFiles: RelatedFileContext[];
};

export type GenerationTaskResult = {
  taskId: string;
  status: "completed" | "blocked";
  changedFiles: string[];
  summary: string;
  assumptions?: string[];
};

export type RepairTaskResult = {
  taskId: string;
  status: "fixed" | "unresolved";
  rootCause: string;
  changedFiles: string[];
  summary: string;
  nextValidation: string;
};

export type PhaseValidationResult = {
  passed: boolean;
  summary: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  results?: ValidationResult[];
};

export type PhaseResult = {
  taskId: string;
  title: string;
  status: "passed" | "failed";
  changedFiles: string[];
  summary: string;
  validation?: PhaseValidationResult;
  repairAttempts?: RepairAttemptReport[];
  error?: string;
};

export type RepairAttemptReport = {
  attempt: number;
  status: RepairTaskResult["status"];
  rootCause: string;
  changedFiles: string[];
  summary: string;
  validation?: PhaseValidationResult;
};

export type OrchestrationReport = {
  status: "completed" | "blocked";
  phases: PhaseResult[];
  completedTaskIds: string[];
  failedTaskId?: string;
};

export type OrchestrationEvent =
  | { type: "phase_started"; taskId: string; index: number; total: number }
  | { type: "context_loaded"; taskId: string; relevantFileCount: number }
  | { type: "generation_completed"; taskId: string; changedFileCount: number }
  | { type: "validation_completed"; taskId: string; passed: boolean }
  | { type: "repair_started"; taskId: string; attempt: number; maxAttempts: number }
  | {
      type: "repair_completed";
      taskId: string;
      attempt: number;
      status: RepairTaskResult["status"];
    }
  | { type: "phase_failed"; taskId: string; error: string }
  | { type: "workflow_completed"; status: OrchestrationReport["status"] };

export type PhaseExecutor = (
  context: GenerationPhaseContext,
) => Promise<GenerationTaskResult>;

export type PhaseValidator = (
  context: GenerationPhaseContext,
  generationResult: GenerationTaskResult,
) => Promise<PhaseValidationResult>;

export type PhaseRepairer = (
  context: GenerationPhaseContext,
  validation: PhaseValidationResult,
  attempt: number,
  maxAttempts: number,
) => Promise<RepairTaskResult>;

export type OrchestrationOptions = {
  plan: ImplementationPlan;
  specification: string;
  workspaceRoot: string;
  executeTask: PhaseExecutor;
  validateTask: PhaseValidator;
  repairTask?: PhaseRepairer;
  maxRepairAttempts?: number;
  onEvent?: (event: OrchestrationEvent) => void | Promise<void>;
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].slice(0, MAX_RELEVANT_FILES);
}

function normalizeMaxRepairAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 2;
  }

  return Math.min(2, Math.max(0, Math.floor(value)));
}

function buildValidationFailureMessage(
  taskId: string,
  validation: PhaseValidationResult,
  repairAttempts: RepairAttemptReport[],
  maxRepairAttempts: number,
): string {
  const details = [
    `Validation failed for task ${taskId}.`,
    validation.command ? `Command: ${validation.command}` : undefined,
    validation.stdout ? `stdout:\n${validation.stdout}` : undefined,
    validation.stderr ? `stderr:\n${validation.stderr}` : undefined,
    repairAttempts.length > 0
      ? `Repair attempts: ${repairAttempts.length}/${maxRepairAttempts}.`
      : "No repair attempt was executed.",
    repairAttempts.at(-1)?.rootCause
      ? `Last repair diagnosis: ${repairAttempts.at(-1)?.rootCause}`
      : undefined,
    repairAttempts.length >= 2
      ? "The maximum number of repair attempts for this phase was reached."
      : undefined,
  ];

  return [...details, validation.summary].filter(Boolean).join("\n");
}

async function readRelatedFile(
  workspaceRoot: string,
  path: string,
): Promise<RelatedFileContext> {
  try {
    const result = await readWorkspaceFile(
      workspaceRoot,
      path,
      MAX_RELEVANT_FILE_CHARACTERS,
    );
    return {
      path: result.path,
      content: result.content,
      exists: true,
      truncated: result.truncated,
    };
  } catch (error) {
    if (error instanceof ToolWorkspaceError && error.code === "FILE_NOT_FOUND") {
      return {
        path,
        content: "[File does not exist yet]",
        exists: false,
        truncated: false,
      };
    }

    throw error;
  }
}

export async function collectPhaseContext(
  workspaceRoot: string,
  specification: string,
  task: ImplementationTask,
  completedTasks: CompletedTaskSummary[],
  additionalRelatedFiles: string[] = [],
): Promise<GenerationPhaseContext> {
  const projectSummary = await getWorkspaceSummary(workspaceRoot);
  const dependencySummaries = completedTasks.filter((completedTask) =>
    task.dependsOn.includes(completedTask.taskId),
  );
  const dependencyFiles = dependencySummaries.flatMap(
    (completedTask) => completedTask.changedFiles,
  );
  const relatedPaths = uniquePaths([
    ...task.files,
    ...dependencyFiles,
    ...additionalRelatedFiles,
  ]);
  const relevantFiles = await Promise.all(
    relatedPaths.map((path) => readRelatedFile(workspaceRoot, path)),
  );

  return {
    specification,
    task,
    projectSummary,
    completedDependencies: dependencySummaries,
    relevantFiles,
  };
}

export async function runGenerationPhases({
  plan,
  specification,
  workspaceRoot,
  executeTask,
  validateTask,
  repairTask,
  maxRepairAttempts,
  onEvent,
}: OrchestrationOptions): Promise<OrchestrationReport> {
  const phases: PhaseResult[] = [];
  const completedTasks: CompletedTaskSummary[] = [];
  const repairLimit = normalizeMaxRepairAttempts(maxRepairAttempts);

  const emit = async (event: OrchestrationEvent): Promise<void> => {
    await onEvent?.(event);
  };

  for (const [index, task] of plan.tasks.entries()) {
    await emit({
      type: "phase_started",
      taskId: task.id,
      index: index + 1,
      total: plan.tasks.length,
    });

    const missingDependencies = task.dependsOn.filter(
      (dependencyId) => !completedTasks.some((taskResult) => taskResult.taskId === dependencyId),
    );
    if (missingDependencies.length > 0) {
      const error = `Cannot start ${task.id}; dependencies are not completed: ${missingDependencies.join(", ")}`;
      phases.push({
        taskId: task.id,
        title: task.title,
        status: "failed",
        changedFiles: [],
        summary: error,
        error,
      });
      await emit({ type: "phase_failed", taskId: task.id, error });
      await emit({ type: "workflow_completed", status: "blocked" });
      return {
        status: "blocked",
        phases,
        completedTaskIds: completedTasks.map((completedTask) => completedTask.taskId),
        failedTaskId: task.id,
      };
    }

    let context: GenerationPhaseContext;
    try {
      context = await collectPhaseContext(
        workspaceRoot,
        specification,
        task,
        completedTasks,
      );
      await emit({
        type: "context_loaded",
        taskId: task.id,
        relevantFileCount: context.relevantFiles.length,
      });
    } catch (error) {
      const message = formatError(error);
      phases.push({
        taskId: task.id,
        title: task.title,
        status: "failed",
        changedFiles: [],
        summary: message,
        error: message,
      });
      await emit({ type: "phase_failed", taskId: task.id, error: message });
      await emit({ type: "workflow_completed", status: "blocked" });
      return {
        status: "blocked",
        phases,
        completedTaskIds: completedTasks.map((completedTask) => completedTask.taskId),
        failedTaskId: task.id,
      };
    }

    let generationResult: GenerationTaskResult;
    try {
      generationResult = await executeTask(context);
      await emit({
        type: "generation_completed",
        taskId: task.id,
        changedFileCount: generationResult.changedFiles.length,
      });
    } catch (error) {
      const message = formatError(error);
      phases.push({
        taskId: task.id,
        title: task.title,
        status: "failed",
        changedFiles: [],
        summary: message,
        error: message,
      });
      await emit({ type: "phase_failed", taskId: task.id, error: message });
      await emit({ type: "workflow_completed", status: "blocked" });
      return {
        status: "blocked",
        phases,
        completedTaskIds: completedTasks.map((completedTask) => completedTask.taskId),
        failedTaskId: task.id,
      };
    }

    if (generationResult.status !== "completed") {
      const error = generationResult.summary || `Task ${task.id} was blocked`;
      phases.push({
        taskId: task.id,
        title: task.title,
        status: "failed",
        changedFiles: generationResult.changedFiles,
        summary: generationResult.summary,
        error,
      });
      await emit({ type: "phase_failed", taskId: task.id, error });
      await emit({ type: "workflow_completed", status: "blocked" });
      return {
        status: "blocked",
        phases,
        completedTaskIds: completedTasks.map((completedTask) => completedTask.taskId),
        failedTaskId: task.id,
      };
    }

    let validation: PhaseValidationResult;
    try {
      validation = await validateTask(context, generationResult);
    } catch (error) {
      validation = {
        passed: false,
        summary: formatError(error),
      };
    }
    await emit({
      type: "validation_completed",
      taskId: task.id,
      passed: validation.passed,
    });

    const changedFiles = new Set(generationResult.changedFiles);
    const repairAttempts: RepairAttemptReport[] = [];
    let currentContext = context;
    let currentValidation = validation;

    for (
      let attempt = 1;
      !currentValidation.passed && repairTask && attempt <= repairLimit;
      attempt += 1
    ) {
      await emit({
        type: "repair_started",
        taskId: task.id,
        attempt,
        maxAttempts: repairLimit,
      });

      let repairResult: RepairTaskResult;
      try {
        currentContext = await collectPhaseContext(
          workspaceRoot,
          specification,
          task,
          completedTasks,
          [...changedFiles],
        );
        repairResult = await repairTask(
          currentContext,
          currentValidation,
          attempt,
          repairLimit,
        );
        if (repairResult.taskId !== task.id) {
          throw new Error(
            `Repair returned task ${repairResult.taskId}; expected ${task.id}`,
          );
        }
      } catch (error) {
        repairResult = {
          taskId: task.id,
          status: "unresolved",
          rootCause: `Repair agent failed: ${formatError(error)}`,
          changedFiles: [],
          summary: "The repair agent could not complete this attempt.",
          nextValidation: currentValidation.command ?? "the failed validation command",
        };
      }

      for (const filePath of repairResult.changedFiles) {
        changedFiles.add(filePath);
      }

      const repairReport: RepairAttemptReport = {
        attempt,
        status: repairResult.status,
        rootCause: repairResult.rootCause,
        changedFiles: repairResult.changedFiles,
        summary: repairResult.summary,
      };
      repairAttempts.push(repairReport);
      await emit({
        type: "repair_completed",
        taskId: task.id,
        attempt,
        status: repairResult.status,
      });

      if (repairResult.status !== "fixed") {
        break;
      }

      try {
        currentContext = await collectPhaseContext(
          workspaceRoot,
          specification,
          task,
          completedTasks,
          [...changedFiles],
        );
        currentValidation = await validateTask(currentContext, {
          ...generationResult,
          changedFiles: [...changedFiles],
        });
      } catch (error) {
        currentValidation = {
          passed: false,
          summary: formatError(error),
        };
      }
      repairReport.validation = currentValidation;
      await emit({
        type: "validation_completed",
        taskId: task.id,
        passed: currentValidation.passed,
      });
    }

    if (!currentValidation.passed) {
      const error = buildValidationFailureMessage(
        task.id,
        currentValidation,
        repairAttempts,
        repairLimit,
      );
      phases.push({
        taskId: task.id,
        title: task.title,
        status: "failed",
        changedFiles: [...changedFiles],
        summary: generationResult.summary,
        validation: currentValidation,
        repairAttempts: repairAttempts.length > 0 ? repairAttempts : undefined,
        error,
      });
      await emit({ type: "phase_failed", taskId: task.id, error });
      await emit({ type: "workflow_completed", status: "blocked" });
      return {
        status: "blocked",
        phases,
        completedTaskIds: completedTasks.map((completedTask) => completedTask.taskId),
        failedTaskId: task.id,
      };
    }

    phases.push({
      taskId: task.id,
      title: task.title,
      status: "passed",
      changedFiles: [...changedFiles],
      summary: generationResult.summary,
      validation: currentValidation,
      repairAttempts: repairAttempts.length > 0 ? repairAttempts : undefined,
    });
    completedTasks.push({
      taskId: task.id,
      title: task.title,
      changedFiles: [...changedFiles],
      summary: generationResult.summary,
    });
  }

  await emit({ type: "workflow_completed", status: "completed" });
  return {
    status: "completed",
    phases,
    completedTaskIds: completedTasks.map((completedTask) => completedTask.taskId),
  };
}
