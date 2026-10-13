import {
  ApiError,
  type Endpoint,
  type EndpointName,
  ERROR_STATUS,
  type ErrorCode,
  endpoints,
  Problem,
  type RequestOf,
  type ResponseOf,
} from "@dit/contract";
import { requests } from "@dit/contract/fixtures";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contractClient, login, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/**
 * 合約一致性（PLAN §3.12、§5.2）：用合約的 typed client（validateResponses: true）把每一個端點都打一次，
 * 回應必須能被 response schema parse；錯誤回應必須是合法的 Problem、狀態碼等於 ERROR_STATUS[code]，
 * 而且 code 必須列在該端點的 errors 或下面的中介層層級錯誤裡。
 */
function implicitErrors(ep: Endpoint): Set<ErrorCode> {
  const codes = new Set<ErrorCode>(["INTERNAL", "RATE_LIMITED"]);
  if (ep.method !== "GET") codes.add("CSRF_REJECTED");
  if (ep.body || ep.query || ep.headers?.length) codes.add("VALIDATION_FAILED");
  if (ep.auth !== "public") {
    codes.add("UNAUTHENTICATED");
    codes.add("ACCOUNT_SUSPENDED");
  }
  if (ep.params || ep.auth === "admin") codes.add("NOT_FOUND");
  return codes;
}

