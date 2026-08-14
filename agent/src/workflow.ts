import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Runner } from "@openai/agents";
import { createGeneratorExecutor } from "./generator.js";
import {
  runGenerationPhases,
  type OrchestrationEvent,
  type OrchestrationReport,
} from "./orchestrator.js";
import {
  runPlanner,
  type ImplementationPlan,
  type RelevantProjectFile,
} from "./planner.js";
import { createRepairExecutor } from "./repair.js";
import { createFinalReviewer } from "./reviewer.js";
import {
  getWorkspaceSummary,
  readWorkspaceFile,
  runWorkspaceCommand,
  type AgentToolEvent,
  type WorkspaceSummary,
} from "./tools/index.js";
import {
  createPhaseValidator,
  runValidationPipeline,
  validationCommandsForStage,
  type CommandExecutor,
  type ValidationReport,
  type ValidationResult,
  type ValidationStage,
} from "./validator.js";
import { formatDuration, type ProgressListener } from "./progress.js";
import { projectRoot } from "./workspace.js";

const MAX_PLANNING_FILES = 24;
const MAX_PLANNING_FILE_CHARACTERS = 12_000;

export type RunReport = {
  runId: string;
  startedAt: string;
  completedAt: string;
  workspaceRoot: string;
  model: string | null;
  traceId?: string;
  eventsPath?: string;
  setupValidation: ValidationReport;
  orchestration: OrchestrationReport;
};

export type WorkflowResult = {
  plan: ImplementationPlan;
  report: RunReport;
  planPath: string;
  reportPath: string;
};

export type WorkflowDependencies = {
  planner?: typeof runPlanner;
  orchestrator?: typeof runGenerationPhases;
  commandExecutor?: CommandExecutor;
  runner?: Runner;
};

export type AgentWorkflowOptions = {
  runId: string;
  specification: string;
  workspaceRoot: string;
  model?: string;
  artifactsRoot?: string;
  traceId?: string;
  eventsPath?: string;
  onProgress?: ProgressListener;
  dependencies?: WorkflowDependencies;
};

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

function isTextProjectFile(path: string): boolean {
  if (
    path === "public/mockServiceWorker.js" ||
    /(^|\/)(package-lock|npm-shrinkwrap|yarn\.lock|pnpm-lock)\./u.test(path)
  ) {
    return false;
  }

  return (
    /(^|\/)(package|tsconfig[^/]*|vite\.config[^/]*)\.(json|[cm]?[jt]s)$/u.test(path) ||
    /\.(md|json|[cm]?[jt]sx?|css|scss|html|graphql|gql)$/u.test(path)
  );
}

function planningFilePriority(path: string): number {
  if (path === "package.json") return 0;
  if (/^(tsconfig|vite\.config)/u.test(path)) return 1;
  if (/^src\/(main|App)\.[cm]?[jt]sx?$/u.test(path)) return 2;
  if (path.startsWith("src/") && !/\.(test|spec)\./u.test(path)) return 3;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/u.test(path)) return 4;
  return 5;
}

export async function collectPlanningFiles(
  workspaceRoot: string,
  summary: WorkspaceSummary,
): Promise<RelevantProjectFile[]> {
  const candidatePaths = summary.files
    .filter((entry) => entry.type === "file" && isTextProjectFile(entry.path))
    .map((entry) => entry.path)
    .sort((left, right) => {
      const priorityDifference = planningFilePriority(left) - planningFilePriority(right);
      return priorityDifference || left.localeCompare(right);
    })
    .slice(0, MAX_PLANNING_FILES);

  const files = await Promise.all(
    candidatePaths.map(async (path) => {
      try {
        const file = await readWorkspaceFile(
          workspaceRoot,
          path,
          MAX_PLANNING_FILE_CHARACTERS,
        );
        return { path: file.path, content: file.content };
      } catch {
        return undefined;
      }
    }),
  );

  return files.filter((file): file is RelevantProjectFile => file !== undefined);
}

