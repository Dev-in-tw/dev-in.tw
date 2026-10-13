import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claim, login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

describe.skipIf(!pgAvailable)("end-to-end flow (memory provider)", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  it("claims a subdomain, adds a record and syncs it to the provider", async () => {
    const cookie = await login(t, "alice");
    const sub = await claim(t, cookie, "alice-site");
    expect(sub.status).toBe("active");

    const created = await request(t, "POST", "/api/v1/subdomains/alice-site/records", {
      cookie,
      body: { type: "A", name: "@", ttl: 1, address: "185.199.108.153" },
    });
    expect(created.status).toBe(202);
    const record = (await created.json()) as { id: string; syncStatus: string; fqdn: string };
    expect(record.syncStatus).toBe("pending");
    expect(record.fqdn).toBe("alice-site.dev-in.tw");

    await t.worker.drain();
    const list = await request(t, "GET", "/api/v1/subdomains/alice-site/records", { cookie });
    const body = (await list.json()) as {
      items: { syncStatus: string }[];
      usage: { used: number };
    };
    expect(body.items[0]?.syncStatus).toBe("synced");
    expect(body.usage.used).toBe(1);
    const stored = [...t.provider.records.values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      fqdn: "alice-site.dev-in.tw",
      type: "A",
      content: "185.199.108.153",
      comment: `dit:${record.id}`,
    });
  });
});