describe.skipIf(!pgAvailable)("contract consistency", () => {
  let t: TestContext;
  const called = new Set<EndpointName>();
  const errorsSeen: { name: EndpointName; code: ErrorCode }[] = [];
  let cookies: Record<string, string>;

  const as = (who: string) => {
    const client = contractClient(t, cookies[who]);
    return async <N extends EndpointName>(name: N, req?: RequestOf<N>): Promise<ResponseOf<N>> => {
      called.add(name);
      try {
        return await client(name, req);
      } catch (error) {
        if (error instanceof ApiError) {
          const ep: Endpoint = endpoints[name];
          expect(Problem.safeParse(error.problem).success).toBe(true);
          expect(error.problem.status).toBe(ERROR_STATUS[error.code]);
          const allowed = new Set([...ep.errors, ...implicitErrors(ep)]);
          expect(allowed.has(error.code), `${name} returned ${error.code}`).toBe(true);
          errorsSeen.push({ name, code: error.code });
        }
        throw error;
      }
    };
  };
  const expectCode = async (promise: Promise<unknown>, code: ErrorCode) => {
    await expect(promise).rejects.toMatchObject({ problem: { code } });
  };

  beforeAll(async () => {
    t = await setupTestApp();
    cookies = {
      alice: await login(t, "alice"),
      bob: await login(t, "bob-dev"),
      carol: await login(t, "carol", { githubAgeDays: 3 }),
      admin: await login(t, "HACO8888", { role: "admin" }),
    };
  });
  afterAll(() => t.close());

  it("public endpoints", async () => {
    const anon = as("nobody");
    const meta = await anon("getMeta");
    expect(meta.limits).toMatchObject({ subdomainsPerUser: 2, recordsPerSubdomain: 10 });
    await anon("getStats");
    await anon("getStatus");
    await anon("listDirectory", { query: { limit: 5 } });
    expect((await anon("checkAvailability", { params: { name: "alice-blog" } })).status).toBe(
      "available",
    );
    expect((await anon("checkAvailability", { params: { name: "Bad_Name" } })).status).toBe(
      "invalid",
    );
    expect((await anon("listPresets")).items).toHaveLength(10);
    await anon("createReport", { body: { ...requests.createReport, turnstileToken: "pass" } });
    await expectCode(
      anon("createReport", { body: { ...requests.createReport, turnstileToken: "nope" } }),
      "TURNSTILE_FAILED",
    );
  });

  it("auth endpoints", async () => {
    const anon = as("nobody");
    await anon("startGithubLogin", { query: { redirect: "/dashboard" } });
    await anon("githubCallback", { query: { code: "x", state: "y" } });
    await expectCode(anon("getMe"), "UNAUTHENTICATED");
  });

  it("me, subdomains, records, presets and propagation", async () => {
    const alice = as("alice");
    const me = await alice("getMe");
    expect(me.quota.subdomains).toEqual({ used: 0, limit: 2 });
    await alice("updateMe", { body: { displayName: "Alice" } });
    await alice("listSessions");
    await alice("listMyActivity", { query: { limit: 10 } });

    const body = {
      name: "alice-blog",
      description: "部落格",
      acceptTerms: true as const,
      turnstileToken: "pass",
    };
    const created = await alice("createSubdomain", {
      body,
      idempotencyKey: "0199e2a1-0000-7000-8000-000000000001",
    });
    const replay = await alice("createSubdomain", {
      body,
      idempotencyKey: "0199e2a1-0000-7000-8000-000000000001",
    });
    expect(replay).toEqual(created);
    await expectCode(
      alice("createSubdomain", {
        body: { ...body, description: "不同" },
        idempotencyKey: "0199e2a1-0000-7000-8000-000000000001",
      }),
      "IDEMPOTENCY_KEY_REUSED",
    );
    await expectCode(
      alice("createSubdomain", { body: { ...body, name: "google" } }),
      "NAME_RESERVED",
    );
    await alice("listSubdomains");
    await alice("getSubdomain", { params: { name: "alice-blog" } });
    await alice("updateSubdomain", {
      params: { name: "alice-blog" },
      body: { showInDirectory: true },
    });
    await alice("listSubdomainActivity", { params: { name: "alice-blog" }, query: {} });

    const record = await alice("createRecord", {
      params: { name: "alice-blog" },
      body: { type: "A", name: "@", ttl: 300, address: "185.199.108.153" },
      idempotencyKey: "rec-0001-alice",
    });
    await expectCode(
      alice("createRecord", {
        params: { name: "alice-blog" },
        body: { type: "A", name: "lan", ttl: 300, address: "10.0.0.1" },
      }),
      "IP_NOT_PUBLIC",
    );
    await t.worker.drain();
    const list = await alice("listRecords", { params: { name: "alice-blog" } });
    expect(list.items[0]?.syncStatus).toBe("synced");
    const replaced = await alice("replaceRecord", {
      params: { name: "alice-blog", recordId: record.id },
      body: { type: "A", name: "@", ttl: 300, address: "185.199.109.153" },
      ifMatch: record.version,
    });
    await expectCode(
      alice("replaceRecord", {
        params: { name: "alice-blog", recordId: record.id },
        body: { type: "A", name: "@", ttl: 300, address: "185.199.110.153" },
        ifMatch: record.version,
      }),
      "VERSION_CONFLICT",
    );
    await alice("retryRecordSync", { params: { name: "alice-blog", recordId: record.id } });
    await t.worker.drain();
    t.doh.answers.set("alice-blog.dev-in.tw|A", ["185.199.109.153"]);
    const propagation = await alice("getPropagation", {
      params: { name: "alice-blog" },
      query: { type: "A" },
    });
    expect(propagation.resolvers).toHaveLength(4);
    expect(propagation.resolvers.every((r) => r.matches)).toBe(true);

    const plan = await alice("planPreset", {
      params: { name: "alice-blog", presetId: "github-pages" },
      body: { params: { githubUser: "alice" } },
    });
    expect(plan.creates[0]).toMatchObject({ type: "CNAME", name: "@", target: "alice.github.io" });
    expect(plan.deletes.map((d) => d.id)).toEqual([replaced.id]);
    const applied = await alice("applyPreset", {
      params: { name: "alice-blog", presetId: "github-pages" },
      body: { params: { githubUser: "alice" } },
      idempotencyKey: "preset-0001-alice",
    });
    expect(applied.deletedIds).toEqual([replaced.id]);
    await t.worker.drain();
    const txt = await alice("createRecord", {
      params: { name: "alice-blog" },
      body: { type: "TXT", name: "_verify", ttl: 1, value: "hello" },
    });
    await alice("deleteRecord", {
      params: { name: "alice-blog", recordId: txt.id },
      ifMatch: txt.version,
    });
    await t.worker.drain();
    const after = await alice("listRecords", { params: { name: "alice-blog" } });
    expect(after.items.map((r) => r.type)).toEqual(["CNAME"]);
    await expectCode(alice("getSubdomain", { params: { name: "nobody-here" } }), "NOT_FOUND");
  });

  it("transfers", async () => {
    const alice = as("alice");
    const bob = as("bob");
    await alice("createSubdomain", {
      body: { name: "alice-gift", description: "", acceptTerms: true, turnstileToken: "pass" },
    });
    const t1 = await alice("createTransfer", {
      params: { name: "alice-gift" },
      body: { toGithubLogin: "bob-dev" },
    });
    await expectCode(
      alice("createTransfer", {
        params: { name: "alice-gift" },
        body: { toGithubLogin: "bob-dev" },
      }),
      "TRANSFER_ALREADY_PENDING",
    );
    expect((await bob("listTransfers")).incoming).toHaveLength(1);
    await bob("declineTransfer", { params: { transferId: t1.id } });
    await expectCode(
      bob("acceptTransfer", { params: { transferId: t1.id } }),
      "TRANSFER_INVALID_STATE",
    );
    const t2 = await alice("createTransfer", {
      params: { name: "alice-gift" },
      body: { toGithubLogin: "bob-dev" },
    });
    await alice("cancelTransfer", { params: { transferId: t2.id } });
    const t3 = await alice("createTransfer", {
      params: { name: "alice-gift" },
      body: { toGithubLogin: "bob-dev", keepRecords: false },
    });
    const accepted = await bob("acceptTransfer", { params: { transferId: t3.id } });
    expect(accepted.status).toBe("accepted");
    await bob("getSubdomain", { params: { name: "alice-gift" } });
    await expectCode(alice("getSubdomain", { params: { name: "alice-gift" } }), "NOT_FOUND");
    await expectCode(
      alice("createTransfer", { params: { name: "alice-blog" }, body: { toGithubLogin: "ghost" } }),
      "TRANSFER_RECIPIENT_NOT_FOUND",
    );
  });

  it("admin endpoints", async () => {
    const admin = as("admin");
    const carol = as("carol");
    const pending = await carol("createSubdomain", {
      body: { name: "carol-site", description: "", acceptTerms: true, turnstileToken: "pass" },
    });
    expect(pending.status).toBe("pending_review");
    expect(pending.reviewReasons).toContain("account_too_new");
    await carol("createSubdomain", {
      body: { name: "carol-two", description: "", acceptTerms: true, turnstileToken: "pass" },
    });
    await expectCode(as("alice")("adminOverview"), "NOT_FOUND");

    const overview = await admin("adminOverview");
    expect(overview.pendingReview).toBe(2);
    const users = await admin("adminListUsers", { query: { q: "carol" } });
    const carolId = users.items[0]?.id as string;
    await admin("adminUpdateUser", {
      params: { userId: carolId },
      body: { quotaOverride: { subdomains: 3, recordsPerSubdomain: null } },
    });
    await admin("adminListSubdomains", { query: { status: "pending_review" } });
    await admin("adminApproveSubdomain", { params: { name: "carol-site" }, body: {} });
    await admin("adminRejectSubdomain", {
      params: { name: "carol-two" },
      body: { reason: "名稱不適當" },
    });
    await expectCode(
      admin("adminRejectSubdomain", { params: { name: "carol-site" }, body: { reason: "x" } }),
      "SUBDOMAIN_NOT_ACTIVE",
    );
    await admin("adminSuspendSubdomain", {
      params: { name: "carol-site" },
      body: { reason: "釣魚" },
    });
    await admin("adminUnsuspendSubdomain", { params: { name: "carol-site" }, body: {} });
    const reports = await admin("adminListReports", { query: { status: "open" } });
    await admin("adminResolveReport", {
      params: { reportId: reports.items[0]?.id as string },
      body: { status: "dismissed", resolutionNote: "誤報" },
    });
    await admin("adminListReserved", { query: { category: "brand", limit: 5 } });
    await admin("adminAddReserved", {
      body: { name: "dit-reserved", category: "system", note: "test" },
    });
    await admin("adminRemoveReserved", { params: { name: "dit-reserved" } });
    await admin("adminAuditLog", { query: { action: "subdomain.create" } });
    await admin("adminZone");
    await admin("adminReconcile", { query: {} });
    await Promise.all([...t.deps.runtime.background]);
    await admin("adminGetSettings");
    await admin("adminUpdateSettings", { body: { reviewMode: "risk" } });
  });

  it("sessions, events, release, logout and account deletion", async () => {
    const second = await login(t, "alice");
    const alice = as("alice");
    const sessions = await alice("listSessions");
    expect(sessions.items.length).toBeGreaterThanOrEqual(2);
    const other = sessions.items.find((s) => !s.current);
    await alice("revokeSession", { params: { sessionId: other?.id as string } });
    await alice("revokeOtherSessions");
    await expectCode(contractClient(t, second)("getMe"), "UNAUTHENTICATED");
    await alice("events");
    await expectCode(
      alice("releaseSubdomain", { params: { name: "alice-blog" }, body: { confirm: "wrong" } }),
      "CONFIRMATION_MISMATCH",
    );
    const released = await alice("releaseSubdomain", {
      params: { name: "alice-blog" },
      body: { confirm: "alice-blog" },
    });
    expect(released.status).toBe("releasing");
    await alice("logout");
    await expectCode(alice("getMe"), "UNAUTHENTICATED");

    const bob = as("bob");
    await expectCode(bob("deleteMe", { body: { confirm: "nope" } }), "CONFIRMATION_MISMATCH");
    await bob("deleteMe", { body: { confirm: "bob-dev" } });
    await expectCode(bob("getMe"), "UNAUTHENTICATED");
    await as("nobody")("devLogin", { body: { githubLogin: "dave" } });
  });

  it("exercised every endpoint in the contract", () => {
    expect([...called].sort()).toEqual(Object.keys(endpoints).sort());
    expect(errorsSeen.length).toBeGreaterThan(10);
  });
});
