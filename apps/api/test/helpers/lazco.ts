import { LazcoDnsProvider } from "../../src/adapters/lazco-dns/provider.ts";
import { systemFqdns } from "../../src/config.ts";
import { PgChangeBudget } from "../../src/sync/change-budget.ts";
import { login, setupTestApp, type TestContext } from "./app.ts";
import { FakeLazcoDns } from "./fake-lazco.ts";

export const ZONE = "zone-devin";
export const uuid = (i: number) => `0199e2a1-7c00-7a00-8000-${String(i).padStart(12, "0")}`;

export interface Lazco {
  t: TestContext;
  fake: FakeLazcoDns;
  provider: LazcoDnsProvider;
  cookie: string;
}

/** 假 Lazco DNS + DNS_PROVIDER=lazco 的完整 API（真 DB、ManualClock） */
export async function setupLazco(login_ = "lz-owner"): Promise<Lazco> {
  let fake: FakeLazcoDns | undefined;
  let provider: LazcoDnsProvider | undefined;
  const t = await setupTestApp({
    clockStart: "2026-10-14T01:00:00.000Z",
    config: {
      DNS_PROVIDER: "lazco",
      LAZCO_DNS_ZONE_ID: ZONE,
      LAZCO_DNS_TOKEN: "lz_live_test_token",
      ZONE_RECORD_LIMIT: 500,
    },
    provider: ({ db, clock, config }) => {
      fake = new FakeLazcoDns({ zoneId: ZONE, now: () => clock.now() });
      provider = new LazcoDnsProvider({
        token: fake.token,
        zoneId: ZONE,
        apiUrl: "https://api.lazco.test",
        budget: new PgChangeBudget(db, ZONE, config.LAZCO_DNS_DAILY_BATCH_BUDGET),
        protectedFqdns: systemFqdns(config),
        fetch: fake.fetch,
        now: () => clock.now(),
        sleep: async () => {},
      });
      return provider;
    },
  });
  const cookie = await login(t, login_);
  await t.deps
    .sql`update users set quota_subdomains = 100, quota_records = 50 where github_login = ${login_}`;
  return { t, fake: fake as FakeLazcoDns, provider: provider as LazcoDnsProvider, cookie };
}
