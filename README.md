# Dev-in.tw

給臺灣開發者的一個名字：用 GitHub 登入，免費申請 `<name>.dev-in.tw`，在網頁上管理 DNS 紀錄。

由 **Lazco Labs（拉資科科技有限公司，Lazco Corporation）** 維運。

> 目前正在重建中。設計與實作計畫見 [`docs/PLAN.md`](docs/PLAN.md)，架構決策見 [`docs/adr/`](docs/adr/)。

## 結構

```
apps/api            Hono API 與 DNS sync worker（Node 24）
apps/web            Next.js 網站
packages/contract   前後端共用的 API 合約（zod schemas、endpoint map、typed client、fixtures）
packages/dns        DNS 規則（名稱、IP、紀錄、presets），純函式
```

## 開發

需要 Node 24 與 pnpm 10（`corepack enable`）。

```sh
pnpm install
pnpm biome ci .
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

開發規則、工作包所有權、合約變更流程與 commit 規範見 [`AGENTS.md`](AGENTS.md)。

## 回報問題

- 安全問題：`security@dev-in.tw`
- 濫用檢舉：`abuse@dev-in.tw`

## 授權

[AGPL-3.0](LICENSE)
