import type {
  GenerationPhaseContext,
  GenerationTaskResult,
  PhaseValidator,
} from "./orchestrator.js";
import {
  allowedCommands,
  runWorkspaceCommand,
  type ToolSuccess,
} from "./tools/index.js";

export type ValidationCommand = (typeof allowedCommands)[number];

export type ValidationResult = {
  passed: boolean;
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ValidationReport = {
  passed: boolean;
  results: ValidationResult[];
};

export type ValidationStage = "setup" | "foundation" | "behavior" | "final";

export type CommandExecutor = (
  workspaceRoot: string,
  command: ValidationCommand,
) => Promise<ValidationResult>;

export type ValidationPipelineOptions = {
  workspaceRoot: string;
  commands: ValidationCommand[];
  executeCommand?: CommandExecutor;
  stopOnFailure?: boolean;
};

const commandsByStage: Record<ValidationStage, ValidationCommand[]> = {
  setup: ["npm install"],
  foundation: ["npm run typecheck"],
  behavior: ["npm run typecheck", "npm test"],
  final: ["npm run typecheck", "npm test", "npm run build"],
};

function commandFailure(command: ValidationCommand, error: unknown): ValidationResult {
  return {
    passed: false,
    command,
    exitCode: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  };
}

function mapCommandResult(
  result: ToolSuccess<{
    command: ValidationCommand;
    passed: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
  }>,
): ValidationResult {
  return {
    passed: result.passed,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function validationCommandsForStage(stage: ValidationStage): ValidationCommand[] {
  return [...commandsByStage[stage]];
}

export async function runValidationPipeline({
  workspaceRoot,
  commands,
  executeCommand = async (root, command) =>
    mapCommandResult(await runWorkspaceCommand(root, command)),
  stopOnFailure = true,
}: ValidationPipelineOptions): Promise<ValidationReport> {
  const results: ValidationResult[] = [];
  const uniqueCommands = [...new Set(commands)];

  for (const command of uniqueCommands) {
    let result: ValidationResult;
    try {
      result = await executeCommand(workspaceRoot, command);
    } catch (error) {
      result = commandFailure(command, error);
    }

    results.push(result);
    if (!result.passed && stopOnFailure) {
      break;
    }
  }

  return {
    passed: results.length === uniqueCommands.length && results.every((result) => result.passed),
    results,
  };
}

export type PhaseValidatorOptions = {
  stage: ValidationStage;
  executeCommand?: CommandExecutor;
};

export function createPhaseValidator({
  stage,
  executeCommand,
}: PhaseValidatorOptions): PhaseValidator {
  return async (
    context: GenerationPhaseContext,
    _generationResult: GenerationTaskResult,
  ) => {
    const report = await runValidationPipeline({
      workspaceRoot: context.projectSummary.workspaceRoot,
      commands: validationCommandsForStage(stage),
      executeCommand,
    });
    const firstFailure = report.results.find((result) => !result.passed);

    return {
      passed: report.passed,
      summary: report.passed
        ? `${stage} validation passed`
        : `${firstFailure?.command ?? stage} failed with exit code ${firstFailure?.exitCode ?? 1}`,
      command: firstFailure?.command ?? report.results.at(-1)?.command,
      stdout: firstFailure?.stdout ?? report.results.at(-1)?.stdout,
      stderr: firstFailure?.stderr ?? report.results.at(-1)?.stderr,
      results: report.results,
    };
  };
}
