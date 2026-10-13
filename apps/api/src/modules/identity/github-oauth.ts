import type { Actor, Deps } from "../../context.ts";
import { addMs, MINUTE } from "../../lib/clock.ts";
import {
  randomToken,
  safeEqual,
  sha256Base64Url,
  signPayload,
  verifyPayload,
} from "../../lib/crypto.ts";
import { writeAudit } from "../audit/service.ts";
import { createSession } from "./sessions.ts";
import { upsertGithubUser } from "./users.ts";

export const DEFAULT_REDIRECT = "/dashboard";
const OAUTH_TTL_MS = 10 * MINUTE;

/** 只允許站內相對路徑，擋掉 //evil.com、/\evil.com 與控制字元（開放轉址防護） */
export function sanitizeRedirect(raw: string | undefined | null): string {
  if (!raw || raw.length > 200) return DEFAULT_REDIRECT;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\"))
    return DEFAULT_REDIRECT;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 刻意擋掉控制字元
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return DEFAULT_REDIRECT;
  try {
    const url = new URL(raw, "https://placeholder.invalid");
    if (url.origin !== "https://placeholder.invalid") return DEFAULT_REDIRECT;
  } catch {
    return DEFAULT_REDIRECT;
  }
  return raw;
}

interface OAuthState {
  state: string;
  verifier: string;
  redirect: string;
  exp: number;
}

export function startGithubLogin(
  deps: Pick<Deps, "config" | "clock">,
  redirect: string | undefined,
) {
  const { config } = deps;
  const payload: OAuthState = {
    state: randomToken(32),
    verifier: randomToken(32),
    redirect: sanitizeRedirect(redirect),
    exp: addMs(deps.clock.now(), OAUTH_TTL_MS).getTime(),
  };
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.GITHUB_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", config.GITHUB_REDIRECT_URI ?? "");
  url.searchParams.set("scope", "user:email");
  url.searchParams.set("state", payload.state);
  url.searchParams.set("code_challenge", sha256Base64Url(payload.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("allow_signup", "true");
  return {
    location: url.toString(),
    cookieValue: signPayload(config.SESSION_SECRET, payload),
    maxAgeSeconds: OAUTH_TTL_MS / 1000,
  };
}

export type CallbackOutcome =
  | { ok: true; location: string; sessionToken: string; userId: string }
  | { ok: false; location: string; reason: "oauth_failed" | "state_mismatch" | "suspended" };

export async function completeGithubLogin(
  deps: Deps,
  input: {
    code?: string | undefined;
    state?: string | undefined;
    error?: string | undefined;
    cookie: string | undefined;
    ip: string | null;
    userAgent: string | null;
    requestId: string;
  },
): Promise<CallbackOutcome> {
  const fail = (reason: "oauth_failed" | "state_mismatch" | "suspended") => ({
    ok: false as const,
    location: `/login?error=${reason}`,
    reason,
  });
  const now = deps.clock.now();
  const raw = input.cookie ? verifyPayload(deps.config.SESSION_SECRET, input.cookie) : null;
  const saved = raw as OAuthState | null;
  if (
    !saved ||
    typeof saved.state !== "string" ||
    typeof saved.verifier !== "string" ||
    typeof saved.exp !== "number" ||
    saved.exp < now.getTime() ||
    !input.state ||
    !safeEqual(saved.state, input.state)
  ) {
    return fail("state_mismatch");
  }
  if (input.error || !input.code) return fail("oauth_failed");

  let identity: Awaited<ReturnType<Deps["github"]["exchange"]>>;
  try {
    identity = await deps.github.exchange({
      code: input.code,
      codeVerifier: saved.verifier,
      redirectUri: deps.config.GITHUB_REDIRECT_URI ?? "",
    });
  } catch (error) {
    deps.logger.warn({ err: error, request_id: input.requestId }, "github oauth exchange failed");
    return fail("oauth_failed");
  }

  return deps.db.transaction(async (tx) => {
    const user = await upsertGithubUser(tx, identity, deps.config, now);
    if (user.status === "suspended") return fail("suspended");
    const sessionToken = await createSession(tx, {
      userId: user.id,
      ip: input.ip,
      userAgent: input.userAgent,
      now,
    });
    const actor: Actor = {
      type: "user",
      userId: user.id,
      ip: input.ip,
      requestId: input.requestId,
    };
    await writeAudit(tx, actor, {
      action: "auth.login",
      targetType: "user",
      targetId: user.id,
      targetLabel: user.githubLogin,
      metadata: { method: "github" },
    });
    return {
      ok: true as const,
      location: sanitizeRedirect(saved.redirect),
      sessionToken,
      userId: user.id,
    };
  });
}
