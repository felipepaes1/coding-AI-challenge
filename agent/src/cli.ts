import { Command, CommanderError } from "commander";
import {
  createRunId,
  loadSpecification,
  prepareOutputWorkspace,
  WorkspaceError,
} from "./workspace.js";

const EXIT_SUCCESS = 0;
const EXIT_UNEXPECTED_ERROR = 1;
const EXIT_USAGE_ERROR = 2;
const EXIT_INPUT_ERROR = 3;
const EXIT_WORKSPACE_ERROR = 4;

type CliOptions = {
  spec: string;
  output: string;
};

function createCli(): Command {
  return new Command()
    .name("agent")
    .description("Generate a React application from a natural-language specification")
    .requiredOption("--spec <path>", "path to the natural-language specification")
    .requiredOption("--output <path>", "output directory for the generated application")
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
      console.error(`[${runId}] Invalid CLI arguments: ${message}`);
      return EXIT_USAGE_ERROR;
    }

    console.error(`[${runId}] Could not parse CLI arguments: ${message}`);
    return EXIT_UNEXPECTED_ERROR;
  }

  console.log(`[${runId}] Starting generation workflow`);
  console.log(`[${runId}] Reading specification: ${options.spec}`);

  let specification;
  try {
    specification = await loadSpecification(options.spec);
  } catch (error) {
    const message = formatError(error);
    console.error(`[${runId}] Input error: ${message}`);
    return error instanceof WorkspaceError ? EXIT_INPUT_ERROR : EXIT_UNEXPECTED_ERROR;
  }

  console.log(
    `[${runId}] Specification loaded (${specification.content.length} characters)`,
  );
  console.log(`[${runId}] Preparing output workspace: ${options.output}`);

  let outputPath: string;
  try {
    outputPath = await prepareOutputWorkspace(options.output);
  } catch (error) {
    const message = formatError(error);
    console.error(`[${runId}] Workspace error: ${message}`);
    return error instanceof WorkspaceError
      ? EXIT_WORKSPACE_ERROR
      : EXIT_UNEXPECTED_ERROR;
  }

  console.log(`[${runId}] Boilerplate copied to ${outputPath}`);
  console.log(`[${runId}] Workspace preparation completed`);
  return EXIT_SUCCESS;
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
