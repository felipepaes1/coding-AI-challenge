import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ImplementationPlan } from "../src/planner.js";
import { runGenerationPhases } from "../src/orchestrator.js";

const plan: ImplementationPlan = {
  summary: "Implement the application in dependency order.",
  assumptions: [],
  tasks: [
    {
      id: "foundation",
      title: "Create foundation",
      description: "Create the foundational module.",
      files: ["src/types.ts"],
      dependsOn: [],
      validation: ["npm run typecheck"],
    },
    {
      id: "ui",
      title: "Create UI",
      description: "Create the UI using the foundation module.",
      files: ["src/App.tsx"],
      dependsOn: ["foundation"],
      validation: ["npm test"],
    },
  ],
  acceptanceCriteria: ["The application is runnable."],
};

async function createWorkspace(): Promise<string> {
  const workspaceRoot = await mkdtemp(resolve(tmpdir(), "agent-orchestrator-"));
  await mkdir(resolve(workspaceRoot, "src"), { recursive: true });
  await writeFile(
    resolve(workspaceRoot, "package.json"),
    JSON.stringify({ name: "orchestrator-fixture" }),
    "utf8",
  );
  await writeFile(resolve(workspaceRoot, "src", "unrelated.ts"), "export {};", "utf8");
  return workspaceRoot;
}

