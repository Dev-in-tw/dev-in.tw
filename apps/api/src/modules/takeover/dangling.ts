import { and, eq, gt, sql } from "drizzle-orm";
import { type Deps, SYSTEM_ACTOR } from "../../context.ts";
import { auditLogs, dnsRecords, subdomains } from "../../db/schema.ts";
import { DAY, HOUR } from "../../lib/clock.ts";
import { fqdnOf } from "../../sync/mapper.ts";
import { writeAudit } from "../audit/service.ts";

/** 任意固定的 advisory lock key（"dit_dng"），多個實例時只有一個在掃 */
const LOCK_KEY = "28548153004385637";
export const DANGLING_ACTION = "record.dangling_suspected";
/** 同一筆紀錄多久之內不重複通知 */
const RENOTIFY_MS = 7 * DAY;
export const DANGLING_SCAN_INTERVAL_MS = 6 * HOUR;

/**
 * 常見的託管平台。只用來在通知裡說明「這可能是哪個平台的站台被刪了」，不影響判斷。
 * 平台本身對 *.github.io、*.vercel.app 之類有萬用解析，刪掉站台後名稱仍然存在，
 * 這類接管只能靠 HTTP 指紋偵測（會變成對使用者指定主機發請求，刻意不做，見威脅模型）。
 */
const PLATFORMS: readonly [suffix: string, label: string][] = [
  ["github.io", "GitHub Pages"],
  ["vercel.app", "Vercel"],
  ["vercel-dns.com", "Vercel"],
  ["netlify.app", "Netlify"],
  ["pages.dev", "Cloudflare Pages"],
  ["herokudns.com", "Heroku"],
  ["herokuapp.com", "Heroku"],
  ["azurewebsites.net", "Azure App Service"],
  ["cloudapp.net", "Azure"],
  ["cloudapp.azure.com", "Azure"],
  ["trafficmanager.net", "Azure Traffic Manager"],
  ["blob.core.windows.net", "Azure Storage"],
  ["azureedge.net", "Azure CDN"],
  ["amazonaws.com", "AWS"],
  ["elasticbeanstalk.com", "AWS Elastic Beanstalk"],
  ["cloudfront.net", "Amazon CloudFront"],
  ["fly.dev", "Fly.io"],
  ["onrender.com", "Render"],
  ["zeabur.app", "Zeabur"],
  ["surge.sh", "Surge"],
  ["readthedocs.io", "Read the Docs"],
  ["firebaseapp.com", "Firebase"],
  ["web.app", "Firebase"],
];

export function platformOf(target: string): string | null {
  const host = target.toLowerCase();
  for (const [suffix, label] of PLATFORMS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return label;
  }
  return null;
}

export interface DanglingScanResult {
  targets: number;
  dangling: number;
  notified: number;
}

/**
 * 子網域接管偵測（PLAN §3.10）：CNAME 指向的名稱已經不存在（兩個 resolver 都回 NXDOMAIN）時，
 * 任何人只要在那個平台重新註冊同名資源就能接管使用者的子網域。偵測到時寫一筆稽核
 * （擁有者在子網域時間軸看得到）並通知管理員。只透過固定的 DoH resolver 查詢，不對使用者
 * 指定的主機發任何請求（沒有 SSRF 面）。
 */
export async function scanDanglingCnames(
  deps: Deps,
  opts: { maxTargets?: number } = {},
): Promise<DanglingScanResult | null> {
  const reserved = await deps.sql.reserve();
  try {
    const [lock] = await reserved<
      { ok: boolean }[]
    >`select pg_try_advisory_lock(${LOCK_KEY}::bigint) as ok`;
    if (!lock?.ok) return null;
    try {
      return await runScan(deps, opts.maxTargets ?? 500);
    } finally {
      await reserved`select pg_advisory_unlock(${LOCK_KEY}::bigint)`;
    }
  } finally {
    reserved.release();
  }
}

async function runScan(deps: Deps, maxTargets: number): Promise<DanglingScanResult> {
  const { db, config, clock } = deps;
  const rows = await db
    .select({ record: dnsRecords, sub: subdomains })
    .from(dnsRecords)
    .innerJoin(subdomains, eq(subdomains.id, dnsRecords.subdomainId))
    .where(
      and(
        eq(dnsRecords.type, "CNAME"),
        eq(dnsRecords.syncStatus, "synced"),
        eq(subdomains.status, "active"),
      ),
    );
  const byTarget = new Map<string, typeof rows>();
  for (const row of rows) {
    const target = String((row.record.data as { target?: unknown }).target ?? "").toLowerCase();
    if (!target) continue;
    const list = byTarget.get(target) ?? [];
    list.push(row);
    byTarget.set(target, list);
  }

  let dangling = 0;
  let notified = 0;
  const targets = [...byTarget.keys()].slice(0, maxTargets);
  for (const target of targets) {
    if (deps.runtime.stopping) break;
    // 兩個 resolver 都明確回答 NXDOMAIN 才算，逾時或 SERVFAIL 不算（避免誤報）
    const first = await deps.doh.query("cloudflare", target, "A");
    if (!first.nxdomain) continue;
    const second = await deps.doh.query("google", target, "A");
    if (!second.nxdomain) continue;

    for (const { record, sub } of byTarget.get(target) ?? []) {
      dangling++;
      const now = clock.now();
      const [recent] = await db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, DANGLING_ACTION),
            eq(auditLogs.targetId, sub.id),
            sql`${auditLogs.metadata}->>'recordId' = ${record.id}`,
            gt(auditLogs.createdAt, new Date(now.getTime() - RENOTIFY_MS)),
          ),
        )
        .limit(1);
      if (recent) continue;
      const fqdn = fqdnOf(record.name, sub.name, config.ROOT_DOMAIN);
      const platform = platformOf(target);
      await writeAudit(db, SYSTEM_ACTOR, {
        action: DANGLING_ACTION,
        targetType: "subdomain",
        targetId: sub.id,
        targetLabel: fqdn,
        metadata: { recordId: record.id, target, platform },
      });
      deps.notifier.notify({
        key: `dangling:${record.id}`,
        title: "CNAME 指向的名稱已不存在（可能被接管）",
        description: `\`${fqdn}\` → \`${target}\`${platform ? `（${platform}）` : ""}`,
        severity: "warning",
        url: `${config.APP_ORIGIN}/admin/subdomains?q=${encodeURIComponent(sub.name)}`,
      });
      notified++;
    }
  }
  deps.logger.info(
    { evt: "dangling_scan", targets: targets.length, dangling, notified },
    "dangling cname scan done",
  );
  return { targets: targets.length, dangling, notified };
}
