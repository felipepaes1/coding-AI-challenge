import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const promptNames = [
  "agent-instructions.md",
  "planner-instructions.md",
  "generator-instructions.md",
  "repair-instructions.md",
  "reviewer-instructions.md",
];

const referenceApplicationTerms = [
  "car inventory",
  "getcars",
  "getcar",
  "addcar",
  "usecars",
  "usecarfilters",
];

describe("runtime prompts and sample specification", () => {
  it("keeps reference-application requirements out of permanent prompts", async () => {
    for (const promptName of promptNames) {
      const prompt = await readFile(
        resolve(process.cwd(), "prompts", promptName),
        "utf8",
      );
      const normalizedPrompt = prompt.toLowerCase();

      for (const term of referenceApplicationTerms) {
        expect(normalizedPrompt, `${promptName} contains ${term}`).not.toContain(term);
      }
    }
  });

  it("keeps task ownership, existing test patterns, and UI quality explicit", async () => {
    const planner = await readFile(resolve(process.cwd(), "prompts", "planner-instructions.md"), "utf8");
    const generator = await readFile(resolve(process.cwd(), "prompts", "generator-instructions.md"), "utf8");
    const repair = await readFile(resolve(process.cwd(), "prompts", "repair-instructions.md"), "utf8");

    expect(planner).toContain("existing test harness");
    expect(planner).toContain("clear hierarchy");
    expect(generator).toContain("CURRENT_TASK.files");
    expect(generator).toContain("visual quality");
    expect(repair).toContain("Only edit files listed in `CURRENT_TASK.files`");
    expect(repair).toContain("Do not change production clients");
  });

  it("keeps required, optional, and extra work explicit in the replaceable sample", async () => {
    const sample = await readFile(
      resolve(process.cwd(), "specs", "sample-spec.txt"),
      "utf8",
    );

    expect(sample).toContain("can be replaced");
    expect(sample).toContain("Required Application Specifications");
    expect(sample).toContain("Optional Application Specifications");
    expect(sample).toContain("Optional Extras");
    expect(sample).toContain("GetCars");
    expect(sample).toContain("useCars()");
  });
});