describe("phase orchestrator", () => {
  it("passes focused context and runs dependent phases in order", async () => {
    const workspaceRoot = await createWorkspace();
    const observedContexts: Array<{
      taskId: string;
      completedDependencyIds: string[];
      relevantPaths: string[];
      hasSpecification: boolean;
      summaryFileCount: number;
    }> = [];

    try {
      const report = await runGenerationPhases({
        plan,
        specification: "Build a small frontend application.",
        workspaceRoot,
        executeTask: async (context) => {
          observedContexts.push({
            taskId: context.task.id,
            completedDependencyIds: context.completedDependencies.map((item) => item.taskId),
            relevantPaths: context.relevantFiles.map((file) => file.path),
            hasSpecification: context.specification.includes("frontend application"),
            summaryFileCount: context.projectSummary.files.length,
          });
          await writeFile(
            resolve(workspaceRoot, context.task.files[0]!),
            `export const task = "${context.task.id}";`,
            "utf8",
          );
          return {
            taskId: context.task.id,
            status: "completed",
            changedFiles: context.task.files,
            summary: `Completed ${context.task.id}`,
          };
        },
        validateTask: async (_context, generationResult) => ({
          passed: true,
          summary: `Validated ${generationResult.taskId}`,
        }),
      });

      expect(report.status).toBe("completed");
      expect(report.completedTaskIds).toEqual(["foundation", "ui"]);
      expect(observedContexts).toHaveLength(2);
      const firstContext = observedContexts[0];
      const secondContext = observedContexts[1];
      if (!firstContext || !secondContext) {
        throw new Error("Expected both phase contexts to be collected");
      }
      expect(firstContext).toMatchObject({
        taskId: "foundation",
        completedDependencyIds: [],
        relevantPaths: ["src/types.ts"],
        hasSpecification: true,
      });
      expect(secondContext).toMatchObject({
        taskId: "ui",
        completedDependencyIds: ["foundation"],
        relevantPaths: ["src/App.tsx", "src/types.ts"],
        hasSpecification: true,
      });
      expect(secondContext.relevantPaths).not.toContain("src/unrelated.ts");
      expect(secondContext.summaryFileCount).toBeGreaterThan(0);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("stops before the next phase when validation fails", async () => {
    const workspaceRoot = await createWorkspace();
    const executedTaskIds: string[] = [];

    try {
      const report = await runGenerationPhases({
        plan,
        specification: "Build a frontend application.",
        workspaceRoot,
        executeTask: async (context) => {
          executedTaskIds.push(context.task.id);
          return {
            taskId: context.task.id,
            status: "completed",
            changedFiles: [],
            summary: "Generated files.",
          };
        },
        validateTask: async () => ({
          passed: false,
          summary: "Typecheck failed.",
        }),
      });

      expect(report).toMatchObject({
        status: "blocked",
        failedTaskId: "foundation",
      });
      expect(executedTaskIds).toEqual(["foundation"]);
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("repairs a failed phase and continues with the next phase", async () => {
    const workspaceRoot = await createWorkspace();
    const executedTaskIds: string[] = [];
    const validationCalls = new Map<string, number>();
    const repairAttempts: number[] = [];
    const events: string[] = [];

    try {
      const report = await runGenerationPhases({
        plan,
        specification: "Build a frontend application.",
        workspaceRoot,
        executeTask: async (context) => {
          executedTaskIds.push(context.task.id);
          return {
            taskId: context.task.id,
            status: "completed",
            changedFiles: context.task.files,
            summary: `Generated ${context.task.id}.`,
          };
        },
        validateTask: async (context) => {
          const calls = (validationCalls.get(context.task.id) ?? 0) + 1;
          validationCalls.set(context.task.id, calls);

          if (context.task.id === "foundation" && calls === 1) {
            return {
              passed: false,
              summary: "Typecheck failed.",
              command: "npm run typecheck",
              stdout: "",
              stderr: "Type error in src/types.ts",
            };
          }

          return {
            passed: true,
            summary: `Validated ${context.task.id}.`,
          };
        },
        repairTask: async (context, validation, attempt, maxAttempts) => {
          repairAttempts.push(attempt);
          expect(context.task.id).toBe("foundation");
          expect(validation.stderr).toContain("src/types.ts");
          expect(maxAttempts).toBe(4);
          return {
            taskId: "foundation",
            status: "fixed",
            rootCause: "The generated type declaration was incomplete.",
            changedFiles: ["src/types.ts"],
            summary: "Completed the missing type declaration.",
            nextValidation: "npm run typecheck",
          };
        },
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      expect(report.status).toBe("completed");
      expect(executedTaskIds).toEqual(["foundation", "ui"]);
      expect(validationCalls).toEqual(new Map([
        ["foundation", 2],
        ["ui", 1],
      ]));
      expect(repairAttempts).toEqual([1]);
      expect(report.phases[0]).toMatchObject({
        status: "passed",
        changedFiles: ["src/types.ts"],
      });
      expect(report.phases[0]?.repairAttempts).toHaveLength(1);
      expect(report.phases[0]?.initialValidation).toMatchObject({
        passed: false,
        command: "npm run typecheck",
      });
      expect(events).toContain("repair_started");
      expect(events).toContain("repair_completed");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("restores existing files and removes new files when a phase fails", async () => {
    const workspaceRoot = await createWorkspace();
    const events: string[] = [];
    const rollbackPlan: ImplementationPlan = {
      ...plan,
      tasks: [{
        ...plan.tasks[0]!,
        files: ["src/types.ts", "src/new-module.ts"],
      }],
    };

    try {
      await writeFile(resolve(workspaceRoot, "src/types.ts"), "original", "utf8");
      const report = await runGenerationPhases({
        plan: rollbackPlan,
        specification: "Build a frontend application.",
        workspaceRoot,
        executeTask: async (context) => {
          await writeFile(resolve(workspaceRoot, "src/types.ts"), "broken", "utf8");
          await writeFile(resolve(workspaceRoot, "src/new-module.ts"), "new", "utf8");
          return {
            taskId: context.task.id,
            status: "completed",
            changedFiles: context.task.files,
            summary: "Generated invalid files.",
          };
        },
        validateTask: async () => ({
          passed: false,
          summary: "Typecheck failed.",
        }),
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      expect(report.status).toBe("blocked");
      expect(report.phases[0]?.rolledBack).toBe(true);
      expect(events).toContain("phase_rolled_back");
      await expect(readFile(resolve(workspaceRoot, "src/types.ts"), "utf8")).resolves.toBe("original");
      await expect(readFile(resolve(workspaceRoot, "src/new-module.ts"), "utf8")).rejects.toThrow();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("stops early after two repairs leave the validation failure unchanged", async () => {
    const workspaceRoot = await createWorkspace();
    const executedTaskIds: string[] = [];
    let validationCount = 0;
    let repairCount = 0;

    try {
      const report = await runGenerationPhases({
        plan,
        specification: "Build a frontend application.",
        workspaceRoot,
        executeTask: async (context) => {
          executedTaskIds.push(context.task.id);
          return {
            taskId: context.task.id,
            status: "completed",
            changedFiles: context.task.files,
            summary: "Generated files.",
          };
        },
        validateTask: async (context) => {
          if (context.task.id === "foundation") {
            validationCount += 1;
            return {
              passed: false,
              summary: "Typecheck failed.",
              command: "npm run typecheck",
              stdout: "Compiler output",
              stderr: "Persistent type error",
            };
          }

          return { passed: true, summary: "Validated UI." };
        },
        repairTask: async (_context, _validation, attempt, _maxAttempts, previousAttempts) => {
          repairCount += 1;
          expect(previousAttempts).toHaveLength(attempt - 1);
          return {
            taskId: "foundation",
            status: "fixed",
            rootCause: `Attempt ${repairCount} did not address the type mismatch.`,
            changedFiles: ["src/types.ts"],
            summary: "Applied a repair that did not resolve the failure.",
            nextValidation: "npm run typecheck",
          };
        },
      });

      expect(report.status).toBe("blocked");
      expect(report.failedTaskId).toBe("foundation");
      expect(executedTaskIds).toEqual(["foundation"]);
      expect(validationCount).toBe(3);
      expect(repairCount).toBe(2);
      expect(report.phases[0]?.repairAttempts).toHaveLength(2);
      expect(report.phases[0]?.repairAttempts?.every(
        (attempt) => attempt.repeatedFailure,
      )).toBe(true);
      expect(report.phases[0]?.error).toContain("npm run typecheck");
      expect(report.phases[0]?.error).toContain("Persistent type error");
      expect(report.phases[0]?.error).toContain("same validation failure");
      expect(report.phases[0]?.error).toContain("stopped early");
      expect(report.phases[0]?.error).not.toContain("maximum number of repair attempts");
      expect(report.phases[0]?.error).toContain("Attempt 2");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("allows four repair attempts while the validation failure keeps changing", async () => {
    const workspaceRoot = await createWorkspace();
    let validationCount = 0;
    let repairCount = 0;

    try {
      const report = await runGenerationPhases({
        plan: { ...plan, tasks: [plan.tasks[0]!] },
        specification: "Build a frontend application.",
        workspaceRoot,
        executeTask: async (context) => ({
          taskId: context.task.id,
          status: "completed",
          changedFiles: context.task.files,
          summary: "Generated files.",
        }),
        validateTask: async () => {
          validationCount += 1;
          return {
            passed: false,
            summary: "Validation failed.",
            command: "npm test",
            stderr: `Distinct failure ${validationCount}`,
          };
        },
        repairTask: async (_context, _validation, attempt, maxAttempts) => {
          repairCount += 1;
          expect(maxAttempts).toBe(4);
          return {
            taskId: "foundation",
            status: "fixed",
            rootCause: `Diagnosis ${attempt}`,
            changedFiles: ["src/types.ts"],
            summary: `Repair ${attempt}`,
            nextValidation: "npm test",
          };
        },
      });

      expect(report.status).toBe("blocked");
      expect(validationCount).toBe(5);
      expect(repairCount).toBe(4);
      expect(report.phases[0]?.repairAttempts).toHaveLength(4);
      expect(report.phases[0]?.error).toContain("Repair attempts: 4/4");
      expect(report.phases[0]?.error).toContain("maximum number of repair attempts");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("does not spend another validation on a repair that changed no files", async () => {
    const workspaceRoot = await createWorkspace();
    let validationCount = 0;

    try {
      const report = await runGenerationPhases({
        plan,
        specification: "Build a frontend application.",
        workspaceRoot,
        executeTask: async (context) => ({
          taskId: context.task.id,
          status: "completed",
          changedFiles: [],
          summary: "Generated files.",
        }),
        validateTask: async () => {
          validationCount += 1;
          return {
            passed: false,
            summary: "Typecheck failed.",
            command: "npm run typecheck",
            stderr: "Persistent type error",
          };
        },
        repairTask: async () => ({
          taskId: "foundation",
          status: "fixed",
          rootCause: "No concrete fix was found.",
          changedFiles: [],
          summary: "No files changed.",
          nextValidation: "npm run typecheck",
        }),
      });

      expect(report.status).toBe("blocked");
      expect(validationCount).toBe(1);
      expect(report.phases[0]?.repairAttempts).toHaveLength(1);
      expect(report.phases[0]?.repairAttempts?.[0]?.status).toBe("unresolved");
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("runs the final reviewer only after all phases pass", async () => {
    const workspaceRoot = await createWorkspace();
    const events: string[] = [];
    let reviewedReportStatus: string | undefined;
    let reviewedPhaseCount = 0;

    try {
      const report = await runGenerationPhases({
        plan,
        specification: "Build a frontend application.",
        workspaceRoot,
        executeTask: async (context) => ({
          taskId: context.task.id,
          status: "completed",
          changedFiles: context.task.files,
          summary: `Generated ${context.task.id}.`,
        }),
        validateTask: async (context) => ({
          passed: true,
          summary: `Validated ${context.task.id}.`,
        }),
        finalReviewer: async (context) => {
          reviewedReportStatus = context.orchestrationReport.status;
          reviewedPhaseCount = context.orchestrationReport.phases.length;
          return {
            requirements: [
              {
                requirement: "The application meets the specification.",
                status: "passed",
                evidence: "All generation phases passed validation.",
              },
            ],
            warnings: [],
            recommendation: "ready",
          };
        },
        onEvent: (event) => {
          events.push(event.type);
        },
      });

      expect(report.status).toBe("completed");
      expect(report.review?.recommendation).toBe("ready");
      expect(reviewedReportStatus).toBe("completed");
      expect(reviewedPhaseCount).toBe(2);
      expect(events).toContain("review_started");
      expect(events).toContain("review_completed");
      expect(events.indexOf("review_started")).toBeGreaterThan(
        events.indexOf("validation_completed"),
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});
