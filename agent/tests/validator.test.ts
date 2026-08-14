import { describe, expect, it } from "vitest";
import {
  createPhaseValidator,
  runValidationPipeline,
  validationCommandsForStage,
  type ValidationCommand,
} from "../src/validator.js";

describe("validation pipeline", () => {
  it("selects commands by milestone", () => {
    expect(validationCommandsForStage("setup")).toEqual([
      "npm install",
      "npm run typecheck",
      "npm test",
      "npm run build",
    ]);
    expect(validationCommandsForStage("foundation")).toEqual(["npm run typecheck"]);
    expect(validationCommandsForStage("behavior")).toEqual([
      "npm run typecheck",
      "npm test",
    ]);
    expect(validationCommandsForStage("final")).toEqual([
      "npm run typecheck",
      "npm test",
      "npm run build",
    ]);
  });

  it("returns structured results and stops after the first failure", async () => {
    const executed: ValidationCommand[] = [];
    const report = await runValidationPipeline({
      workspaceRoot: "C:/workspace/generated-app",
      commands: ["npm run typecheck", "npm test", "npm run build"],
      executeCommand: async (_root, command) => {
        executed.push(command);
        return {
          passed: command === "npm run typecheck",
          command,
          exitCode: command === "npm run typecheck" ? 0 : 1,
          stdout: command === "npm run typecheck" ? "ok" : "",
          stderr: command === "npm run typecheck" ? "" : "failure",
        };
      },
    });

    expect(report).toEqual({
      passed: false,
      results: [
        {
          passed: true,
          command: "npm run typecheck",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        },
        {
          passed: false,
          command: "npm test",
          exitCode: 1,
          stdout: "",
          stderr: "failure",
        },
      ],
    });
    expect(executed).toEqual(["npm run typecheck", "npm test"]);
  });

  it("can continue after failures when requested", async () => {
    const executed: ValidationCommand[] = [];
    const report = await runValidationPipeline({
      workspaceRoot: "C:/workspace/generated-app",
      commands: ["npm run typecheck", "npm test", "npm run build"],
      stopOnFailure: false,
      executeCommand: async (_root, command) => {
        executed.push(command);
        return {
          passed: false,
          command,
          exitCode: 1,
          stdout: "",
          stderr: "failure",
        };
      },
    });

    expect(report.passed).toBe(false);
    expect(report.results).toHaveLength(3);
    expect(executed).toEqual(["npm run typecheck", "npm test", "npm run build"]);
  });

  it("adapts a validation report to the orchestrator phase contract", async () => {
    const validator = createPhaseValidator({
      stage: "behavior",
      executeCommand: async (_root, command) => ({
        passed: true,
        command,
        exitCode: 0,
        stdout: "passed",
        stderr: "",
      }),
    });

    const result = await validator(
      {
        specification: "Build an app.",
        task: {
          id: "ui",
          title: "Create UI",
          description: "Create the UI.",
          files: ["src/App.tsx"],
          dependsOn: [],
          validation: ["npm test"],
        },
        projectSummary: {
          workspaceRoot: "C:/workspace/generated-app",
          packageJson: null,
          files: [],
          filesTruncated: false,
        },
        completedDependencies: [],
        relevantFiles: [],
      },
      {
        taskId: "ui",
        status: "completed",
        changedFiles: ["src/App.tsx"],
        summary: "Created UI.",
      },
    );

    expect(result.passed).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.summary).toContain("behavior validation passed");
  });
});
