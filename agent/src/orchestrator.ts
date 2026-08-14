import type {
  ImplementationPlan,
  ImplementationTask,
  RelevantProjectFile,
} from "./planner.js";
import {
  getWorkspaceSummary,
  readWorkspaceFile,
  restoreWorkspaceFiles,
  snapshotWorkspaceFiles,
  ToolWorkspaceError,
  type WorkspaceFileSnapshot,
  type WorkspaceSummary,
} from "./tools/index.js";
import type { ValidationResult } from "./validator.js";
import type { ReviewReport } from "./reviewer.js";

const MAX_RELEVANT_FILES = 24;
const MAX_RELEVANT_FILE_CHARACTERS = 20_000;
const DEFAULT_MAX_REPAIR_ATTEMPTS = 4;
const HARD_MAX_REPAIR_ATTEMPTS = 5;
const MAX_CONSECUTIVE_UNCHANGED_FAILURES = 2;

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
  initialValidation?: PhaseValidationResult;
  validation?: PhaseValidationResult;
  repairAttempts?: RepairAttemptReport[];
  rolledBack?: boolean;
  error?: string;
};

export type RepairAttemptReport = {
  attempt: number;
  status: RepairTaskResult["status"];
  rootCause: string;
  changedFiles: string[];
  summary: string;
  repeatedFailure?: boolean;
  validation?: PhaseValidationResult;
};

export type OrchestrationReport = {
  status: "completed" | "blocked";
  phases: PhaseResult[];
  completedTaskIds: string[];
  failedTaskId?: string;
  review?: ReviewReport;
  reviewError?: string;
};

export type FinalReviewContext = {
  specification: string;
  workspaceRoot: string;
  orchestrationReport: OrchestrationReport;
};

export type FinalReviewer = (
  context: FinalReviewContext,
) => Promise<ReviewReport>;

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
  | { type: "review_started" }
  | { type: "review_completed"; recommendation: ReviewReport["recommendation"] }
  | { type: "review_failed"; error: string }
  | { type: "phase_rolled_back"; taskId: string }
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
  previousAttempts: readonly RepairAttemptReport[],
) => Promise<RepairTaskResult>;

export type OrchestrationOptions = {
  plan: ImplementationPlan;
  specification: string;
  workspaceRoot: string;
  executeTask: PhaseExecutor;
  validateTask: PhaseValidator;
  repairTask?: PhaseRepairer;
  maxRepairAttempts?: number;
  finalReviewer?: FinalReviewer;
  onEvent?: (event: OrchestrationEvent) => void | Promise<void>;
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].slice(0, MAX_RELEVANT_FILES);
}

function validationFailureSignature(validation: PhaseValidationResult): string {
  const failedResult = validation.results?.find((result) => !result.passed);
  return [
    validation.command ?? failedResult?.command ?? "",
    validation.summary,
    validation.stderr ?? failedResult?.stderr ?? "",
    validation.stdout ?? failedResult?.stdout ?? "",
  ]
    .join("\n")
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeMaxRepairAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_MAX_REPAIR_ATTEMPTS;
  }

  return Math.min(HARD_MAX_REPAIR_ATTEMPTS, Math.max(0, Math.floor(value)));
}

