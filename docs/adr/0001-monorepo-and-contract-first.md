# ADR 0001：Monorepo 與合約優先

- 狀態：Accepted（擁有者已於 2026-10-14 確認，見 `docs/PLAN.md` §7）
- 日期：2026-10-14
- 詳細設計：`docs/PLAN.md`

## 背景

舊系統分成 `Dev-in.tw-Frontend` 與 `Dev-in.tw-Backend` 兩個 repo，前端型別（`types/*.ts`）與後端 DTO 是兩份手寫的定義，已經出現不一致（例如前端的紀錄類型清單沒有 SRV/CAA，D-14）。重建時要讓後端（WP-A）與前端（WP-B）兩個 agent 平行開發，雙方需要一份穩定、可機器驗證的介面。

## 決策

- 新建 monorepo `Dev-in-tw/dev-in.tw`（pnpm workspace，AGPL-3.0），結構為 `apps/api`、`apps/web`、`packages/contract`、`packages/dns`。
- `packages/contract`（zod 4）是前後端**唯一**的型別來源：schemas、endpoint map、錯誤碼、typed client、fixtures。
- WP0 建立合約並打 tag `contract-v1` 後凍結。之後只允許**新增性**變更（新的 optional 欄位、新端點、新錯誤碼），由 WP-A 提出並記在 `docs/PLAN.md` 的「合約變更紀錄」；破壞性變更必須經擁有者核准。
- 內部套件以 TypeScript 原始碼直接匯出（`exports` 指向 `src/*.ts`），由 tsdown（api）與 Next（web，`transpilePackages`）在 build 時編譯，不另外發版。

## 影響

- 合約改動會同時影響兩邊，必須遵守變更流程。
- 舊 repo 的 issue 與網址不延續；上線後舊 repo 加上 README 指標並封存（WP-C）。

## 放棄的東西

舊 repo 的 issue 與網址連續性。
