import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ImplementationPlan } from "../src/planner.js";
import {
  runAgentWorkflow,
  validationStageForTask,
  WorkflowError,
} from "../src/workflow.js";

const plan: ImplementationPlan = {
  summary: "Implement a small frontend application.",
  assumptions: [],
  tasks: [
    {
      id: "foundation",
      title: "Create types",
      description: "Create foundational types.",
      files: ["src/types.ts"],
      dependsOn: [],
      validation: ["npm run typecheck"],
    },
    {
      id: "interface",
      title: "Create interface component",
      description: "Create the main user interface.",
      files: ["src/App.tsx"],
      dependsOn: ["foundation"],
      validation: ["npm test"],
    },
    {
      id: "tests",
      title: "Complete tests",
      description: "Add final tests.",
      files: ["src/App.test.tsx"],
      dependsOn: ["interface"],
      validation: ["npm test", "npm run build"],
    },
  ],
  acceptanceCriteria: ["The application runs."],
};

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), "agent-workflow-"));
  await mkdir(resolve(workspaceRoot, "src"), { recursive: true });
  await writeFile(
    resolve(workspaceRoot, "package.json"),
    JSON.stringify({ name: "workflow-fixture" }),
    "utf8",
  );
  await writeFile(
    resolve(workspaceRoot, "src", "App.tsx"),
    "export default function App() { return null; }",
    "utf8",
  );
  return workspaceRoot;
}

describe("end-to-end workflow wiring", () => {
  it("selects validation milestones from task position and responsibility", () => {
    expect(validationStageForTask(plan, "foundation")).toBe("foundation");
    expect(validationStageForTask(plan, "interface")).toBe("behavior");
    expect(validationStageForTask(plan, "tests")).toBe("final");
  });

  it("connects planning, setup, orchestration, progress, and run artifacts without an API call", async () => {
    const workspaceRoot = await createWorkspace();
    const artifactsRoot = resolve(workspaceRoot, "run-artifacts");
    const progress: Array<{ scope: string; message: string }> = [];
    const commands: string[] = [];
    let plannerRelevantFiles: string[] = [];

    try {
      const result = await runAgentWorkflow({
        runId: "test-run",
        specification: "Build a small frontend application.",
        workspaceRoot,
        artifactsRoot,
        onProgress: (event) => {
          progress.push(event);
        },
        dependencies: {
          planner: async (request) => {
            plannerRelevantFiles = request.relevantFiles.map((file) => file.path);
            return plan;
          },
          commandExecutor: async (_root, command) => {
            commands.push(command);
            return {
              passed: true,
              command,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            };
          },
          orchestrator: async (options) => {
            await options.onEvent?.({
              type: "phase_started",
              taskId: "foundation",
              index: 1,
              total: 3,
            });
            await options.onEvent?.({
              type: "workflow_completed",
              status: "completed",
            });
            return {
              status: "completed",
              phases: [],
              completedTaskIds: plan.tasks.map((task) => task.id),
            };
          },
        },
      });

      expect(commands).toEqual([
        "npm install",
        "npm run typecheck",
        "npm test",
        "npm run build",
      ]);
      expect(plannerRelevantFiles).toContain("package.json");
      expect(plannerRelevantFiles).toContain("src/App.tsx");
      expect(progress.map((event) => event.scope)).toContain("planner");
      expect(progress.map((event) => event.scope)).toContain("generator");
      expect(result.report.orchestration.status).toBe("completed");
      expect(result.report.model).toBeNull();
      await expect(readFile(result.planPath, "utf8")).resolves.toContain("foundation");
      await expect(readFile(result.reportPath, "utf8")).resolves.toContain(
        '"runId": "test-run"',
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("stops before planning when the clean-workspace preflight fails", async () => {
    const workspaceRoot = await createWorkspace();
    let plannerCalled = false;
    const commands: string[] = [];

    try {
      await expect(runAgentWorkflow({
        runId: "preflight-failure",
        specification: "Build a small frontend application.",
        workspaceRoot,
        artifactsRoot: resolve(workspaceRoot, "run-artifacts"),
        dependencies: {
          planner: async () => {
            plannerCalled = true;
            return plan;
          },
          commandExecutor: async (_root, command) => {
            commands.push(command);
            return {
              passed: command !== "npm test",
              command,
              exitCode: command === "npm test" ? 1 : 0,
              stdout: "",
              stderr: command === "npm test" ? "Baseline test failed" : "",
            };
          },
        },
      })).rejects.toThrow(WorkflowError);

      expect(plannerCalled).toBe(false);
      expect(commands).toEqual(["npm install", "npm run typecheck", "npm test"]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
