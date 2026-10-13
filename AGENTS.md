# AGENTS.md

給在這個 repo 工作的人與 AI agent 的開發規則。完整設計見 [`docs/PLAN.md`](docs/PLAN.md)，
**§7「擁有者決定」優先於 PLAN.md 的其他段落**。架構決策見 [`docs/adr/`](docs/adr/)。

## 專案

- **Dev-in.tw**：讓臺灣開發者用 GitHub 登入、免費申請 `<name>.dev-in.tw` 並在網頁上管理 DNS。
- 營運主體：**Lazco Labs（拉資科科技有限公司，Lazco Corporation）**，由 Lazco 組成的小組負責維運。
  條款、隱私權政策、使用規範與頁尾都以此署名；信箱 `abuse@`、`security@`、`hello@dev-in.tw`。
- 授權：AGPL-3.0-only。repo 是公開的。

## 目錄與所有權

| 路徑 | 擁有者 | 說明 |
|---|---|---|
| 根目錄設定（`package.json`、`biome.json`、`tsconfig.base.json`、`pnpm-workspace.yaml`…） | WP0 | 變更要在 PR 說明理由，兩邊都同意 |
| `.github/workflows/ci.yml` | WP0 | WP-A 只改 `api` job，WP-B 只改 `web` job，`checks` job 不動 |
| `packages/contract/**` | **凍結**（`contract-v1`） | 只能走下方的合約變更流程 |
| `packages/dns/**` | **WP-A** | 純函式、不碰 IO；前後端共用。WP-B 唯讀 |
| `apps/api/**` | **WP-A** | Hono API 與 DNS sync worker。WP-B 不碰 |
| `apps/web/**` | **WP-B** | Next.js 網站。WP-A 不碰 |
| `docs/PLAN.md` | 擁有者 | 各包只能在「合約變更紀錄」表格追加列 |

分支：WP-A 用 `wp-a/backend`，WP-B 用 `wp-b/frontend`。跟進 `main` 一律 **`git merge main`**，
不 rebase、不 force push。

## 合約規則（`packages/contract`）

- `contract-v1` tag 之後凍結。前後端都只依 `main` 上的合約版本工作。
- **新增性變更**（新的 optional 欄位、新端點、新錯誤碼、新 fixture）：由 WP-A 修改，並在
  `docs/PLAN.md` 最後的「合約變更紀錄」加一列（日期、版本、變更、原因、提出者），合併到 `main`。
- **破壞性變更**（刪除或改名欄位、改型別、改路徑、改狀態碼）：禁止，必須先經擁有者核准。
- 前端依 `Problem.code` 判斷邏輯，不解析 `detail`；錯誤碼對應的 HTTP 狀態以 `ERROR_STATUS` 為準。
- fixtures 只能從 `@dit/contract/fixtures` 匯入（測試、mock server），不要在正式程式碼引用。
- 合約測試（`pnpm --filter @dit/contract test`）必須一直通過：每個 fixture 都能被對應 schema
  parse、endpoint 路徑不重複、路徑參數與 `params` schema 一致。

## 指令

```sh
pnpm install                      # Node 24、pnpm 10.32.1（corepack）
pnpm biome ci .                   # lint + format 檢查（CI 用）
pnpm biome check --write .        # 自動修正
pnpm -r typecheck                 # 所有 package 的 tsc --noEmit（web 會先跑 next typegen）
pnpm -r test                      # Vitest
pnpm -r build                     # api：tsdown → apps/api/dist；web：next build（standalone）

pnpm --filter @dit/contract test  # 只跑合約測試
pnpm --filter @dit/api dev        # API（:3001）
pnpm --filter @dit/web dev        # 網站（:3000），/api 會轉發到 API_INTERNAL_URL（預設 :3001）
docker compose -f compose.dev.yml up -d   # 本機 Postgres 18

docker build -f apps/api/Dockerfile .     # build context 一律是 repo 根目錄
docker build -f apps/web/Dockerfile .
```

CI（`.github/workflows/ci.yml`）的順序：`biome ci` → `typecheck` → `test` → `build` → 兩個
Dockerfile 的 `docker build`（不 push）。送 PR 前請在本機跑過前四步。

