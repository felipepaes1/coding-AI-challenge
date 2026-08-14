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

export type PhaseValidationResult = {
  passed: boolean;
  summary: string;
  command?: string;
  stdout?: string;
  stderr?: string;
};

export type PhaseResult = {
  taskId: string;
  title: string;
  status: "passed" | "failed";
  changedFiles: string[];
  summary: string;
  validation?: PhaseValidationResult;
  error?: string;
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
  | { type: "phase_failed"; taskId: string; error: string }
  | { type: "workflow_completed"; status: OrchestrationReport["status"] };

export type PhaseExecutor = (
  context: GenerationPhaseContext,
) => Promise<GenerationTaskResult>;

export type PhaseValidator = (
  context: GenerationPhaseContext,
  generationResult: GenerationTaskResult,
) => Promise<PhaseValidationResult>;

export type OrchestrationOptions = {
  plan: ImplementationPlan;
  specification: string;
  workspaceRoot: string;
  executeTask: PhaseExecutor;
  validateTask: PhaseValidator;
  onEvent?: (event: OrchestrationEvent) => void | Promise<void>;
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].slice(0, MAX_RELEVANT_FILES);
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
): Promise<GenerationPhaseContext> {
  const projectSummary = await getWorkspaceSummary(workspaceRoot);
  const dependencySummaries = completedTasks.filter((completedTask) =>
    task.dependsOn.includes(completedTask.taskId),
  );
  const dependencyFiles = dependencySummaries.flatMap(
    (completedTask) => completedTask.changedFiles,
  );
  const relatedPaths = uniquePaths([...task.files, ...dependencyFiles]);
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
  onEvent,
}: OrchestrationOptions): Promise<OrchestrationReport> {
  const phases: PhaseResult[] = [];
  const completedTasks: CompletedTaskSummary[] = [];

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
      await emit({
        type: "validation_completed",
        taskId: task.id,
        passed: validation.passed,
      });
    } catch (error) {
      validation = {
        passed: false,
        summary: formatError(error),
      };
    }

    if (!validation.passed) {
      const error = validation.summary || `Validation failed for task ${task.id}`;
      phases.push({
        taskId: task.id,
        title: task.title,
        status: "failed",
        changedFiles: generationResult.changedFiles,
        summary: generationResult.summary,
        validation,
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
      changedFiles: generationResult.changedFiles,
      summary: generationResult.summary,
      validation,
    });
    completedTasks.push({
      taskId: task.id,
      title: task.title,
      changedFiles: generationResult.changedFiles,
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