export function validationStageForTask(
  plan: ImplementationPlan,
  taskId: string,
): ValidationStage {
  const taskIndex = plan.tasks.findIndex((task) => task.id === taskId);
  if (taskIndex === plan.tasks.length - 1) {
    return "final";
  }

  const task = plan.tasks[taskIndex];
  const taskText = task
    ? [task.title, task.description, ...task.files, ...task.validation]
        .join(" ")
        .toLowerCase()
    : "";

  return /(test|component|interface|interaction|behavior|form|view|screen|page)/u.test(
    taskText,
  )
    ? "behavior"
    : "foundation";
}

function orchestrationProgress(event: OrchestrationEvent): {
  scope: string;
  message: string;
  level?: "info" | "success" | "warning" | "error";
  verbose?: boolean;
} {
  switch (event.type) {
    case "phase_started":
      return {
        scope: "generator",
        message: `Task ${event.index}/${event.total} started: ${event.taskId}`,
      };
    case "context_loaded":
      return {
        scope: "context",
        message: `${event.taskId}: ${event.relevantFileCount} relevant files loaded`,
        verbose: true,
      };
    case "generation_completed":
      return {
        scope: "generator",
        message: `${event.taskId} completed; ${event.changedFileCount} files reported`,
        level: "success",
      };
    case "validation_completed":
      return {
        scope: "validator",
        message: `${event.taskId}: ${event.passed ? "passed" : "failed"}`,
        level: event.passed ? "success" : "warning",
      };
    case "repair_started":
      return {
        scope: "repairer",
        message: `${event.taskId}: attempt ${event.attempt}/${event.maxAttempts} started`,
        level: "warning",
      };
    case "repair_completed":
      return {
        scope: "repairer",
        message: event.status === "fixed"
          ? `${event.taskId}: attempt ${event.attempt} proposed a fix`
          : `${event.taskId}: attempt ${event.attempt} unresolved`,
        level: "warning",
      };
    case "review_started":
      return { scope: "reviewer", message: "Final review started" };
    case "review_completed":
      return {
        scope: "reviewer",
        message: `Final recommendation: ${event.recommendation}`,
        level: event.recommendation === "ready" ? "success" : "warning",
      };
    case "review_failed":
      return { scope: "reviewer", message: event.error, level: "error" };
    case "phase_rolled_back":
      return {
        scope: "workflow",
        message: `${event.taskId}: failed phase changes rolled back`,
        level: "warning",
      };
    case "phase_failed":
      return { scope: "workflow", message: event.error, level: "error" };
    case "workflow_completed":
      return {
        scope: "workflow",
        message: `Workflow ${event.status}`,
        level: event.status === "completed" ? "success" : "error",
      };
  }
}

function toolProgress(
  agentName: string,
  event: AgentToolEvent,
): {
  scope: string;
  message: string;
  level?: "info" | "success" | "warning" | "error";
  verbose?: boolean;
} {
  const verbose = event.tool === "readFile" ||
    event.tool === "listFiles" ||
    event.tool === "getProjectSummary";

  if (event.type === "tool_started") {
    return {
      scope: `${agentName}:${event.tool}`,
      message: `Started (${event.detail})`,
      verbose,
    };
  }

  return {
    scope: `${agentName}:${event.tool}`,
    message: `${event.ok ? "Completed" : "Failed"} in ${formatDuration(event.durationMs)} (${event.detail})`,
    level: event.ok ? "success" : "error",
    verbose,
  };
}

