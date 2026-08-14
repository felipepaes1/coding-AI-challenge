import { resolve } from "node:path";
import { withTrace } from "@openai/agents";
import { Command, CommanderError } from "commander";
import { loadAgentEnvironment } from "./environment.js";
import {
  combineProgressListeners,
  createJsonlProgressListener,
  createTerminalProgressListener,
} from "./progress.js";
import { runAgentWorkflow, WorkflowError } from "./workflow.js";
import {
  createRunId,
  loadSpecification,
  prepareOutputWorkspace,
  projectRoot,
  WorkspaceError,
} from "./workspace.js";

const EXIT_SUCCESS = 0;
const EXIT_UNEXPECTED_ERROR = 1;
const EXIT_USAGE_ERROR = 2;
const EXIT_INPUT_ERROR = 3;
const EXIT_WORKSPACE_ERROR = 4;
const EXIT_CONFIGURATION_ERROR = 5;
const EXIT_GENERATION_ERROR = 6;

type CliOptions = {
  spec: string;
  output: string;
  model?: string;
  verbose: boolean;
};

function createCli(): Command {
  return new Command()
    .name("agent")
    .description("Generate a React application from a natural-language specification")
    .requiredOption("--spec <path>", "path to the natural-language specification")
    .requiredOption("--output <path>", "output directory for the generated application")
    .option("--model <model>", "OpenAI model override")
    .option("--verbose", "show file inspection and detailed validation logs", false)
    .showHelpAfterError()
    .exitOverride();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runCli(argv: string[]): Promise<number> {
  const runId = createRunId();
  const cli = createCli();

  let options: CliOptions;
  try {
    cli.parse(["node", "agent", ...argv]);
    options = cli.opts<CliOptions>();
  } catch (error) {
    const message = formatError(error);
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed") {
        return EXIT_SUCCESS;
      }
      console.error(`[${runId}] Invalid CLI arguments: ${message}`);
      return EXIT_USAGE_ERROR;
    }

    console.error(`[${runId}] Could not parse CLI arguments: ${message}`);
    return EXIT_UNEXPECTED_ERROR;
  }

  const eventsPath = resolve(projectRoot, "agent", "runs", runId, "events.jsonl");
  const progress = combineProgressListeners(
    createTerminalProgressListener(runId, { verbose: options.verbose }),
    createJsonlProgressListener(runId, eventsPath),
  );

  await progress({ scope: "workflow", message: "Starting generation workflow" });
  await progress({ scope: "input", message: `Reading specification: ${options.spec}` });

  let specification;
  try {
    specification = await loadSpecification(options.spec);
  } catch (error) {
    const message = formatError(error);
    await progress({ scope: "input", message: `Input error: ${message}`, level: "error" });
    return error instanceof WorkspaceError ? EXIT_INPUT_ERROR : EXIT_UNEXPECTED_ERROR;
  }

  await progress({
    scope: "input",
    message: `Specification loaded (${specification.content.length} characters)`,
    level: "success",
  });

  const environment = await loadAgentEnvironment();
  if (!environment.hasOpenAIKey) {
    await progress({
      scope: "environment",
      message: `Configuration error: OPENAI_API_KEY was not found in ${environment.envPath}`,
      level: "error",
    });
    return EXIT_CONFIGURATION_ERROR;
  }
  await progress({
    scope: "environment",
    message: `OpenAI credentials loaded from ${environment.envPath}`,
    level: "success",
  });
  const model = options.model?.trim() || environment.model;
  await progress({
    scope: "environment",
    message: `Model: ${model ?? "Agents SDK default"}`,
  });
  await progress({
    scope: "workspace",
    message: `Preparing output workspace: ${options.output}`,
  });

  let outputPath: string;
  try {
    outputPath = await prepareOutputWorkspace(options.output);
  } catch (error) {
    const message = formatError(error);
    await progress({
      scope: "workspace",
      message: `Workspace error: ${message}`,
      level: "error",
    });
    return error instanceof WorkspaceError
      ? EXIT_WORKSPACE_ERROR
      : EXIT_UNEXPECTED_ERROR;
  }

  await progress({
    scope: "workspace",
    message: `Boilerplate copied to ${outputPath}`,
    level: "success",
  });

  try {
    const result = await withTrace(
      `Application generation ${runId}`,
      async (trace) => {
        await progress({
          scope: "trace",
          message: `OpenAI trace started: ${trace.traceId}`,
          verbose: true,
        });
        return runAgentWorkflow({
          runId,
          specification: specification.content,
          workspaceRoot: outputPath,
          ...(model ? { model } : {}),
          traceId: trace.traceId,
          eventsPath,
          onProgress: progress,
        });
      },
      {
        groupId: runId,
        metadata: { runId },
      },
    );

    if (result.report.orchestration.status !== "completed") {
      await progress({
        scope: "workflow",
        message: `Generation blocked. See report: ${result.reportPath}`,
        level: "error",
      });
      return EXIT_GENERATION_ERROR;
    }

    await progress({
      scope: "workflow",
      message: `Generated application: ${outputPath}`,
      level: "success",
    });
    await progress({ scope: "report", message: `Final report: ${result.reportPath}` });
    await progress({ scope: "report", message: `Event log: ${eventsPath}` });
    return EXIT_SUCCESS;
  } catch (error) {
    const message = formatError(error);
    await progress({
      scope: "workflow",
      message: `Generation error: ${message}`,
      level: "error",
    });
    if (error instanceof WorkflowError && options.verbose && error.details) {
      await progress({
        scope: "workflow",
        message: JSON.stringify(error.details, null, 2),
        level: "error",
        verbose: true,
      });
    }
    return EXIT_GENERATION_ERROR;
  }
}

const currentModulePath = process.argv[1];
const isDirectExecution = currentModulePath?.endsWith("cli.ts") ?? false;

if (isDirectExecution) {
  runCli(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(`[fatal] ${formatError(error)}`);
      process.exitCode = EXIT_UNEXPECTED_ERROR;
    });
}
