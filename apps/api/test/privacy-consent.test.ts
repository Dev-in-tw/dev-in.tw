import { CURRENT_LEGAL_VERSIONS } from "@dit/contract";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GithubIdentity } from "../src/adapters/github/client.ts";
import { githubLogin, login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

const identity = (id: number, login: string): GithubIdentity => ({
  id,
  login,
  name: null,
  avatarUrl: `https://avatars.githubusercontent.com/u/${id}?v=4`,
  createdAt: new Date("2019-01-01T00:00:00Z"),
  email: `${login}@example.com`,
});

/** 服務條款第 1 條：首次登入與申請子網域時同意；條款改版後要重新同意 */
describe.skipIf(!pgAvailable)("legal consent records (real PostgreSQL)", () => {
  let t: TestContext;
  let n = 0;

  const consents = async (login: string) =>
    t.deps.sql`
      select c.terms_version, c.privacy_version, c.context
        from legal_consents c join users u on u.id = c.user_id
       where u.github_login = ${login} order by c.seq`;
  const me = async (cookie: string) =>
    (await (await request(t, "GET", "/api/v1/me", { cookie })).json()) as Record<string, unknown>;
  const makeStale = (login: string) =>
    t.deps.sql`
      update legal_consents set terms_version = '0.9', privacy_version = '0.9'
       where user_id = (select id from users where github_login = ${login})`;
  const apply = (cookie: string, name: string, extra: Record<string, unknown> = {}) =>
    request(t, "POST", "/api/v1/subdomains", {
      cookie,
      body: { name, description: "", acceptTerms: true, turnstileToken: "pass", ...extra },
    });

  beforeAll(async () => {
    t = await setupTestApp();
  });
  beforeEach(() => {
    t.clock.advance(86_400_000);
  });
  afterAll(() => t.close());

  it("records the versions shown on the login page at the first GitHub login", async () => {
    const cookie = await githubLogin(t, identity(700_001, "first-login"), CURRENT_LEGAL_VERSIONS);
    expect(await consents("first-login")).toEqual([
      {
        terms_version: CURRENT_LEGAL_VERSIONS.termsVersion,
        privacy_version: CURRENT_LEGAL_VERSIONS.privacyVersion,
        context: "login",
      },
    ]);
    const body = await me(cookie);
    expect(body.consentRequired).toBe(false);
    expect(body.consent).toMatchObject(CURRENT_LEGAL_VERSIONS);
    const [audit] = await t.deps.sql`
      select metadata from audit_logs where action = 'auth.login'
         and target_label = 'first-login'`;
    expect(audit?.metadata).toMatchObject({ method: "github", consent: CURRENT_LEGAL_VERSIONS });

    // 再次登入不會重複記錄
    await githubLogin(t, identity(700_001, "first-login"), CURRENT_LEGAL_VERSIONS);
    expect(await consents("first-login")).toHaveLength(1);
  });

  it("does not record consent for outdated or missing versions at login", async () => {
    const stale = await githubLogin(t, identity(700_002, "old-page"), {
      termsVersion: "0.9",
      privacyVersion: "0.9",
    });
    expect(await consents("old-page")).toEqual([]);
    expect(await me(stale)).toMatchObject({ consent: null, consentRequired: true });

    const bare = await githubLogin(t, identity(700_003, "no-versions"));
    expect(await consents("no-versions")).toEqual([]);
    expect((await me(bare)).consentRequired).toBe(true);
  });

  it("asks existing users to consent again instead of recording it at login", async () => {
    const cookie = await githubLogin(t, identity(700_004, "returning"), CURRENT_LEGAL_VERSIONS);
    await makeStale("returning");
    await githubLogin(t, identity(700_004, "returning"), CURRENT_LEGAL_VERSIONS);
    expect(await consents("returning")).toHaveLength(1);
    expect((await me(cookie)).consentRequired).toBe(true);

    const ok = await request(t, "POST", "/api/v1/me/consent", {
      cookie,
      body: CURRENT_LEGAL_VERSIONS,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject(CURRENT_LEGAL_VERSIONS);
    expect((await consents("returning")).at(-1)).toMatchObject({ context: "prompt" });
    expect((await me(cookie)).consentRequired).toBe(false);
    const [audit] = await t.deps.sql`
      select metadata from audit_logs where action = 'legal.accept' and target_label = 'returning'`;
    expect(audit?.metadata).toMatchObject({ ...CURRENT_LEGAL_VERSIONS, context: "prompt" });
  });

  it("rejects consent to versions that are not current", async () => {
    const cookie = await login(t, "picky");
    const res = await request(t, "POST", "/api/v1/me/consent", {
      cookie,
      body: { termsVersion: "0.9", privacyVersion: CURRENT_LEGAL_VERSIONS.privacyVersion },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CONSENT_REQUIRED" });
  });

  it("records consent when applying for a subdomain", async () => {
    n++;
    const who = `applicant-${n}`;
    const cookie = await login(t, who);
    const res = await apply(cookie, `apply-${n}`, CURRENT_LEGAL_VERSIONS);
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await consents(who)).map((c) => c.context)).toEqual(["login", "subdomain_create"]);
    const [audit] = await t.deps.sql`
      select metadata from audit_logs where action = 'subdomain.create' and target_label = ${`apply-${n}.dev-in.tw`}`;
    expect(audit?.metadata).toMatchObject(CURRENT_LEGAL_VERSIONS);
  });

  it("blocks applications until the user agrees to the current versions", async () => {
    n++;
    const who = `stale-${n}`;
    const cookie = await login(t, who);
    await makeStale(who);

    const silent = await apply(cookie, `stale-a-${n}`);
    expect(silent.status).toBe(409);
    expect(await silent.json()).toMatchObject({ code: "CONSENT_REQUIRED" });

    const oldForm = await apply(cookie, `stale-b-${n}`, {
      termsVersion: "0.9",
      privacyVersion: "0.9",
    });
    expect(oldForm.status).toBe(409);
    expect(await t.deps.sql`select 1 from subdomains where name like ${`stale-_-${n}`}`).toEqual(
      [],
    );

    // 表單勾選目前版本就可以申請（同時記錄同意）
    const fresh = await apply(cookie, `stale-c-${n}`, CURRENT_LEGAL_VERSIONS);
    expect(fresh.status).toBe(201);
    expect((await me(cookie)).consentRequired).toBe(false);

    // 之後沒帶版本也行（最近一次同意是目前版本）
    const later = await apply(cookie, `stale-d-${n}`);
    expect(later.status).toBe(201);
  });

  it("deletes consent records together with the account", async () => {
    const cookie = await login(t, "leaver");
    const del = await request(t, "DELETE", "/api/v1/me", { cookie, body: { confirm: "leaver" } });
    expect(del.status).toBe(202);
    const { runHousekeeping } = await import("../src/modules/housekeeping.ts");
    await runHousekeeping(t.deps);
    expect(await consents("leaver")).toEqual([]);
    expect(await t.deps.sql`select 1 from users where github_login = 'leaver'`).toEqual([]);
  });
});
