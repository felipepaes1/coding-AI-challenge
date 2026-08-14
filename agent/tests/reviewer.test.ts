import { describe, expect, it } from "vitest";
import {
  buildReviewerInput,
  createReviewerAgent,
  loadReviewerInstructions,
  reviewReportSchema,
  ReviewerValidationError,
  validateReviewReport,
  type ReviewerContext,
} from "../src/reviewer.js";

const orchestrationReport = {
  status: "completed" as const,
  phases: [
    {
      taskId: "create-ui",
      title: "Create UI",
      status: "passed" as const,
      changedFiles: ["src/App.tsx"],
      summary: "Created the UI.",
      validation: {
        passed: true,
        summary: "behavior validation passed",
      },
    },
  ],
  completedTaskIds: ["create-ui"],
};

const reviewerContext: ReviewerContext = {
  specification: "Build a frontend application with a searchable list.",
  projectSummary: {
    workspaceRoot: "C:/workspace/generated-app",
    packageJson: { name: "generated-app" },
    files: [
      { path: "package.json", type: "file" },
      { path: "src/App.tsx", type: "file" },
      { path: "src/App.test.tsx", type: "file" },
    ],
    filesTruncated: false,
  },
  orchestrationReport,
  relevantFiles: [
    {
      path: "package.json",
      content: '{"scripts":{"test":"vitest run"}}',
      exists: true,
      truncated: false,
    },
    {
      path: "src/App.tsx",
      content: "export default function App() {}",
      exists: true,
      truncated: false,
    },
  ],
};

describe("reviewer agent", () => {
  it("loads generic final review instructions", async () => {
    const instructions = await loadReviewerInstructions();

    expect(instructions).toContain("read-only reviewer");
    expect(instructions.toLowerCase()).not.toContain("car inventory");
  });

  it("exposes only read-only workspace tools", () => {
    const agent = createReviewerAgent(
      reviewerContext.projectSummary.workspaceRoot,
      "Review the generated application.",
      "test-model",
    );

    expect(agent.name).toBe("Final Requirements Reviewer");
    expect(agent.tools.map((tool) => tool.name).sort()).toEqual([
      "getProjectSummary",
      "listFiles",
      "readFile",
    ]);
    expect(agent.outputType).toBe(reviewReportSchema);
  });

  it("builds focused input with the specification and execution evidence", () => {
    const input = buildReviewerInput(reviewerContext);

    expect(input).toContain("APPLICATION_SPECIFICATION");
    expect(input).toContain("ORCHESTRATION_REPORT");
    expect(input).toContain("searchable list");
    expect(input).toContain("src/App.tsx");
    expect(input).toContain("package.json");
  });

  it("validates the exact review report contract", () => {
    const report = validateReviewReport({
      requirements: [
        {
          requirement: "The list is searchable.",
          status: "passed",
          evidence: "src/App.tsx and src/App.test.tsx",
        },
      ],
      warnings: [],
      recommendation: "ready",
    });

    expect(report.recommendation).toBe("ready");

    expect(() =>
      validateReviewReport({
        requirements: [],
        warnings: [],
        recommendation: "invalid",
      }),
    ).toThrow(ReviewerValidationError);
  });
});
