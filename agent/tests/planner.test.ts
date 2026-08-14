import { describe, expect, it } from "vitest";
import {
  buildPlannerInput,
  createPlannerAgent,
  implementationPlanSchema,
  loadPlannerInstructions,
  PlannerValidationError,
  validateImplementationPlan,
} from "../src/planner.js";

const validPlan = {
  summary: "Implement the requested frontend application in dependency order.",
  assumptions: [],
  tasks: [
    {
      id: "foundation",
      title: "Create application foundation",
      description: "Define the core types and data access boundary.",
      files: ["src/types.ts"],
      dependsOn: [],
      validation: ["npm run typecheck"],
    },
    {
      id: "ui",
      title: "Create the main UI",
      description: "Build the UI using the foundation types.",
      files: ["src/App.tsx"],
      dependsOn: ["foundation"],
      validation: ["npm test"],
    },
  ],
  acceptanceCriteria: ["The generated application is runnable."],
};

describe("planner", () => {
  it("loads the planner instructions", async () => {
    const instructions = await loadPlannerInstructions();

    expect(instructions).toContain("Convert the application specification");
  });

  it("creates an agent with structured output and no tools", () => {
    const agent = createPlannerAgent("Plan the application.", "test-model");

    expect(agent.name).toBe("Implementation Planner");
    expect(agent.tools).toHaveLength(0);
    expect(agent.outputType).toBe(implementationPlanSchema);
  });

  it("validates a plan and its dependency graph", () => {
    expect(validateImplementationPlan(validPlan)).toEqual(validPlan);
  });

  it("rejects unknown dependencies, cycles, and unsafe paths", () => {
    expect(() =>
      validateImplementationPlan({
        ...validPlan,
        tasks: [{ ...validPlan.tasks[0], dependsOn: ["missing"] }],
      }),
    ).toThrow(PlannerValidationError);

    expect(() =>
      validateImplementationPlan({
        ...validPlan,
        tasks: [
          { ...validPlan.tasks[0], dependsOn: ["ui"] },
          { ...validPlan.tasks[1], dependsOn: ["foundation"] },
        ],
      }),
    ).toThrow("Circular task dependency");

    expect(() =>
      validateImplementationPlan({
        ...validPlan,
        tasks: [...validPlan.tasks].reverse(),
      }),
    ).toThrow("must appear after its dependency");

    expect(() =>
      validateImplementationPlan({
        ...validPlan,
        tasks: [{ ...validPlan.tasks[0], files: ["../outside.ts"] }],
      }),
    ).toThrow("unsafe file path");
  });

  it("builds an input containing the specification and relevant files", () => {
    const input = buildPlannerInput({
      specification: "Build a dashboard.",
      projectContext: "The project uses React and TypeScript.",
      relevantFiles: [{ path: "src/App.tsx", content: "export default function App() {}" }],
    });

    expect(input).toContain("APPLICATION_SPECIFICATION");
    expect(input).toContain("Build a dashboard.");
    expect(input).toContain("PROJECT_CONTEXT");
    expect(input).toContain("src/App.tsx");
  });
});