## 工具鏈與程式風格

- **Node 24**（`.nvmrc`）、**pnpm 10.32.1**（`packageManager`）、**TypeScript 7**（原生編譯器，
  所有 package 都用 7.x；`next build` 與 `next typegen` 在 TS 7.0.2 下已驗證可用）、**Biome 2.5**、
  **Vitest 5**、**zod 4**。
- 新增套件用最新穩定版。`pnpm-workspace.yaml` 設了 `minimumReleaseAge: 4320`（三天）：
  發佈未滿三天的版本裝不起來，這是刻意的供應鏈防護，不要關掉。
- `onlyBuiltDependencies` 目前是空的（沒有任何依賴需要跑 install script）。新增時只列真的需要的，
  並確認 `pnpm install` 的輸出沒有「Ignored build scripts」。
- `tsconfig.base.json`：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、
  `verbatimModuleSyntax`、`erasableSyntaxOnly`、`module`/`moduleResolution: nodenext`。
  `apps/web` 覆寫為 `bundler`、`jsx: preserve`，並關閉 `exactOptionalPropertyTypes`（shadcn 產生的元件不相容）。
- 相對 import 一律寫 `.ts` 副檔名（`allowImportingTsExtensions`），讓 Node 24 原生 type stripping
  可以直接執行。不要用 enum、namespace、parameter property（`erasableSyntaxOnly`）。
- 內部套件（`@dit/contract`、`@dit/dns`）直接匯出 TypeScript 原始碼，沒有自己的 build；
  由 tsdown（api）與 Next 的 `transpilePackages`（web）編譯。
  這兩個套件只用 `@types/node` 提供的全域型別（`fetch`、`Headers`、`Response`），**不加 DOM lib**，
  避免 `window`、`document` 等型別外溢到 api。
- Biome：lineWidth 100、雙引號、分號、`trailingCommas: all`；2.5 以 `linter.rules.preset: "recommended"`
  啟用建議規則。`apps/web/next-env.d.ts` 由 Next 產生，已 gitignore。
- 對外 JSON 欄位一律 camelCase；時間用 ISO 8601（含時區）；ID 用 UUIDv7。

## Commit 與 PR

- **英文** Conventional Commits：`type(scope): summary`，祈使句、開頭小寫、句尾不加句點。
  例：`feat(api): add record sync worker`、`fix(web): keep focus after closing dialog`。
  scope 用 `contract`、`dns`、`api`、`web`、`ci`、`docs`、`repo` 等。
- **不加任何 AI 署名**：不要 `Co-Authored-By: Claude …`、`Generated with …`、session 連結等 trailer。
- 一個 commit 做一件事；PR 標題與內文比照 commit 規範。

## 機密與設定

- **機密一律不進 repo。** 正式環境的值放在 Lazco Infisical 的「Dev-in.tw」專案，Dokploy 以 vault
  provider `dev-in-tw` 引用（`${{vault.dev-in-tw.KEY}}`）。
- 本機只用 `.env`（已 gitignore）；`apps/api/.env.example` 列出所有變數，只能放範例值與測試金鑰。
- 擁有者已定案的設定值（§7）：
  - `ZONE_RECORD_LIMIT=1000`（dev-in.tw 是 2023-05-11 建立的 Free zone）
  - `MAX_SUBDOMAINS_PER_USER=2`、`MAX_RECORDS_PER_SUBDOMAIN=10`
  - `ADMIN_GITHUB_IDS=51485352`
- 不要記錄 cookie、token、OAuth code、完整 email（PLAN.md §3.11）。

## 部署

Lazco Dokploy（`dokploy.lazco.tw`）的「Dev-in.tw」專案：Postgres 18、`api`（`apps/api/Dockerfile`，
Traefik `Host(dev-in.tw) && PathPrefix(/api)`，不 strip）、`web`（`apps/web/Dockerfile`）。
兩個映像都以非 root（`node`）執行、有 `HEALTHCHECK`（`/api/healthz`、`/healthz`）。
前端不使用任何 `NEXT_PUBLIC_*`，runtime 設定從 `GET /api/v1/meta` 取得。
