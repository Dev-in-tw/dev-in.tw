import { ServerEvent } from "@dit/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runHousekeeping } from "../src/modules/housekeeping.ts";
import { claim, login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/** 讀 SSE 直到拿到符合條件的事件 */
async function readEvents(res: Response, until: (e: ServerEvent[]) => boolean, timeoutMs = 3000) {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: ServerEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (!until(events) && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now()),
      ),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let index = buffer.indexOf("\n\n");
    while (index >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = frame.split("\n").find((l) => l.startsWith("data:"));
      const name = frame.split("\n").find((l) => l.startsWith("event:"));
      if (data) {
        const event = ServerEvent.parse(JSON.parse(data.slice(5)));
        expect(name?.slice(6).trim()).toBe(event.type);
        events.push(event);
      }
      index = buffer.indexOf("\n\n");
    }
  }
  await reader.cancel();
  return events;
}

describe.skipIf(!pgAvailable)("server-sent events", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  it("streams ping, record.sync and record.deleted for the owner only", async () => {
    const cookie = await login(t, "sse-alice");
    const other = await login(t, "sse-bob");
    await claim(t, cookie, "sse-alice");
    const stream = await request(t, "GET", "/api/v1/events", { cookie });
    const otherStream = await request(t, "GET", "/api/v1/events", { cookie: other });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");

    const created = (await (
      await request(t, "POST", "/api/v1/subdomains/sse-alice/records", {
        cookie,
        body: { type: "TXT", name: "e", ttl: 1, value: "x" },
      })
    ).json()) as { id: string };
    await t.worker.drain();
    await request(t, "DELETE", `/api/v1/subdomains/sse-alice/records/${created.id}`, { cookie });
    await t.worker.drain();

    const events = await readEvents(stream, (e) => e.some((x) => x.type === "record.deleted"));
    expect(events[0]?.type).toBe("ping");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "record.sync",
        recordId: created.id,
        syncStatus: "synced",
        subdomain: "sse-alice",
      }),
    );
    expect(events).toContainEqual({
      type: "record.deleted",
      subdomain: "sse-alice",
      recordId: created.id,
    });
    const leaked = await readEvents(otherStream, () => false, 300);
    expect(leaked.every((e) => e.type === "ping")).toBe(true);
  });

  it("limits concurrent connections per user to 5 and requires a session", async () => {
    expect((await request(t, "GET", "/api/v1/events")).status).toBe(401);
    const cookie = await login(t, "sse-many");
    const open: Response[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(t, "GET", "/api/v1/events", { cookie });
      expect(res.status).toBe(200);
      await readEvents(res, (e) => e.length > 0).catch(() => {});
      open.push(res);
    }
    // 上面讀完第一個 ping 後就 cancel 了；重新開 5 條並保持
    const held: Response[] = [];
    for (let i = 0; i < 5; i++) held.push(await request(t, "GET", "/api/v1/events", { cookie }));
    await new Promise((r) => setTimeout(r, 50));
    const sixth = await request(t, "GET", "/api/v1/events", { cookie });
    expect(sixth.status).toBe(429);
    for (const res of held) await res.body?.cancel();
  });
});

describe.skipIf(!pgAvailable)("housekeeping", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  it("expires transfers, cleans sessions, keys, holds and old audit data, and finishes account deletion", async () => {
    const alice = await login(t, "hk-alice");
    const bob = await login(t, "hk-bob");
    await login(t, "hk-carol");
    await claim(t, alice, "hk-alice");
    const transfer = await request(t, "POST", "/api/v1/subdomains/hk-alice/transfer", {
      cookie: alice,
      body: { toGithubLogin: "hk-carol" },
    });
    expect(transfer.status).toBe(201);
    await request(t, "POST", "/api/v1/subdomains", {
      cookie: bob,
      body: { name: "hk-bob", acceptTerms: true, turnstileToken: "pass" },
      headers: { "Idempotency-Key": "hk-key-0001" },
    });
    await request(t, "DELETE", "/api/v1/me", { cookie: bob, body: { confirm: "hk-bob" } });
    await t.worker.drain();

    t.clock.advance(100 * 86_400_000);
    await t.deps
      .sql`update audit_logs set created_at = now() - interval '400 days' where action = 'auth.login'`;
    const result = await runHousekeeping(t.deps);
    expect(result).toMatchObject({ transfersExpired: 1, usersDeleted: 1 });
    expect(result.idempotencyKeys).toBeGreaterThanOrEqual(1);
    expect(result.nameHolds).toBeGreaterThanOrEqual(1);
    expect(result.sessions).toBeGreaterThanOrEqual(1);
    expect(result.auditDeleted).toBeGreaterThanOrEqual(2);
    const [t1] = await t.deps.sql`select status from transfers`;
    expect(t1?.status).toBe("expired");
    expect(await t.deps.sql`select 1 from users where github_login = 'hk-bob'`).toHaveLength(0);
  });
});
