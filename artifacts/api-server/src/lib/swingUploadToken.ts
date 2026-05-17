import { createHmac, timingSafeEqual } from "crypto";

function getSecret(): string {
  const s = process.env["SWING_UPLOAD_TOKEN_SECRET"] ?? process.env["SESSION_SECRET"] ?? process.env["PRIVATE_OBJECT_DIR"];
  if (!s) throw new Error("SWING_UPLOAD_TOKEN_SECRET (or SESSION_SECRET) is required to sign swing-video upload tokens");
  return s;
}

export function signSwingUpload(objectPath: string, userId: number, exp: number): string {
  return createHmac("sha256", getSecret())
    .update(`swing|${userId}|${exp}|${objectPath}`)
    .digest("hex");
}

export function verifySwingUpload(
  objectPath: string,
  userId: number,
  token: unknown,
  exp: unknown,
): boolean {
  const tokenStr = typeof token === "string" ? token : "";
  const expNum = typeof exp === "number" ? exp : Number(exp ?? 0);
  if (!tokenStr || !expNum || Date.now() > expNum) return false;
  try {
    const expected = signSwingUpload(objectPath, userId, expNum);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(tokenStr, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
