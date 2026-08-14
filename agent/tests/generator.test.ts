import { describe, expect, it } from "vitest";
import type { GenerationPhaseContext } from "../src/orchestrator.js";
import {
  buildGeneratorInput,
  createGeneratorAgent,
  generationResultSchema,
  loadGeneratorInstructions,
  GeneratorValidationError,
  validateGenerationResult,
} from "../src/generator.js";

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

describe("generator", () => {
  it("loads generic generator instructions", async () => {
    const instructions = await loadGeneratorInstructions();

    expect(instructions).toContain("Implement exactly one approved task");
    expect(instructions.toLowerCase()).not.toContain("car inventory");
  });

  it("creates an agent with editing tools but delegates commands to the validator", () => {
    const agent = createGeneratorAgent(
      context.projectSummary.workspaceRoot,
      "Generate one phase.",
      "test-model",
    );

    expect(agent.name).toBe("Phase Code Generator");
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual([
      "getProjectSummary",
      "listFiles",
      "readFile",
      "writeFile",
    ]);
    expect(agent.outputType).toBe(generationResultSchema);
  });

  it("builds focused input for the current phase", () => {
    const input = buildGeneratorInput(context);

    expect(input).toContain("APPLICATION_SPECIFICATION");
    expect(input).toContain("CURRENT_TASK");
    expect(input).toContain("create-ui");
    expect(input).toContain("PROJECT_SUMMARY");
    expect(input).toContain("src/App.tsx");
  });

  it("validates the task ID and changed file paths", () => {
    const result = validateGenerationResult(
      {
        taskId: "create-ui",
        status: "completed",
        changedFiles: ["src/App.tsx"],
        summary: "Created the UI.",
        assumptions: [],
        validationNotes: [],
      },
      "create-ui",
    );

    expect(result.status).toBe("completed");

    expect(() =>
      validateGenerationResult(
        {
          taskId: "another-task",
          status: "completed",
          changedFiles: [],
          summary: "Wrong task.",
        },
        "create-ui",
      ),
    ).toThrow(GeneratorValidationError);

    expect(() =>
      validateGenerationResult({
        taskId: "create-ui",
        status: "completed",
        changedFiles: ["../outside.ts"],
        summary: "Unsafe change.",
      }),
    ).toThrow("unsafe changed file path");

    expect(() =>
      validateGenerationResult(
        {
          taskId: "create-ui",
          status: "completed",
          changedFiles: ["src/client.ts"],
          summary: "Changed an unowned file.",
        },
        "create-ui",
        ["src/App.tsx"],
      ),
    ).toThrow("outside the current task");
  });
});
