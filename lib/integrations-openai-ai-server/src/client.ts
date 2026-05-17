import OpenAI from "openai";

if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
  console.warn(
    "[integrations-openai] AI_INTEGRATIONS_OPENAI_BASE_URL not set — AI features will be unavailable.",
  );
}

if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  console.warn(
    "[integrations-openai] AI_INTEGRATIONS_OPENAI_API_KEY not set — AI features will be unavailable.",
  );
}

export const openai: OpenAI | null =
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY
    ? new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      })
    : null;
