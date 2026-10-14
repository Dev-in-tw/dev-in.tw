import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiscordNotifier } from "../src/adapters/discord/notifier.ts";
import { createLogger } from "../src/lib/logger.ts";
import { claim, login, request, setupTestApp, type TestContext } from "./helpers/app.ts";
import { pgAvailable } from "./helpers/db.ts";

/** 收集 pino 的 JSON 輸出 */
function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, done) {
      lines.push(...String(chunk).split("\n").filter(Boolean));
      done();
    },
  });
  return { lines, logger: createLogger("debug", stream) };
}

describe("logger redaction", () => {
  it("censors emails, raw IPs, cookies and tokens even if code forgets to leave them out", () => {
    const { lines, logger } = capture();
    logger.info(
      {
        email: "a@example.com",
        contactEmail: "b@example.com",
        ip: "203.0.113.5",
        clientIp: "203.0.113.6",
        cookie: "__Host-dit_session=abc",
        token: "secret",
        user: { email: "c@example.com", ip: "203.0.113.7" },
        ip_hash: "0123456789abcdef",
      },
      "hello",
    );
    const text = lines.join("\n");
    expect(text).not.toMatch(/@example\.com|203\.0\.113\.\d|dit_session=abc|"secret"/);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      email: "[redacted]",
      ip: "[redacted]",
      ip_hash: "0123456789abcdef",
    });
  });
});

/** 隱私權政策第 2、6、10 條：日誌只有加鹽雜湊的 IP，Discord 告警不含 email 與 IP */
describe.skipIf(!pgAvailable)("logs and alerts carry no email or raw IP (real PostgreSQL)", () => {
  let t: TestContext;
  const out = capture();

  beforeAll(async () => {
    t = await setupTestApp({ logger: out.logger });
  });
  afterAll(() => t.close());

  it("request logs carry only a hashed IP", async () => {
    const cookie = await login(t, "log-alice", { ip: "203.0.113.200" });
    await t.deps
      .sql`update users set email = 'log-alice@example.com' where github_login = 'log-alice'`;
    await request(t, "GET", "/api/v1/me", { cookie, ip: "203.0.113.200" });
    await request(t, "GET", "/api/v1/me/export", { cookie, ip: "203.0.113.200" });
    const http = out.lines.map((l) => JSON.parse(l)).filter((l) => l.evt === "http");
    expect(http.length).toBeGreaterThanOrEqual(3);
    for (const line of http) expect(line.ip_hash).toMatch(/^[0-9a-f]{16}$/);
    const text = out.lines.join("\n");
    expect(text).not.toContain("203.0.113.200");
    expect(text).not.toContain("log-alice@example.com");
  });

  it("report and review alerts carry no email or IP", async () => {
    t.notifier.sent.length = 0;
    const report = await request(t, "POST", "/api/v1/reports", {
      ip: "198.51.100.42",
      body: {
        subdomain: "evil-site",
        category: "phishing",
        details: "這個網站假冒銀行登入頁面，要求輸入網銀帳號密碼",
        contactEmail: "witness@example.com",
        turnstileToken: "pass",
      },
    });
    expect(report.status).toBe(201);
    const young = await login(t, "young-account", { githubAgeDays: 3 });
    await t.deps
      .sql`update users set email = 'young@example.com' where github_login = 'young-account'`;
    await claim(t, young, "needs-review");

    expect(t.notifier.sent.map((a) => a.title)).toEqual(
      expect.arrayContaining(["新的檢舉", "新的待審子網域"]),
    );
    for (const alert of t.notifier.sent) {
      const payload = JSON.stringify(DiscordNotifier.payload(alert));
      expect(payload).not.toMatch(/@example\.com/);
      expect(payload).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    }
    expect(out.lines.join("\n")).not.toContain("198.51.100.42");
    expect(out.lines.join("\n")).not.toContain("witness@example.com");
  });
});