function commandResultFromTool(
  result: Awaited<ReturnType<typeof runWorkspaceCommand>>,
): ValidationResult {
  return {
    passed: result.passed,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function runAgentWorkflow({
  runId,
  specification,
  workspaceRoot,
  model,
  artifactsRoot = resolve(projectRoot, "agent", "runs"),
  traceId,
  eventsPath,
  onProgress,
  dependencies = {},
}: AgentWorkflowOptions): Promise<WorkflowResult> {
  const startedAt = new Date().toISOString();
  const emit: ProgressListener = async (event) => {
    try {
      await onProgress?.(event);
    } catch {
      // Terminal logging must not interrupt generation.
    }
  };
  const runner = dependencies.runner ?? new Runner();
  const planner = dependencies.planner ?? runPlanner;
  const orchestrator = dependencies.orchestrator ?? runGenerationPhases;
  const runDirectory = resolve(artifactsRoot, runId);
  const planPath = resolve(runDirectory, "plan.json");
  const reportPath = resolve(runDirectory, "report.json");

  await emit({ scope: "context", message: "Inspecting generated workspace" });
  const projectSummary = await getWorkspaceSummary(workspaceRoot);
  const relevantFiles = await collectPlanningFiles(workspaceRoot, projectSummary);
  await emit({
    scope: "context",
    message: `${projectSummary.files.length} entries found; ${relevantFiles.length} files selected for planning`,
    level: "success",
  });

  const executeCommand: CommandExecutor = dependencies.commandExecutor ??
    (async (root, command) => {
      const commandStartedAt = Date.now();
      await emit({ scope: "validator", message: `Running ${command}` });
      const result = commandResultFromTool(await runWorkspaceCommand(root, command));
      await emit({
        scope: "validator",
        message: `${command} ${result.passed ? "passed" : `failed with exit code ${result.exitCode}`} in ${formatDuration(Date.now() - commandStartedAt)}`,
        level: result.passed ? "success" : "error",
      });
      if (!result.passed && result.stderr.trim()) {
        await emit({
          scope: "validator",
          message: result.stderr.slice(-1_000),
          level: "error",
          verbose: true,
        });
      }
      return result;
    });

  await emit({
    scope: "setup",
    message: "Running clean-workspace preflight",
  });
  const setupValidation = await runValidationPipeline({
    workspaceRoot,
    commands: validationCommandsForStage("setup"),
    executeCommand,
  });
  if (!setupValidation.passed) {
    throw new WorkflowError(
      "Generated workspace preflight failed before agent generation",
      setupValidation,
    );
  }
  await emit({
    scope: "setup",
    message: "Clean-workspace preflight passed",
    level: "success",
  });

  await emit({ scope: "planner", message: "Planning started" });
  const plan = await planner(
    {
      specification,
      projectContext: JSON.stringify(projectSummary, null, 2),
      relevantFiles,
    },
    { runner, ...(model ? { model } : {}) },
  );
  await writeJson(planPath, plan);
  await emit({
    scope: "planner",
    message: `Plan created with ${plan.tasks.length} tasks; saved to ${planPath}`,
    level: "success",
  });

  const onToolEvent = (agentName: string) => async (event: AgentToolEvent) => {
    await emit(toolProgress(agentName, event));
  };

  const validateTask = async (
    context: Parameters<ReturnType<typeof createPhaseValidator>>[0],
    generationResult: Parameters<ReturnType<typeof createPhaseValidator>>[1],
  ) => {
    const stage = validationStageForTask(plan, context.task.id);
    await emit({
      scope: "validator",
      message: `${context.task.id}: ${stage} validation selected`,
      verbose: true,
    });
    return createPhaseValidator({ stage, executeCommand })(context, generationResult);
  };

  const orchestration = await orchestrator({
    plan,
    specification,
    workspaceRoot,
    executeTask: createGeneratorExecutor({
      runner,
      ...(model ? { model } : {}),
      onToolEvent: onToolEvent("generator"),
    }),
    validateTask,
    repairTask: createRepairExecutor({
      runner,
      ...(model ? { model } : {}),
      onToolEvent: onToolEvent("repairer"),
    }),
    finalReviewer: createFinalReviewer({
      runner,
      ...(model ? { model } : {}),
      onToolEvent: onToolEvent("reviewer"),
    }),
    onEvent: async (event) => {
      await emit(orchestrationProgress(event));
    },
  });

  const report: RunReport = {
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    workspaceRoot,
    model: model ?? null,
    ...(traceId ? { traceId } : {}),
    ...(eventsPath ? { eventsPath } : {}),
    setupValidation,
    orchestration,
  };
  await writeJson(reportPath, report);
  await emit({
    scope: "report",
    message: `Run report saved to ${reportPath}`,
    level: "success",
  });

  return { plan, report, planPath, reportPath };
}
