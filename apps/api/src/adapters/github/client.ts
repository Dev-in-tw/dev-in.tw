import { AppError } from "../../lib/problem.ts";
import { type FetchLike, fetchWithTimeout } from "../http.ts";

export interface GithubIdentity {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  createdAt: Date;
  /** primary 且 verified 的 email；沒有就是 null */
  email: string | null;
}

export interface GithubClient {
  /** 用 code + PKCE verifier 換 access token，再讀取 /user 與 /user/emails。token 用完即丟。 */
  exchange(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<GithubIdentity>;
}

interface GithubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  created_at: string;
}

const upstream = () => new AppError("UPSTREAM_GITHUB_ERROR");

export function createGithubClient(opts: {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): GithubClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const api = async <T>(path: string, token: string): Promise<T> => {
    const res = await fetchWithTimeout(doFetch, `https://api.github.com${path}`, {
      timeoutMs,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "dev-in.tw",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) throw upstream();
    return (await res.json()) as T;
  };

  return {
    async exchange({ code, codeVerifier, redirectUri }) {
      let token: string;
      try {
        const res = await fetchWithTimeout(doFetch, "https://github.com/login/oauth/access_token", {
          method: "POST",
          timeoutMs,
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: opts.clientId,
            client_secret: opts.clientSecret,
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          }),
        });
        const body = (await res.json()) as { access_token?: string; error?: string };
        if (!res.ok || !body.access_token) throw upstream();
        token = body.access_token;
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw upstream();
      }
      try {
        const [user, emails] = await Promise.all([
          api<GithubUser>("/user", token),
          api<{ email: string; primary: boolean; verified: boolean }[]>(
            "/user/emails",
            token,
          ).catch(() => []),
        ]);
        const primary = emails.find((e) => e.primary && e.verified);
        return {
          id: user.id,
          login: user.login,
          name: user.name,
          avatarUrl: user.avatar_url,
          createdAt: new Date(user.created_at),
          email: primary?.email ?? null,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw upstream();
      }
    },
  };
}

/** GITHUB_CLIENT_ID 未設定時（只開 dev 登入的本機環境）使用 */
export const unavailableGithubClient: GithubClient = {
  exchange: () => Promise.reject(new AppError("UPSTREAM_GITHUB_ERROR", "GitHub 登入尚未設定")),
};
