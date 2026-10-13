import { eq, sql } from "drizzle-orm";
import type { GithubIdentity } from "../../adapters/github/client.ts";
import type { Config } from "../../config.ts";
import type { Executor } from "../../db/client.ts";
import { type UserRow, users } from "../../db/schema.ts";
import { DAY } from "../../lib/clock.ts";
import { sha256Hex } from "../../lib/crypto.ts";
import { uuidv7 } from "../../lib/ids.ts";

/**
 * 以 github_id upsert（login 會改名、會被回收，不能當 key）。角色在每次登入時依
 * ADMIN_GITHUB_IDS 重新決定：被移出清單的人下次登入就降回 user（PLAN §3.7）。
 */
export async function upsertGithubUser(
  ex: Executor,
  identity: GithubIdentity,
  config: Config,
  now: Date,
  roleOverride?: "user" | "admin",
): Promise<UserRow> {
  const role = roleOverride ?? (config.ADMIN_GITHUB_IDS.includes(identity.id) ? "admin" : "user");
  const [row] = await ex
    .insert(users)
    .values({
      id: uuidv7(now.getTime()),
      githubId: identity.id,
      githubLogin: identity.login,
      displayName: identity.name,
      avatarUrl: identity.avatarUrl,
      email: identity.email,
      githubCreatedAt: identity.createdAt,
      role,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: users.githubId,
      set: {
        githubLogin: identity.login,
        avatarUrl: identity.avatarUrl,
        email: identity.email,
        githubCreatedAt: identity.createdAt,
        role,
        lastLoginAt: now,
        updatedAt: now,
        // 申請刪除後又登入：取消刪除
        deletionRequestedAt: null,
      },
    })
    .returning();
  if (!row) throw new Error("user upsert returned no row");
  return row;
}

/** dev 登入用的假 GitHub 身分：同一個 login 永遠對應同一個 id（避開真實 id 的範圍） */
export function devIdentity(login: string, ageDays: number, now: Date): GithubIdentity {
  const id =
    9_000_000_000 + (Number.parseInt(sha256Hex(login.toLowerCase()).slice(0, 8), 16) % 1e9);
  return {
    id,
    login,
    name: null,
    avatarUrl: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    createdAt: new Date(now.getTime() - ageDays * DAY),
    email: null,
  };
}

export async function findUserByLogin(ex: Executor, login: string): Promise<UserRow | null> {
  const [row] = await ex
    .select()
    .from(users)
    .where(sql`${users.githubLogin} = ${login} and ${users.deletionRequestedAt} is null`)
    .orderBy(sql`${users.lastLoginAt} desc`)
    .limit(1);
  return row ?? null;
}

export async function getUser(ex: Executor, id: string): Promise<UserRow | null> {
  const [row] = await ex.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}
