import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDohResolver } from "../src/adapters/doh/client.ts";
import { encodeQuery } from "../src/adapters/doh/dns-wire.ts";
import {
  DANGLING_ACTION,
  platformOf,
  scanDanglingCnames,
} from "../src/modules/takeover/dangling.ts";
import { claim, login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/** 2026-10 安全稽核（docs/security/AUDIT-2026-10.md）的回歸測試：dangling CNAME 接管偵測 */

describe("platform classification", () => {
  it("names well-known hosting platforms", () => {
    expect(platformOf("alice.github.io")).toBe("GitHub Pages");
    expect(platformOf("old-app.azurewebsites.net")).toBe("Azure App Service");
    expect(platformOf("bucket.s3-website.ap-northeast-1.amazonaws.com")).toBe("AWS");
    expect(platformOf("example.com")).toBeNull();
    expect(platformOf("notgithub.io")).toBeNull();
  });
});

describe("DoH client", () => {
  it("flags NXDOMAIN and refuses to follow redirects", async () => {
    let init: RequestInit | undefined;
    // 最小的 NXDOMAIN 回應：header（rcode=3）+ 原本的 question
    const query = encodeQuery("gone.example.net", "A", 0);
    const answer = new Uint8Array(query);
    answer[2] = 0x81;
    answer[3] = 0x83;
    const doh = createDohResolver({
      fetch: async (_url, i) => {
        init = i;
        return new Response(answer, { headers: { "content-type": "application/dns-message" } });
      },
    });
    const result = await doh.query("cloudflare", "gone.example.net", "A");
    expect(result).toMatchObject({ answers: [], error: null, nxdomain: true });
    expect(init?.redirect).toBe("error");
  });
});

describe.skipIf(!pgAvailable)("dangling CNAME scan", () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await setupTestApp();
  });
  afterAll(() => t.close());

  it("records an owner-visible audit event and alerts admins once per week", async () => {
    const cookie = await login(t, "dangle-alice");
    await claim(t, cookie, "dangle-alice");
    for (const [name, target] of [
      ["www", "old-app.azurewebsites.net"],
      ["blog", "still-here.example.net"],
      ["flaky", "flaky.example.net"],
    ] as const) {
      const res = await request(t, "POST", "/api/v1/subdomains/dangle-alice/records", {
        cookie,
        body: { type: "CNAME", name, ttl: 1, target },
      });
      expect(res.status).toBe(202);
    }
    await t.worker.drain();
    t.doh.nxdomain.add("*|old-app.azurewebsites.net");
    // 只有一個 resolver 回 NXDOMAIN：不算（避免單一 resolver 出錯造成誤報）
    t.doh.nxdomain.add("cloudflare|flaky.example.net");

    const first = await scanDanglingCnames(t.deps);
    expect(first).toMatchObject({ targets: 3, dangling: 1, notified: 1 });
    expect(t.notifier.sent.at(-1)).toMatchObject({
      key: expect.stringMatching(/^dangling:/),
      description: expect.stringContaining("www.dangle-alice.dev-in.tw"),
    });

    const activity = (await (
      await request(t, "GET", "/api/v1/subdomains/dangle-alice/activity", { cookie })
    ).json()) as { items: { action: string; metadata: Record<string, unknown> }[] };
    const event = activity.items.find((e) => e.action === DANGLING_ACTION);
    expect(event?.metadata).toMatchObject({
      target: "old-app.azurewebsites.net",
      platform: "Azure App Service",
    });

    const again = await scanDanglingCnames(t.deps);
    expect(again).toMatchObject({ dangling: 1, notified: 0 });
  });
});
