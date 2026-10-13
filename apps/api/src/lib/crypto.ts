import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

export const sha256Hex = (input: string): string =>
  createHash("sha256").update(input).digest("hex");

export const sha256Base64Url = (input: string): string =>
  createHash("sha256").update(input).digest("base64url");

export const hmacBase64Url = (secret: string, input: string): string =>
  createHmac("sha256", secret).update(input).digest("base64url");

/** 長度不同時也以固定時間回傳 false */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** `<base64url(json)>.<hmac>`：給 OAuth state cookie 用 */
export function signPayload(secret: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmacBase64Url(secret, body)}`;
}

export function verifyPayload(secret: string, token: string): unknown {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(mac, hmacBase64Url(secret, body))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
