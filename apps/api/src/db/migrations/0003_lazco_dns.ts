/**
 * Lazco DNS（PLAN §3.8.1）：
 * - dns_provider_ownership：Lazco DNS 沒有 comment，無法在紀錄上標 `dit:<recordId>`。worker 每次寫入前
 *   先記下「這個值是哪一筆 DB 紀錄寫的」（provider_id = `<fqdn>|<type>|<canonical value>`），寫入成功後
 *   修剪不在 provider 上的列。reconciler 依此判斷 managed／orphan／unmanaged。record_id 不設 FK：
 *   紀錄刪除後這一列仍要留著，才能把 provider 上殘留的值認成孤兒。
 * - dns_change_budget：每個 zone 每個 UTC 日已送出的批次數（Lazco DNS 每天最多 90 批，失敗也算）。
 *   每次 PATCH 之前原子遞增，重啟後仍然有效。
 */
export const sql = /* sql */ `
create table dns_provider_ownership (
  zone          text not null,
  provider_id   text not null,
  fqdn          text not null,
  type          text not null,
  record_id     uuid not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (zone, provider_id)
);
create index dns_provider_ownership_record_idx on dns_provider_ownership (record_id);

create table dns_change_budget (
  zone           text not null,
  day            date not null,
  used           integer not null check (used >= 0),
  last_batch_at  timestamptz,
  primary key (zone, day)
);
`;
