import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import { projectRoot } from "./workspace.js";

export type AgentEnvironment = {
  envPath: string;
  envFileExists: boolean;
  hasOpenAIKey: boolean;
  model?: string;
};

export async function loadAgentEnvironment(): Promise<AgentEnvironment> {
  const envPath = resolve(projectRoot, ".env");
  const envFileExists = await access(envPath).then(() => true).catch(() => false);

  if (envFileExists) {
    config({ path: envPath, override: false, quiet: true });
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const model = process.env.OPENAI_MODEL?.trim();

  return {
    envPath,
    envFileExists,
    hasOpenAIKey: Boolean(apiKey),
    ...(model ? { model } : {}),
  };
}
