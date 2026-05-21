import fs from "node:fs";
import OpenAI, { toFile } from "openai";
import { Buffer } from "node:buffer";

if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
  console.warn(
    "[integrations-openai-image] AI_INTEGRATIONS_OPENAI_BASE_URL not set — image AI features will be unavailable.",
  );
}

if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  console.warn(
    "[integrations-openai-image] AI_INTEGRATIONS_OPENAI_API_KEY not set — image AI features will be unavailable.",
  );
}

const openaiClient: OpenAI | null =
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL && process.env.AI_INTEGRATIONS_OPENAI_API_KEY
    ? new OpenAI({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      })
    : null;

export const openai = openaiClient;


export async function generateImageBuffer(
  prompt: string,
  size: "1024x1024" | "512x512" | "256x256" = "1024x1024"
): Promise<Buffer> {
  if (!openai) {
    throw new Error("OpenAI is not initialized. Please configure AI_INTEGRATIONS_OPENAI_BASE_URL and AI_INTEGRATIONS_OPENAI_API_KEY.");
  }
  const response = await openai.images.generate({
    model: "gpt-image-1",
    prompt,
    size,
  });
  const base64 = response.data?.[0]?.b64_json ?? "";
  return Buffer.from(base64, "base64");
}

export async function editImages(
  imageFiles: string[],
  prompt: string,
  outputPath?: string
): Promise<Buffer> {
  const images = await Promise.all(
    imageFiles.map((file) =>
      toFile(fs.createReadStream(file), file, {
        type: "image/png",
      })
    )
  );

  if (!openai) {
    throw new Error("OpenAI is not initialized. Please configure AI_INTEGRATIONS_OPENAI_BASE_URL and AI_INTEGRATIONS_OPENAI_API_KEY.");
  }
  const response = await openai.images.edit({
    model: "gpt-image-1",
    image: images,
    prompt,
  });

  const imageBase64 = response.data?.[0]?.b64_json ?? "";
  const imageBytes = Buffer.from(imageBase64, "base64");

  if (outputPath) {
    fs.writeFileSync(outputPath, imageBytes);
  }

  return imageBytes;
}