function consecutiveUnchangedFailures(
  repairAttempts: readonly RepairAttemptReport[],
): number {
  let count = 0;
  for (let index = repairAttempts.length - 1; index >= 0; index -= 1) {
    if (!repairAttempts[index]?.repeatedFailure) break;
    count += 1;
  }
  return count;
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
    repairAttempts.some((repairAttempt) => repairAttempt.repeatedFailure)
      ? "The same validation failure remained after at least one repair."
      : undefined,
    consecutiveUnchangedFailures(repairAttempts) >= MAX_CONSECUTIVE_UNCHANGED_FAILURES
      ? "Repair stopped early because two consecutive attempts produced the same validation failure."
      : undefined,
    repairAttempts.length >= maxRepairAttempts
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
  finalReviewer,
  onEvent,
}: OrchestrationOptions): Promise<OrchestrationReport> {
  const phases: PhaseResult[] = [];
  const completedTasks: CompletedTaskSummary[] = [];
  const repairLimit = normalizeMaxRepairAttempts(maxRepairAttempts);

  const emit = async (event: OrchestrationEvent): Promise<void> => {
    await onEvent?.(event);
  };

  const rollbackPhase = async (
    taskId: string,
    snapshots: readonly WorkspaceFileSnapshot[],
  ): Promise<string | undefined> => {
    try {
      await restoreWorkspaceFiles(workspaceRoot, snapshots);
      await emit({ type: "phase_rolled_back", taskId });
      return undefined;
    } catch (error) {
      return `Failed to restore the pre-phase workspace state: ${formatError(error)}`;
    }
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
    let phaseSnapshots: WorkspaceFileSnapshot[];
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
      phaseSnapshots = await snapshotWorkspaceFiles(workspaceRoot, task.files);
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
      const rollbackError = await rollbackPhase(task.id, phaseSnapshots);
      const message = [formatError(error), rollbackError].filter(Boolean).join("\n");
      phases.push({
        taskId: task.id,
        title: task.title,
        status: "failed",
        changedFiles: [],
        summary: message,
        rolledBack: rollbackError === undefined,
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
      const rollbackError = await rollbackPhase(task.id, phaseSnapshots);
      const error = [
        generationResult.summary || `Task ${task.id} was blocked`,
        rollbackError,
      ].filter(Boolean).join("\n");
      phases.push({
        taskId: task.id,
        title: task.title,
        status: "failed",
        changedFiles: generationResult.changedFiles,
        summary: generationResult.summary,
        rolledBack: rollbackError === undefined,
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
          [...repairAttempts],
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

      if (repairResult.status === "fixed" && repairResult.changedFiles.length === 0) {
        repairResult = {
          ...repairResult,
          status: "unresolved",
          rootCause: `${repairResult.rootCause} No workspace file was changed.`,
          summary: "The repair reported success without changing a file, so validation was not repeated.",
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

      const previousFailureSignature = validationFailureSignature(currentValidation);
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
      repairReport.repeatedFailure = !currentValidation.passed &&
        validationFailureSignature(currentValidation) === previousFailureSignature;
      repairReport.validation = currentValidation;
      await emit({
        type: "validation_completed",
        taskId: task.id,
        passed: currentValidation.passed,
      });
      if (
        !currentValidation.passed &&
        consecutiveUnchangedFailures(repairAttempts) >= MAX_CONSECUTIVE_UNCHANGED_FAILURES
      ) {
        break;
      }
    }

    if (!currentValidation.passed) {
      const rollbackError = await rollbackPhase(task.id, phaseSnapshots);
      const error = [
        buildValidationFailureMessage(
          task.id,
          currentValidation,
          repairAttempts,
          repairLimit,
        ),
        rollbackError,
      ].filter(Boolean).join("\n");
      phases.push({
        taskId: task.id,
        title: task.title,
        status: "failed",
        changedFiles: [...changedFiles],
        summary: generationResult.summary,
        initialValidation: repairAttempts.length > 0 ? validation : undefined,
        validation: currentValidation,
        repairAttempts: repairAttempts.length > 0 ? repairAttempts : undefined,
        rolledBack: rollbackError === undefined,
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
      initialValidation: repairAttempts.length > 0 ? validation : undefined,
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

  const completedReport: OrchestrationReport = {
    status: "completed",
    phases,
    completedTaskIds: completedTasks.map((completedTask) => completedTask.taskId),
  };

  if (!finalReviewer) {
    await emit({ type: "workflow_completed", status: "completed" });
    return completedReport;
  }

  await emit({ type: "review_started" });
  try {
    const review = await finalReviewer({
      specification,
      workspaceRoot,
      orchestrationReport: completedReport,
    });
    await emit({
      type: "review_completed",
      recommendation: review.recommendation,
    });
    await emit({ type: "workflow_completed", status: "completed" });
    return {
      ...completedReport,
      review,
    };
  } catch (error) {
    const reviewError = `Final review failed: ${formatError(error)}`;
    await emit({ type: "review_failed", error: reviewError });
    await emit({ type: "workflow_completed", status: "blocked" });
    return {
      ...completedReport,
      status: "blocked",
      reviewError,
    };
  }
}
