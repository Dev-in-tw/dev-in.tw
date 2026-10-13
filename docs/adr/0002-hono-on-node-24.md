# ADR 0002：Hono on Node 24 取代 NestJS

- 狀態：Accepted（擁有者已於 2026-10-14 確認，見 `docs/PLAN.md` §7）
- 日期：2026-10-14
- 詳細設計：`docs/PLAN.md`

## 背景

舊後端是 NestJS 11，依賴 decorator metadata，被迫使用 `useDefineForClassFields: false` 與已棄用的 `moduleResolution: node10`（D-35），升級到 TypeScript 7 風險高；DTO 與前端型別是兩份。部署環境記憶體有限（api 上限 192 MB）。

## 決策

- 後端改用 **Hono 4**，跑在 **Node 24**（`@hono/node-server`），以 `@hono/zod-openapi` 直接用合約的 zod schema 產出 OpenAPI 3.1。
- API 與 DNS sync worker 在同一個 process（`WORKER_ENABLED`）。
- 不使用 DI 框架：`apps/api/src/main.ts` 是手寫的 composition root，`modules/*` 不 import `hono`，也不 import adapter 實作。
- 部署以 tsdown 打包成單一 `dist/server.mjs`，runtime 映像不需要 `node_modules`。

## 影響

- 啟動快、RSS 低，與 TS 7、`erasableSyntaxOnly` 相容。
- 模組邊界要靠團隊紀律與 code review 維持。
- 備案：Hono app 是獨立 package，必要時可以掛進 Next route handler（§3.2 方案 D）。

## 放棄的東西

NestJS 的模組化與 DI 慣例，需要靠團隊紀律補足。
