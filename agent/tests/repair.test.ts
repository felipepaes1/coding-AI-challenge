import { describe, expect, it } from "vitest";
import type { GenerationPhaseContext } from "../src/orchestrator.js";
import {
  buildRepairInput,
  createRepairAgent,
  loadRepairInstructions,
  repairResultSchema,
  RepairValidationError,
  validateRepairResult,
} from "../src/repair.js";

const context: GenerationPhaseContext = {
  specification: "Build a frontend application.",
  task: {
    id: "create-ui",
    title: "Create the UI",
    description: "Build the main interface.",
    files: ["src/App.tsx"],
    dependsOn: [],
    validation: ["npm run typecheck"],
  },
  projectSummary: {
    workspaceRoot: "C:/workspace/generated-app",
    packageJson: { name: "generated-app" },
    files: [{ path: "src/App.tsx", type: "file" }],
    filesTruncated: false,
  },
  completedDependencies: [],
  relevantFiles: [
    {
      path: "src/App.tsx",
      content: "export default function App() {}",
      exists: true,
      truncated: false,
    },
  ],
};

const validation = {
  passed: false,
  summary: "Typecheck failed",
  command: "npm run typecheck",
  stdout: "",
  stderr: "src/App.tsx: Type 'string' is not assignable to type 'number'.",
};

describe("repair agent", () => {
  it("loads generic repair instructions", async () => {
    const instructions = await loadRepairInstructions();

    expect(instructions).toContain("validation failure");
    expect(instructions.toLowerCase()).not.toContain("car inventory");
  });

  it("exposes only workspace inspection and editing tools", () => {
    const agent = createRepairAgent(
      context.projectSummary.workspaceRoot,
      "Repair one validation failure.",
      "test-model",
    );

    expect(agent.name).toBe("Validation Repair Agent");
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual([
      "getProjectSummary",
      "listFiles",
      "readFile",
      "writeFile",
    ]);
    expect(agent.outputType).toBe(repairResultSchema);
  });

  it("builds focused input with command output and related files", () => {
    const input = buildRepairInput(context, validation, 2, 2, [
      {
        attempt: 1,
        status: "fixed",
        rootCause: "The first diagnosis was incomplete.",
        changedFiles: ["src/App.tsx"],
        summary: "Applied the first repair.",
        repeatedFailure: true,
      },
    ]);

    expect(input).toContain("VALIDATION_FAILURE");
    expect(input).toContain("npm run typecheck");
    expect(input).toContain("Type 'string' is not assignable");
    expect(input).toContain("src/App.tsx");
    expect(input).toContain('"attempt": 2');
    expect(input).toContain("PREVIOUS_REPAIR_ATTEMPTS");
    expect(input).toContain("The first diagnosis was incomplete");
  });

  it("validates the task ID and changed file paths", () => {
    const result = validateRepairResult(
      {
        taskId: "create-ui",
        status: "fixed",
        rootCause: "The component used the wrong prop type.",
        changedFiles: ["src/App.tsx"],
        summary: "Corrected the prop type.",
        nextValidation: "npm run typecheck",
      },
      "create-ui",
    );

    expect(result.status).toBe("fixed");

    expect(() =>
      validateRepairResult(
        {
          taskId: "another-task",
          status: "fixed",
          rootCause: "Wrong task.",
          changedFiles: [],
          summary: "No change.",
          nextValidation: "npm test",
        },
        "create-ui",
      ),
    ).toThrow(RepairValidationError);

    expect(() =>
      validateRepairResult({
        taskId: "create-ui",
        status: "fixed",
        rootCause: "Unsafe change.",
        changedFiles: ["../outside.ts"],
        summary: "Changed an unsafe path.",
        nextValidation: "npm test",
      }),
    ).toThrow("unsafe changed file path");

    expect(() =>
      validateRepairResult(
        {
          taskId: "create-ui",
          status: "fixed",
          rootCause: "Changed an unrelated client.",
          changedFiles: ["src/client.ts"],
          summary: "Changed an unowned file.",
          nextValidation: "npm test",
        },
        "create-ui",
        ["src/App.tsx"],
      ),
    ).toThrow("outside the current task");
  });
});
