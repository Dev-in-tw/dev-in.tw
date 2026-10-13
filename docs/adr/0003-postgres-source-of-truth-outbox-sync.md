# ADR 0003：PostgreSQL 為事實來源，outbox 驅動 DNS 同步

- 狀態：Accepted（擁有者已於 2026-10-14 確認，見 `docs/PLAN.md` §7）
- 日期：2026-10-14
- 詳細設計：`docs/PLAN.md`

## 背景

舊系統每次操作都即時呼叫 Cloudflare API，DB 不存任何 DNS 狀態（D-15、D-16、D-17）：無法稽核、算配額、對帳或還原；部分失敗會留下孤兒紀錄；全站共用 Cloudflare 的 API 限流。

## 決策

- **PostgreSQL 18**（Dokploy database service）+ Drizzle ORM 0.45.x，是期望狀態（desired state）的唯一來源。
- 寫入 DNS 時在同一個交易內寫 `dns_records` 與 `dns_sync_jobs`（transactional outbox），API 回 **202**、`syncStatus: pending`。
- Worker 以 `FOR UPDATE SKIP LOCKED` 取件、`LISTEN/NOTIFY` 喚醒，寫入 provider 後更新 `applied_version`；暫時錯誤指數退避，永久錯誤標記 `error`。
- Reconciler 定期對帳（missing、modified、orphan、unmanaged），並有大量刪除煞車（`RECONCILE_MAX_ORPHAN_DELETES` 與 10% 比例上限）。

## 影響

- 失敗可重試、可稽核、可從 DB 重建整個 zone（DR：還原 DB 後跑一次 reconcile）。
- 多一個容器；寫入後要等最終一致，UI 必須顯示 pending 狀態。
- 不需要 Redis。

## 放棄的東西

多一個容器；寫入後要等最終一致。
