# ADR 0005：DnsProvider port

- 狀態：Accepted（擁有者已於 2026-10-14 確認，見 `docs/PLAN.md` §7）
- 日期：2026-10-14
- 詳細設計：`docs/PLAN.md`

## 背景

Cloudflare Free zone 有紀錄上限（dev-in.tw 為 1,000 筆，見 §7），長期可能改用自架 authoritative DNS（Lazco `cloud-infra-dns` 或 PowerDNS）。本機開發與測試不應該連到真的 Cloudflare。

## 決策

- 定義 `DnsProvider` port（`listAll`、`create`、`replace`、`delete`、`batch`、`zoneInfo`，見 PLAN.md §3.8）。
- 兩個實作：`CloudflareProvider`（正式）與 `MemoryProvider`（本機與測試，`DNS_PROVIDER=memory`）。
- 非 production 時 `DNS_PROVIDER` 預設為 `memory`；`DNS_PROVIDER=cloudflare` 搭配 `AUTH_DEV_LOGIN=true` 時拒絕啟動；zone 名稱不等於 `ROOT_DOMAIN` 時拒絕啟動。
- 所有受管紀錄的 comment 帶所有權標記 `dit:<record_uuid>`。

## 影響

- 日後換 DNS 後端只需要新增一個 adapter。
- e2e 與整合測試不需要真的 Cloudflare。

## 放棄的東西

少量抽象成本。
