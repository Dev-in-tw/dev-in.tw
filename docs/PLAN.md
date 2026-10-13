# Dev-in.tw 重建計畫（PLAN.md）

> 版本：v1（2026-10-14）｜作者：首席架構師｜狀態：**Proposed**，待擁有者確認 §6 後轉為 Accepted
>
> 本文件是實作依據。§6 的每一題都附了預設值，**擁有者沒回覆前就照預設值做**，實作不會被卡住。
> 唯一可能改變數字的是 §6 Q1（Cloudflare zone 的紀錄上限），所以所有配額都做成設定值。

---

## 0. 一頁摘要

**要做什麼**：把 Dev-in.tw 從「NestJS + MongoDB + 前端拿 JWT 放 localStorage」的半成品，重建成可以上線的產品。使用者用 GitHub 登入，申請 `<name>.dev-in.tw`，透過網頁管理 DNS。後端以資料庫為唯一事實來源（source of truth），由背景 worker 同步到 Cloudflare。

**核心決策（預設值）**

| # | 決策 | 預設 | 主要理由 |
|---|---|---|---|
| 1 | Repo | 新建 monorepo `Dev-in-tw/dev-in.tw`（pnpm workspace，AGPL-3.0），舊的兩個 repo 封存 | 前後端共用 zod 合約，兩個 agent 可以平行開發 |
| 2 | 後端 | **Hono 4 on Node 24**，API 與 sync worker 同一個 process | 輕量、型別好，不依賴 decorator metadata，Node 原生支援度高 |
| 3 | 資料庫 | **PostgreSQL 18**（Dokploy database service）+ Drizzle ORM 0.45.x | 交易、partial unique index、`citext`、`SKIP LOCKED` 可直接當 job queue，不需要 Redis |
| 4 | DNS 同步 | DB 存期望狀態，用 transactional outbox 加 worker 寫入 Cloudflare，再由定期 reconciler 對帳 | 失敗可重試、可稽核、可從 DB 重建 zone |
| 5 | Session | **同源 API**（`https://dev-in.tw/api/*`，由 Traefik PathPrefix 路由），`__Host-` cookie 搭配 server-side session | 使用者子網域和 apex 同站（same-site），SameSite 擋不住它們發出的 CSRF |
| 6 | CSRF | 所有寫入請求都檢查 `Origin` 完全相等，且 `Sec-Fetch-Site: same-origin`，body 只接受 JSON | 同上 |
| 7 | 個資 | **不收**身分證字號、地址、電話、生日；舊 Mongo 與備份**排程銷毀** | 個資法風險，且業務上用不到 |
| 8 | DNS 範圍 | MVP 開放 A / AAAA / CNAME / TXT / MX，P1 再開 SRV / CAA；**不開** NS 委派，**不開** proxied（橘雲） | 濫用面最小 |
| 9 | 配額 | `MAX_SUBDOMAINS_PER_USER=1`、`MAX_RECORDS_PER_SUBDOMAIN=10`，另加全域 zone 容量閘門 | Free zone 可能只有 200 筆紀錄 |
| 10 | 審核 | 依風險審核：GitHub 帳號未滿 30 天，或名稱近似品牌，進人工審核，其餘自動開通 | 兼顧體驗與防釣魚 |
| 11 | 前端 | Next.js 16.4 + React 19.3（View Transitions 已穩定）+ React Compiler + Tailwind v4 + Motion + TanStack Query | 擁有者希望試新玩法 |
| 12 | 設計語言 | 「Zone file × 台灣藍鵲」：紙／墨的淺色、夜／磷光的深色，鵲藍搭配鵲喙紅，等寬字型為主 | 擺脫通用 SaaS 玻璃感 |

**工作包**：WP0（一個 agent，約半天）先建 scaffold 與合約並凍結。之後 **WP-A 後端**與 **WP-B 前端**平行開發。最後由 WP-C 整合、上線、銷毀舊資料。

**三個上線前必須面對的外部限制**（細節見 §3.1）：
1. **Cloudflare Free zone 在 2024-09-01 之後建立的話，整個 zone 只有 200 筆紀錄。** 這直接決定能服務多少人。
2. **Let's Encrypt 每個 registered domain 每 7 天只能發 50 張新憑證**，所有使用者的 GitHub Pages、Vercel 等共用這個額度，除非 dev-in.tw 進入 Public Suffix List（PSL）。
3. 進 PSL 之前，`*.dev-in.tw` 全都和 `dev-in.tw` 同站，任何使用者子網域都是潛在的 CSRF 與 cookie tossing 來源。

---

## 1. 現況盤點

### 1.1 Repo 與 checkout

| 項目 | 現況 |
|---|---|
| GitHub | `Dev-in-tw/Dev-in.tw-Frontend`（public，0★）、`Dev-in-tw/Dev-in.tw-Backend`（public，1★），授權皆為 **AGPL-3.0** |
| 本機 | `/Users/haco/Project/Lazco/Dev-in.tw/{Frontend,Backend}`，另有**重複 checkout** `/Users/haco/Project/Lazco/Dev-in.tw-{Frontend,Backend}`，HEAD 相同（`7ddb0d1` / `46a00b9`） |
| 部署 | 已停機。Backend 留有 `zbpack.json`（Zeabur 遺留），沒有 Dockerfile |

> **Canonical checkout 規則**：新 monorepo clone 到 `/Users/haco/Project/Lazco/Dev-in.tw/dev-in.tw/`。上述四個舊目錄一律**唯讀參考**，任何 agent 都不得修改。WP0 會把本檔複製到新 repo 的 `docs/PLAN.md`，之後以 repo 內的版本為準（合約變更紀錄也寫在那裡）。

### 1.2 現有功能

**後端（NestJS 11 / Express 5 / Mongoose 9）**
- GitHub OAuth：前端拿到 `code` 後 POST 給後端，後端換 access token，抓 `/user` 與 `/user/emails`，以 `githubId` upsert 使用者，再簽發 JWT（HS256，預設 7 天）。
- 子網域：查可用性（格式 regex、26 個保留字、DB 唯一），申請時**要求填身分資料**，建立後立即 `active`，並把 `expire_time` 設為一年後（但沒有任何地方檢查）。
- DNS：每次都即時呼叫 Cloudflare API 做 list、create、update、delete，用名稱後綴檢查範圍。DB 裡沒有任何 DNS 資料。
- 其他：Swagger 在 `/docs`；全域 `ThrottlerGuard` 每 60 秒 100 次；`AllExceptionsFilter`；`/test` 測試路由。

**前端（Next.js 16 / React 19 / Tailwind v4 / shadcn）**
- 頁面：`/`（Hero 加搜尋框）、`/login`（直接 redirect 到 GitHub）、`/api/auth/callback/[service]`、`/callback`（把 token 寫進 localStorage）、`/find`（可用性結果加申請 Dialog）、`/domain`（我的子網域表格）、`/domain/dns`（DNS 紀錄 CRUD）。
- 只有深色模式（`forcedTheme="dark"`），用 framer-motion 做淡入。

### 1.3 現有資料模型（MongoDB）

- `user`：`githubId`、`email`、`primaryEmail`、`name`、`first_name`、`last_name`、`birth`、**`identy_id`（身分證字號）**、`address`、`phone`、`avatar`、`description`、`badge[]`、`beta`、`warn`、`disabled`、`premium`
- `domain`：`name`（unique）、`cloudflare_id`（未使用）、`description`、`owner`（字串）、`verify`（恆為 true）、`status`（恆為 `"active"`）、`apply_time`、`last_update`、`expire_time`（無作用）、`ssl`、`premium`、`exclusive`、`disable`（皆無作用）

### 1.4 現有 API

| Method | Path | Auth | 說明 |
|---|---|---|---|
| GET | `/` | – | 歡迎訊息 |
| GET | `/docs` | – | Swagger |
| POST | `/auth/github` | – | `{code}` → `{token}` |
| GET | `/user/info` | JWT | 回傳**完整** user，含身分證字號等個資 |
| GET/POST | `/test` | **無** | POST 可在 DB **建立或修改 user** |
| GET | `/domain/check?name=` | – | 可用性 |
| POST | `/domain` | JWT | 申請，body 含個資 |
| GET | `/domain` | JWT | 我的子網域 |
| DELETE | `/domain/:id` | JWT | 刪除，並逐筆刪除 CF 紀錄 |
| GET/POST | `/domain/:id/dns` | JWT | 列出或新增 CF 紀錄 |
| PATCH/DELETE | `/domain/:id/dns/:recordId` | JWT | 修改或刪除 CF 紀錄 |
| ALL | `{*splat}` | – | 404 |

### 1.5 現有 OAuth 流程

```
Browser ──GET /login──▶ Next(Server Component) ──302──▶ github.com/login/oauth/authorize?client_id&redirect_uri&scope=user:email
        （沒有 state、沒有 PKCE）
GitHub ──302──▶ Next /api/auth/callback/github?code=…
Next route handler ──POST {code}──▶ API /auth/github ──▶ GitHub token exchange + /user + /user/emails
API ──{token: JWT}──▶ Next ──302──▶ /callback?token=<JWT>        ← token 出現在 URL
/callback（client）──▶ localStorage.setItem("token", JWT)          ← XSS 可直接讀走
後續請求 ──Authorization: Bearer <JWT>──▶ API                       ← 7 天、無法撤銷
```

### 1.6 現有 Cloudflare 整合

- `CloudflareService` 用 axios 包 `zones/{zone}/dns_records`；`unwrap()` 把 CF 錯誤轉成 502，並**把 CF 錯誤原文轉給前端**。
- 範圍檢查（`isRecordInScope`）的邏輯本身正確，有考慮到前導點：`fqdn === base || fqdn.endsWith('.'+base)`。update 與 delete 會先從 CF 讀取 record 的真實名稱再檢查，這部分做得對。
- 問題在於：DB 不記錄任何 DNS 狀態、沒有分頁、沒有重試、沒有對帳。PATCH 允許改 type，但 Cloudflare 已廢止就地改 type（EOL 2026-06-30）。MX 沒有 priority 欄位，SRV 與 CAA 沒有 data 物件，這幾種送出去都會被 CF 拒絕。

### 1.7 缺陷、漏洞、未完成功能

嚴重度：**嚴重**（可直接被利用或有法律風險）、**高**、**中**、**低**。

| ID | 嚴重度 | 問題 | 位置 |
|---|---|---|---|
| D-01 | 嚴重 | 未驗證的 `POST /test` 可以在正式 DB 建立或修改 user | `Backend/src/test/test.controller.ts`、`src/app.module.ts` |
| D-02 | 嚴重 | 收集**身分證字號**、地址、電話、生日並以明文存放，`/user/info` 原樣回傳。違反個資法的最小蒐集原則，一旦外洩風險極高 | `Backend/src/domain/dto/create-domain.dto.ts`、`src/user/schemas/user.schema.ts`、`src/user/user.controller.ts`、`Frontend/components/Domain/ApplyDomainDialog.tsx` |
| D-03 | 高 | JWT 放在 URL query（`/callback?token=`），會留在瀏覽器歷史、Referer、Traefik 與 Next 的 access log | `Frontend/app/api/auth/callback/[service]/route.ts`、`app/callback/page.tsx` |
| D-04 | 高 | JWT 存在 localStorage，7 天有效且無法撤銷，登出只清前端 | `Frontend/lib/authToken.ts`、`Backend/src/auth/auth.module.ts` |
| D-05 | 高 | OAuth 沒有 `state` 也沒有 PKCE，可被 login CSRF（把受害者登入成攻擊者的帳號） | `Frontend/app/login/page.tsx`、`Backend/src/auth/github/github.service.ts` |
| D-06 | 高 | `JwtAuthGuard` 不檢查使用者是否存在或已停權，被停權者仍能操作 7 天 | `Backend/src/auth/guards/jwt-auth.guard.ts` |
| D-07 | 高 | 沒設 `trust proxy`，限流以 Traefik 的 IP 計數，等於**全站共用每分鐘 100 次**，一個人就能讓整站被 429 | `Backend/src/main.ts`、`src/app.module.ts` |
| D-08 | 高 | DNS content 完全不驗證：A/AAAA 可以指向 `127.0.0.1` 或 `10.0.0.0/8`（DNS rebinding、內網探測），CNAME 可以指向任意位置，TTL 可以是任意整數 | `Backend/src/domain/dto/dns-record.dto.ts` |
| D-09 | 高 | 允許 **NS 紀錄**，使用者能把子網域委派到外部 DNS，完全繞過平台控管，還有 dangling delegation 被接管的風險 | 同上 |
| D-10 | 高 | 允許 `proxied=true`：使用者流量會經過組織的 Cloudflare 帳號（ToS 與濫用申訴都算在 zone 擁有者頭上、zone 設定外溢）。Universal SSL 只涵蓋一層，`www.alice.dev-in.tw` 開橘雲會直接壞掉 | `dns-record.dto.ts`、`Frontend/components/Domain/DnsRecordDialog.tsx` |
| D-11 | 高 | 每人子網域數與每個子網域的紀錄數都沒有上限，可以無限搶註，也能把 zone 紀錄配額灌爆 | `Backend/src/domain/domain.service.ts` |
| D-12 | 高 | 保留字只有 26 個；允許 `xn--` punycode（同形字釣魚）、單一字元名稱，以及 `google`、`paypal`、`ctbc` 等品牌名 | `Backend/src/domain/constants/reserved-names.ts` |
| D-13 | 中 | `PATCH` 會帶 `type` 欄位，但 Cloudflare 已廢止就地改 type（2026-06-30 EOL），改 type **必定失敗** | `domain.service.ts#updateDns` |
| D-14 | 中 | MX 沒有 `priority`，SRV 與 CAA 沒有 `data`，送出去 CF 會拒絕。前端清單是 A/AAAA/CNAME/TXT/MX/NS，後端是加上 SRV/CAA 的版本，兩邊不一致 | `dns-record.dto.ts`、`Frontend/types/dnsType.ts` |
| D-15 | 中 | DNS 狀態只存在 Cloudflare，無法稽核、算配額、對帳或還原 | `domain.schema.ts`（`cloudflare_id` 未使用） |
| D-16 | 中 | 每次開 DNS 頁面都直接打 CF API。CF 的 1,200 req / 5 min 由全站共用，一個人狂按重新整理就能耗盡。另外 `per_page=100` 沒有分頁，超過的紀錄會被靜默截斷 | `Backend/src/cloudflare/cloudflare.service.ts` |
| D-17 | 中 | 刪除子網域時先逐筆刪 CF 再刪 DB，沒有交易也沒有重試，部分失敗會留下孤兒紀錄 | `domain.service.ts#remove` |
| D-18 | 中 | Cloudflare 錯誤原文直接回傳前端 | `cloudflare.service.ts#unwrap` |
| D-19 | 中 | 可用性檢查不看 zone 裡已存在的紀錄（例如管理員手動建立的名稱） | `domain.service.ts#checkAvailable` |
| D-20 | 中 | 沒有名稱冷卻期，刪除後他人可以立即註冊並接收前擁有者的 email 或連結流量 | – |
| D-21 | 中 | 申請時先把個資寫進 user，即使子網域建立失敗，個資也已經寫入 | `domain.service.ts#register` |
| D-22 | 中 | callback route 沒有錯誤處理（後端 401 會變成 500）；缺少 code 時回 200 JSON；未知 service 回 `undefined` | `Frontend/app/api/auth/callback/[service]/route.ts` |
| D-23 | 中 | 沒有任何安全標頭（CSP、HSTS、frame-ancestors 等） | `Backend/src/main.ts`、`Frontend/next.config.mjs` |
| D-24 | 中 | `viewport` 設了 `userScalable:false, maximumScale:1`，違反 WCAG 1.4.4 | `Frontend/app/layout.tsx` |
| D-25 | 中 | DNS 管理區整塊 `select-none`，**無法複製紀錄值**；側欄固定 `w-3/12`，手機上無法使用 | `Frontend/app/domain/layout.tsx` |
| D-26 | 低 | `useUserAccount` 每個元件各打一次 `/user/info`，沒有共享快取，也沒有路由保護 | `Frontend/hooks/useUserAccount/index.tsx` |
| D-27 | 低 | 搜尋沒有 `encodeURIComponent`，也沒轉小寫 | `Frontend/components/Domain/SearchInput.tsx` |
| D-28 | 低 | DNS 名稱要使用者自己輸入完整 FQDN，很容易打錯 | `Frontend/components/Domain/DnsRecordDialog.tsx` |
| D-29 | 低 | `expire_time`、`verify`、`ssl`、`premium`、`exclusive`、`disable` 都沒有作用；前端有 `pending`/`reject` 狀態，後端從來不會產生 | `domain.schema.ts`、`Frontend/types/domainType.ts` |
| D-30 | 低 | 404 fallback 的格式和錯誤 filter 的格式不一致 | `Backend/src/common/fallback/fallback.controller.ts` |
| D-31 | 低 | 沒有 health endpoint、沒有 Dockerfile；`engines.node >=20`，`pnpm@8.15.4` 過舊 | `Backend/package.json` |
| D-32 | 低 | 同時用三套 icon（lucide、react-icons、tabler）、framer-motion 舊名、`radix-ui` 與 `@radix-ui/*` 重複安裝 | `Frontend/package.json` |
| D-33 | 低 | 強制深色模式；`ThemeSwitch`、`PathCheck`（其實是 hook 卻命名成元件）、`components/Icons` 都沒被使用 | `Frontend/app/provider.tsx` 等 |
| D-34 | 低 | 文件漂移：Frontend CLAUDE.md 提到的 `data/` 假資料與 `api/client.ts` 實際不存在 | `Frontend/CLAUDE.md` |
| D-35 | 低 | NestJS 依賴 decorator metadata，被迫設定 `useDefineForClassFields:false` 和已棄用的 `moduleResolution: node10`（TS7 會移除），升級風險高 | `Backend/tsconfig.json` |
| D-36 | 低 | `metadataBase` 用 `APP_URL as string`，缺值時 build 會失敗；OG url 用 `www.dev-in.tw`，和實際網址不一致 | `Frontend/app/layout.tsx` |
| D-37 | 低 | 安全核心（`assertRecordInScope`、`assertOwnedDomain`）沒有測試；e2e 需要連真的 Mongo | `Backend/src/**/*.spec.ts` |
| D-38 | 低 | 首頁整頁 `"use client"`，SSR 與 SEO 都沒有效益 | `Frontend/app/page.tsx` |

**未完成的功能**：網站憑證、擴充元件、租用伺服器（側欄顯示「開發中」）；審核流程；到期與續約；管理後台；檢舉；稽核紀錄；公開展示；可撤銷的登出；使用文件與教學；刪除帳號；服務條款、隱私權政策、使用規範；狀態頁；安全聯絡窗口（`security.txt`、abuse 信箱）。

---

## 2. 「功能完整」的定義

優先序：**P0**＝MVP 上線必備，**P1**＝上線後第一輪（仍屬「完整」的一部分），**P2**＝Lab 加分。

### 2.1 使用者端

| 功能 | 優先序 | 驗收重點 |
|---|---|---|
| GitHub 登入（state + PKCE S256、server session、可登出） | P0 | token 不出現在 URL 或 JS 可讀的儲存空間 |
| 即時可用性查詢（含原因與建議名稱） | P0 | debounce 300ms，回傳 `available/review/taken/reserved/invalid/cooldown/capacity_full` |
| 申請子網域（同意條款、Turnstile、依風險審核） | P0 | 不收個資；配額與 zone 容量檢查；`Idempotency-Key` |
| DNS 紀錄 CRUD：A / AAAA / CNAME / TXT / MX | P0 | 依類型提供不同欄位，前後端用同一套驗證；顯示同步狀態；改 type 時以 batch 先刪後建 |
| 一鍵設定：GitHub Pages、Vercel、Netlify、Cloudflare Pages | P0 | 套用前顯示 diff（新增與刪除），以 batch 一次套用 |
| 釋出子網域（輸入名稱確認，之後冷卻 30 天） | P0 | CF 紀錄全部清掉，名稱進入 hold |
| 使用文件：各平台設定教學、FAQ | P0 | MDX |
| 服務條款、隱私權政策、使用規範（AUP） | P0 | 申請時必須勾選同意 |
| 檢舉表單（公開、Turnstile） | P0 | 可以帶 `?name=` 預填 |
| 淺色與深色模式（跟隨系統，可手動切換） | P0 | 兩種模式都達 AA 對比 |
| SRV / CAA | P1 | SRV 名稱必須是 `_svc._proto` 格式 |
| 即時同步狀態（SSE） | P1 | 紀錄從 pending 變成 synced 時有動畫回饋 |
| DNS 傳播檢查（Cloudflare 1.1.1.1、Google、Quad9、**TWNIC Quad101**） | P1 | 由後端用 DoH 查詢，結果快取 15 秒 |
| 擁有權轉移（指定 GitHub login，對方 7 天內接受） | P1 | 接受時檢查對方配額；可選擇是否保留原有紀錄 |
| 活動紀錄（自己的稽核時間軸） | P1 | |
| 公開成員展示頁（opt-in）、統計數字、台灣點陣地圖 | P1 | 預設不公開 |
| 狀態頁 `/status` | P1 | API、DB、Cloudflare、sync queue、最後一次對帳時間 |
| ⌘K 指令面板（終端機風格） | P1 | |
| Session 管理（列出裝置、登出其他裝置）、刪除帳號 | P1 | |
| 更多一鍵設定：Bluesky handle（`_atproto` TXT）、ImprovMX、Google site verification、Zeabur、Render、Fly.io | P1 | |
| Zone file 原始碼編輯模式（CodeMirror，lint 加 diff） | P2 | |
| Personal Access Token、`api.dev-in.tw` 公開 API、CLI（`npx dev-in`）、GitHub Action | P2 | |
| 子網域名片 OG 圖（`/og/<name>`） | P2 | |
| 英文介面 | P2 | |

### 2.2 管理端

| 功能 | 優先序 |
|---|---|
| 管理員以 `ADMIN_GITHUB_IDS` 啟動（綁 GitHub numeric id） | P0 |
| 審核佇列（待審子網域，顯示風險原因），核准或駁回並附理由 | P0 |
| 停權與解除（子網域、使用者）：停權時 **CF 紀錄撤下、DB 保留**，解除時重新同步 | P0 |
| 檢舉處理佇列（可以一鍵停權被檢舉的子網域） | P0 |
| 保留字 CRUD（system、brand、offensive、premium、zone 五類） | P0 |
| 稽核紀錄檢視（依 actor、target、action 篩選） | P0 |
| 使用者與子網域搜尋、個別配額覆寫 | P0 |
| Zone 儀表：紀錄使用量與上限、同步失敗清單、手動觸發對帳 | P1 |
| 漂移報告（missing、modified、orphan、unmanaged） | P1 |
| 系統設定：開放或關閉註冊、審核模式（`risk`、`all`、`none`） | P1 |
| Discord webhook 告警（新檢舉、待審、dead job、zone 用量超過 80%） | P1 |
| Dangling record 與子網域接管偵測、Safe Browsing 掃描 | P2 |
| NS 委派（只開放給審核過的可信使用者） | P2 |
| 自架 authoritative DNS adapter（PowerDNS 或 `cloud-infra-dns`） | P2 |

### 2.3 平台與營運（P0）

- `/.well-known/security.txt`、`abuse@dev-in.tw`（可用 Cloudflare Email Routing 轉寄到擁有者）
- 每日 DB 備份到 S3（Lazco Garage），每月演練一次還原
- 結構化日誌（wide events）、健康檢查、限流、安全標頭
- 舊資料銷毀與金鑰輪替（§3.14）

---

## 3. 目標架構

### 3.1 外部限制（設計的出發點）

**(1) Cloudflare zone 紀錄上限**
Free plan 在 2024-09-01 以後建立的 zone 只能有 **200** 筆紀錄，之前建立的是 **1,000** 筆；Pro 與 Business 是 **3,500** 筆。超過時 API 回 `81045 Record quota exceeded`。系統紀錄（apex、www、MX、`_dmarc` 等）也算在裡面。

做法：
- 上限做成設定值 `ZONE_RECORD_LIMIT`，另外保留 `ZONE_HEADROOM` 筆給系統使用。
- 申請子網域與新增紀錄時都要檢查**全域容量**。滿了之後可用性回 `capacity_full`，前端改成顯示候補名單。
- DNS provider 以 port 抽象，日後可以換成自架 DNS（§3.8）。

以平均每個子網域 2.5 筆紀錄估算：

| Zone 上限 | 建議每人子網域數 | 每個子網域紀錄上限 | 約可容納子網域數 |
|---|---|---|---|
| 200（新 Free zone） | 1 | 10 | 約 70 |
| 1,000（舊 Free zone） | 1 | 10 | 約 390 |
| 3,500（Pro，月費約 US$20–25） | 2 | 10 | 約 1,390 |
| 自架 DNS | 3 | 20 | 不受此限 |

**(2) 同站問題（Public Suffix List 之前）**
`alice.dev-in.tw` 與 `dev-in.tw` 屬於同一個 site（eTLD+1 都是 `dev-in.tw`），會造成：
- (a) SameSite cookie 擋不住從 `alice.dev-in.tw` 發出的請求；
- (b) 使用者子網域可以設定 `Domain=dev-in.tw` 的 cookie（cookie tossing）。

解法是 `__Host-` 前綴的 cookie（瀏覽器禁止設定 Domain 屬性，子網域無法覆寫），加上 Origin 與 `Sec-Fetch-Site: same-origin` 檢查（§3.7）。

將來如果進了 PSL，`api.dev-in.tw` 與 `dev-in.tw` 會變成跨站，cookie 會被當成第三方而被擋掉。所以**現在就用同源 `/api`**，進不進 PSL 都能運作。

**(3) Let's Encrypt 憑證額度**
每個 registered domain 每 7 天 50 張新憑證（以 token bucket 回補），所有使用者共用。可以走兩條路：
- (a) 申請加入 PSL 的 PRIVATE section。條件是 registration 必須**一直**保持兩年以上的剩餘期限、設好 `_psl` TXT 紀錄，而且使用者規模太小的專案很可能被拒；
- (b) 向 Let's Encrypt 申請提高額度。

預設先走 (b)，等子網域超過 1,000 個再走 (a)（§6 Q13）。

**(4) Cloudflare API 行為**
- 全域限流 1,200 req / 5 min，換算約 4 req/s。worker 用 client 端 token bucket 控制在 3 req/s。
- 不能就地改 type，改用 `POST /dns_records/batch`（固定以 deletes、patches、puts、posts 的順序執行，DB 寫入 all-or-nothing，但傳播不保證原子性）。
- Free plan 的 record comment 可用，拿來放所有權標記 `dit:<record_uuid>`。

### 3.2 方案比較與決策

**後端框架**

| 方案 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| A. **Hono 4 on Node 24**（`@hono/node-server`，`@hono/zod-openapi`） | 啟動快、RSS 低（約 60–90 MB）；zod schema 直接產出 OpenAPI 3.1；不需要 decorator，和 TS6/TS7 相容；Web 標準 `Request`/`Response`，日後可搬到別的 runtime | DI、模組化要自己守紀律 | **採用** |
| B. 保留 NestJS 11 | 現有程式碼可沿用（但大部分本來就要重寫） | `emitDecoratorMetadata` 加 `useDefineForClassFields:false` 加 `node10` 的組合，在 TS7 會更麻煩；記憶體較高（約 150 MB）；DTO 和前端型別是兩份 | 不採用 |
| C. Elysia（Lazco 的主力技術） | Lazco 有經驗 | 以 Bun 為主，在 Node 24 上不是首要目標；需求指定 Node 24 | 不採用。如果日後整體轉向 Bun，Hono 也能直接跑在 Bun 上 |
| D. 把 Hono 掛進 Next.js route handler（`app/api/[[...route]]/route.ts`） | 只要一個容器，最省記憶體 | Worker 與 reconciler 的生命週期要依附在 Next 的 `instrumentation.ts`；前後端耦合 | **備案**：Hono app 是獨立 package，必要時半天內就能切換 |

**資料庫**

| 方案 | 優點 | 缺點 | 結論 |
|---|---|---|---|
| **PostgreSQL 18** | 交易；`citext`；partial unique index；內建 `uuidv7()`；`FOR UPDATE SKIP LOCKED` 可直接當 queue；`LISTEN/NOTIFY` 可驅動 SSE；Lazco 熟悉；Dokploy 內建備份 | 多一個容器（約 100–150 MB） | **採用** |
| SQLite（libSQL 或 better-sqlite3） | 最省資源 | Swarm 只能 replicas=1 且 volume 綁死節點；沒有 LISTEN；併發寫入差 | 不採用 |
| 保留 MongoDB | – | 唯一性與交易語意較弱；舊資料含個資，本來就要銷毀 | 不採用 |

ORM 用 **Drizzle 0.45.x stable**（Lazco 現行版本），不用 1.0 RC。Driver 用 `postgres`（postgres.js）。

**Repo 策略**

| 方案 | 說明 | 結論 |
|---|---|---|
| A. **新 monorepo `Dev-in-tw/dev-in.tw`** | 乾淨的歷史，AGPL-3.0 延續；舊的兩個 repo 封存，README 指向新 repo | **採用** |
| B. 把 Frontend repo 改名成 monorepo | 保留 issue 與網址，但歷史混雜，而且 Backend 的歷史接不進來 | 次選 |
| C. 維持兩個 repo，合約發成 npm 套件 | 每次改合約都要發版，平行開發時很痛苦 | 不採用 |

**前端資料存取**：Server Component 在 server 端透過 `API_INTERNAL_URL` 打 API，並轉發 cookie。Client 端用 TanStack Query 加合約產生的 typed client 打同源的 `/api`。**不採用** Server Actions 直接碰 DB，因為所有商業規則只能存在 API 一個地方。

### 3.3 系統圖（C4 Container）

```
                         ┌────────────────────────── Dokploy（Docker Swarm）──────────────────────────┐
  Browser ──HTTPS──▶ Traefik ──Host(dev-in.tw) && PathPrefix(/api)──▶ [api]  Hono + Worker  :3001     │
     ▲                │      ──Host(dev-in.tw)───────────────────────▶ [web]  Next.js standalone :3000│
     │ SSE /api/v1/events    ──Host(www.dev-in.tw)──301──▶ https://dev-in.tw                          │
     │                │                                                  │  ▲                           │
     │                │            [web] ──RSC fetch（cookie 轉發）───────┘  │ LISTEN/NOTIFY             │
     │                │                                                     ▼  │                         │
     │                │                                          [postgres 18]（Dokploy DB service）     │
     │                └─────────────────────────────────────────────────────────────────────────────────┘
     │                                       │ api 對外呼叫
     │                     ┌─────────────────┼──────────────────┬───────────────────┬──────────────────┐
     │                     ▼                 ▼                  ▼                   ▼                  ▼
     │             GitHub OAuth/API   Cloudflare DNS API   Turnstile siteverify   DoH resolvers   Discord webhook
     │                                （zone dev-in.tw）                         （1.1.1.1/8.8.8.8/
     └── 使用者的網站（GitHub Pages、Vercel…）← <name>.dev-in.tw 解析            9.9.9.9/Quad101）
```

### 3.4 Monorepo 目錄結構

```
dev-in.tw/
├─ package.json                # private；scripts：check、typecheck、test、build
├─ pnpm-workspace.yaml         # apps/*, packages/*
├─ biome.json                  # 單一份；lineWidth 100、雙引號、分號、trailingCommas all
├─ tsconfig.base.json          # strict、noUncheckedIndexedAccess、verbatimModuleSyntax、erasableSyntaxOnly、
│                              # module/moduleResolution nodenext（api、packages）
│                              # apps/web/tsconfig.json 覆寫：module esnext、moduleResolution bundler、jsx preserve、
│                              # 加上 Next plugin；exactOptionalPropertyTypes 只在 api 與 packages 開啟
│                              # （shadcn 產生的 components/ui 不相容）
├─ .github/workflows/ci.yml    # biome ci → typecheck → test → build → docker build
├─ docs/PLAN.md, docs/adr/*.md, AGENTS.md, CLAUDE.md（指向 AGENTS.md）
├─ packages/
│  ├─ contract/                # WP0 建立後凍結：zod schemas、endpoint map、錯誤碼、typed client、fixtures
│  │  └─ src/{primitives,errors,user,naming,subdomain,dns,preset,transfer,report,public,admin,events,endpoints,client,fixtures,index}.ts
│  └─ dns/                     # 純函式（不碰 IO），WP0 先建 stub，之後由 WP-A 實作
│     └─ src/{name-rules,ip-rules,record-rules,conflicts,presets,reserved-seed,zone-line,index}.ts
├─ apps/
│  ├─ api/                     # WP-A
│  │  ├─ Dockerfile
│  │  ├─ drizzle.config.ts
│  │  └─ src/
│  │     ├─ main.ts            # 讀 config → 連 DB → 跑 migrate → 啟動 HTTP → 啟動 worker；處理 SIGTERM
│  │     ├─ config.ts          # 用 zod 驗證 env，缺值時直接啟動失敗
│  │     ├─ http/
│  │     │  ├─ app.ts          # Hono basePath('/api')；中介層順序見 §3.6
│  │     │  ├─ middleware/{request-id,wide-log,client-ip,security-headers,session,csrf,rate-limit,problem}.ts
│  │     │  └─ routes/{health,meta,auth,me,availability,subdomains,records,presets,transfers,reports,public,events}.ts
│  │     │     └─ admin/{overview,users,subdomains,reports,reserved,audit,zone,settings}.ts
│  │     ├─ modules/           # use case 層，不 import hono
│  │     │  ├─ identity/{github-oauth,sessions,users}.ts
│  │     │  ├─ naming/{availability,risk,holds}.ts
│  │     │  ├─ subdomains/service.ts
│  │     │  ├─ records/{service,quota}.ts
│  │     │  ├─ presets/service.ts
│  │     │  ├─ transfers/service.ts
│  │     │  ├─ moderation/{reports,suspension}.ts
│  │     │  ├─ propagation/service.ts
│  │     │  └─ audit/service.ts
│  │     ├─ sync/{provider-port,queue,worker,reconciler,events-bus}.ts
│  │     ├─ adapters/
│  │     │  ├─ cloudflare/{client,mapper,errors,provider}.ts   # implements DnsProvider
│  │     │  ├─ memory-dns/provider.ts                         # 給本機開發與測試用
│  │     │  ├─ github/client.ts、turnstile/client.ts、doh/client.ts、discord/notifier.ts
│  │     ├─ db/{client,schema,migrate,seed}.ts、db/migrations/*.sql
│  │     └─ lib/{problem,crypto,clock,ids,ttl-cache}.ts
│  └─ web/                     # WP-B
│     ├─ Dockerfile
│     ├─ next.config.ts        # output standalone、reactCompiler、cacheComponents、rewrites /api → API_INTERNAL_URL
│     ├─ proxy.ts              # Next 16 的 proxy（舊稱 middleware）：沒有 session cookie 時把 /dashboard、/admin 導向 /login；CSP nonce
│     ├─ app/
│     │  ├─ (marketing)/{page.tsx, explore/, status/, report/, docs/[slug]/, terms/, privacy/, aup/}
│     │  ├─ (auth)/login/page.tsx
│     │  ├─ (app)/dashboard/{page.tsx, [name]/{page.tsx,records/,settings/,activity/}, transfers/}, settings/
│     │  ├─ (admin)/admin/{page.tsx, review/, reports/, subdomains/, users/, reserved/, audit/, zone/, settings/}
│     │  ├─ healthz/route.ts、.well-known/security.txt/route.ts、not-found.tsx、error.tsx、layout.tsx
│     ├─ components/{ui/, brand/, claim/, dns/, visuals/, command/, admin/, feedback/}
│     ├─ lib/{api.server.ts, api.client.ts, query.ts, sse.ts, motion.ts, theme.ts, format.ts}
│     ├─ content/docs/*.mdx
│     ├─ mock/{server.ts, state.ts}    # 用 Hono 寫的 mock API（:3001），資料來自 contract fixtures
│     ├─ e2e/*.spec.ts                 # Playwright
│     └─ styles/globals.css
└─ compose.dev.yml             # postgres 18（本機開發與整合測試用）
```

**依賴方向**：`modules/*` 只依賴 `db`、`sync/provider-port`、`packages/dns`、`packages/contract` 的型別，**不 import** `hono`，也不 import adapter 的實作。adapter 在 `main.ts` 組裝後注入（手寫 composition root，不引入 DI 框架）。`packages/dns` 不依賴任何 IO，前後端都可以用。

### 3.5 資料模型（PostgreSQL 18）

規則：表名用 snake_case 複數；主鍵用 `uuidv7()`；所有時間欄位用 `timestamptz`；外鍵都要建索引。Drizzle schema 以此為準。

```sql
create extension if not exists citext;

create type user_role        as enum ('user','admin');
create type user_status      as enum ('active','suspended');
create type subdomain_status as enum ('pending_review','active','suspended','releasing');
create type record_type      as enum ('A','AAAA','CNAME','TXT','MX','SRV','CAA');
create type sync_status      as enum ('pending','synced','error','deleting');
create type transfer_status  as enum ('pending','accepted','declined','cancelled','expired');
create type report_status    as enum ('open','actioned','dismissed');
create type report_category  as enum ('phishing','malware','spam','illegal','impersonation','other');
create type reserved_category as enum ('system','brand','offensive','premium','zone');

create table users (
  id                 uuid primary key default uuidv7(),
  github_id          bigint not null unique,           -- 身分錨點；login 會改名、會被回收，不能當 key
  github_login       citext not null,
  display_name       text,
  avatar_url         text not null,
  email              citext,                            -- GitHub primary verified email（作為 abuse 聯絡用）
  github_created_at  timestamptz not null,              -- 風險評估：帳號年齡
  role               user_role not null default 'user',
  status             user_status not null default 'active',
  suspended_reason   text,
  quota_subdomains   int,                               -- null = 用全域預設
  quota_records      int,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_login_at      timestamptz not null default now()
);
create index users_github_login_idx on users (github_login);

create table sessions (
  id                  text primary key,                 -- sha256(token) 的 hex；明文 token 只存在 cookie
  user_id             uuid not null references users(id) on delete cascade,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  idle_expires_at     timestamptz not null,             -- 閒置 14 天
  absolute_expires_at timestamptz not null,             -- 絕對 60 天
  ip                  inet,
  user_agent          text,
  revoked_at          timestamptz
);
create index sessions_user_id_idx on sessions (user_id);

create table subdomains (
  id                uuid primary key default uuidv7(),
  name              citext not null unique
                    check (name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' and name !~ '--'),
  owner_id          uuid not null references users(id) on delete restrict,
  status            subdomain_status not null,
  description       text not null default '' check (char_length(description) <= 280),
  show_in_directory boolean not null default false,
  review_reasons    text[] not null default '{}',       -- 例如 {'account_too_new','confusable:google'}
  suspended_reason  text,
  created_at        timestamptz not null default now(),
  activated_at      timestamptz,
  updated_at        timestamptz not null default now()
);
create index subdomains_owner_idx on subdomains (owner_id);
create index subdomains_status_idx on subdomains (status) where status <> 'active';

create table dns_records (
  id                 uuid primary key default uuidv7(),
  subdomain_id       uuid not null references subdomains(id) on delete cascade,
  name               text not null,                     -- 相對名稱：'@'、'www'、'_acme-challenge'、'_minecraft._tcp'
  type               record_type not null,
  ttl                int not null check (ttl = 1 or ttl between 60 and 86400),
  data               jsonb not null,                    -- 依類型：{address} | {target} | {value} | {priority,exchange} | ...
  version            int not null default 1,            -- 每次修改 +1，對應 If-Match
  applied_version    int not null default 0,            -- 已成功同步到 provider 的版本
  provider_record_id text unique,
  provider_type      record_type,                       -- provider 端目前的 type（用來判斷是否要先刪後建）
  sync_status        sync_status not null default 'pending',
  sync_error_code    text,
  sync_error_message text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index dns_records_subdomain_idx on dns_records (subdomain_id);
create index dns_records_sync_idx on dns_records (sync_status) where sync_status <> 'synced';

create table dns_sync_jobs (
  id            bigserial primary key,
  kind          text not null check (kind in ('upsert_record','delete_record','purge_subdomain','restore_subdomain')),
  record_id     uuid,                                   -- 刻意不建外鍵，因為紀錄刪除時 job 仍要保留
  subdomain_id  uuid,
  status        text not null default 'queued' check (status in ('queued','running','done','dead')),
  attempts      int not null default 0,
  run_at        timestamptz not null default now(),
  locked_until  timestamptz,
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index dns_sync_jobs_coalesce_idx on dns_sync_jobs (record_id) where status = 'queued' and record_id is not null;
create index dns_sync_jobs_due_idx on dns_sync_jobs (run_at) where status = 'queued';

create table reserved_names (
  name        citext primary key,
  category    reserved_category not null,
  note        text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table name_holds (                               -- 釋出或轉移後的冷卻期
  name              citext primary key,
  previous_owner_id uuid references users(id) on delete set null,
  reason            text not null,                      -- 'released' | 'admin_rejected' | 'legacy'
  hold_until        timestamptz not null
);

create table transfers (
  id            uuid primary key default uuidv7(),
  subdomain_id  uuid not null references subdomains(id) on delete cascade,
  from_user_id  uuid not null references users(id),
  to_user_id    uuid not null references users(id),
  status        transfer_status not null default 'pending',
  keep_records  boolean not null default true,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  resolved_at   timestamptz
);
create unique index transfers_one_pending_idx on transfers (subdomain_id) where status = 'pending';
create index transfers_to_idx on transfers (to_user_id, status);
create index transfers_from_idx on transfers (from_user_id, status);

create table reports (
  id               uuid primary key default uuidv7(),
  subdomain_name   citext not null,                     -- 不建外鍵：被檢舉的名稱可能已經釋出
  subdomain_id     uuid references subdomains(id) on delete set null,
  category         report_category not null,
  details          text not null check (char_length(details) between 10 and 2000),
  contact_email    citext,
  reporter_user_id uuid references users(id) on delete set null,
  reporter_ip_hash text,                                -- sha256(ip + REPORT_IP_SALT)，用來限流與找出重複檢舉
  status           report_status not null default 'open',
  handled_by       uuid references users(id) on delete set null,
  resolution_note  text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);
create index reports_status_idx on reports (status, created_at desc);

create table audit_logs (                               -- 只能新增；應用程式的 DB 角色不授予 UPDATE/DELETE 權限
  id            uuid primary key default uuidv7(),
  actor_type    text not null check (actor_type in ('user','admin','system')),
  actor_user_id uuid references users(id) on delete set null,
  action        text not null,                          -- 例如 'record.create'，清單見下方
  target_type   text not null,
  target_id     text not null,
  target_label  text not null,                          -- 例如 'alice.dev-in.tw'，target 刪除後仍看得懂
  metadata      jsonb not null default '{}',
  ip            inet,                                   -- 90 天後由清理工作設為 null
  request_id    text,
  created_at    timestamptz not null default now()
);
create index audit_target_idx on audit_logs (target_type, target_id, created_at desc);
create index audit_actor_idx  on audit_logs (actor_user_id, created_at desc);

create table idempotency_keys (
  user_id         uuid not null references users(id) on delete cascade,
  key             text not null,
  request_hash    text not null,                        -- sha256(method + path + body)
  response_status int not null,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  primary key (user_id, key)
);                                                      -- 24 小時後清除

create table settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
-- 鍵：registration_open (bool)、review_mode ('risk'|'all'|'none')、zone_snapshot ({recordCount, plan, at})
```

**稽核 action 清單**：`auth.login`、`auth.logout`、`session.revoke`、`user.delete`、`subdomain.create`、`subdomain.approve`、`subdomain.reject`、`subdomain.update`、`subdomain.release`、`subdomain.suspend`、`subdomain.unsuspend`、`record.create`、`record.replace`、`record.delete`、`record.sync_failed`、`record.drift_corrected`、`preset.apply`、`transfer.create`、`transfer.accept`、`transfer.decline`、`transfer.cancel`、`transfer.expire`、`report.create`、`report.resolve`、`user.suspend`、`user.unsuspend`、`user.quota_change`、`reserved.add`、`reserved.remove`、`zone.reconcile`、`settings.update`。

**資料保存**：session 過期 7 天後刪除；audit 保留 1 年，`ip` 90 天後清空；idempotency key 保留 24 小時；name hold 到期後刪除。全部由 worker 每日的 housekeeping 任務處理。

### 3.6 API 設計

**基本規約**
- Base：`https://dev-in.tw/api/v1`（版本放在路徑上）。`/api/healthz`、`/api/readyz`、`/api/openapi.json`、`/api/docs`（Scalar）不帶版本。
- 只接受 `application/json`。對外欄位一律 camelCase。時間用 ISO 8601（含時區）。ID 用 UUIDv7。
- 子網域以**名稱**當作路徑參數（`/subdomains/alice`），可讀性好，也不會洩漏內部 ID。紀錄用 UUID。
- 分頁：cursor 制，`?cursor=&limit=`（1–100，預設 20），回傳 `{ items, nextCursor }`。
- 冪等：建立子網域、新增紀錄、套用 preset 都接受 `Idempotency-Key`（用 UUID）。同一個 key 但 body 不同時回 `422 IDEMPOTENCY_KEY_REUSED`。
- 併發控制：`PUT` 與 `DELETE` 紀錄時帶 `If-Match: "<version>"`，版本不符回 `412 VERSION_CONFLICT`。
- 寫入 DNS 一律回 **202**，紀錄的 `syncStatus` 是 `pending`。最終狀態透過 SSE 推送，或重新 GET 取得。

**中介層順序**：`requestId` → `clientIp`（`TRUSTED_PROXY_HOPS`）→ `wideLog` → `securityHeaders` → `problem`（錯誤處理）→ `session`（解析 cookie 或 Bearer token）→ `csrf`（只檢查非 GET 方法）→ `rateLimit`（依路由設定）→ route → zod 驗證（`@hono/zod-openapi` 的 hook 把錯誤轉成 problem 格式）。

**錯誤格式**：RFC 9457 `application/problem+json`，加上擴充欄位 `code`、`requestId`、`errors`。

```json
{
  "type": "https://dev-in.tw/problems/record-conflict",
  "title": "Record conflicts with an existing record",
  "status": 409,
  "code": "RECORD_CONFLICT",
  "detail": "alice.dev-in.tw 已有 CNAME，不能再新增其他類型的紀錄",
  "instance": "/api/v1/subdomains/alice/records",
  "requestId": "01JA8…",
  "errors": [{ "path": "name", "code": "CNAME_EXCLUSIVE", "message": "同名已存在 CNAME" }]
}
```

`detail` 是給使用者看的繁中訊息。前端**依 `code` 做邏輯判斷，不解析 `detail`**。5xx 一律只回通用訊息，但會帶 `requestId`。上游錯誤（Cloudflare、GitHub）只回 `UPSTREAM_*` 代碼，不轉發原文。

**端點總表**（完整的 zod 合約見 §5.3）

| 名稱（client 方法） | Method & Path | Auth | 成功狀態 |
|---|---|---|---|
| getMeta | GET `/meta` | public | 200 |
| getStats | GET `/stats` | public | 200 |
| getStatus | GET `/status` | public | 200 |
| listDirectory | GET `/directory` | public | 200 |
| checkAvailability | GET `/availability/{name}` | public | 200 |
| listPresets | GET `/presets` | public | 200 |
| createReport | POST `/reports` | public（Turnstile） | 201 |
| startGithubLogin | GET `/auth/github/start?redirect=` | public | 302 |
| githubCallback | GET `/auth/github/callback` | public | 303 |
| devLogin | POST `/auth/dev-login`（**production 時直接拒絕啟動**） | public | 204 |
| logout | POST `/auth/logout` | user | 204 |
| getMe / updateMe / deleteMe | GET / PATCH / DELETE `/me` | user | 200 / 200 / 202 |
| listSessions / revokeSession / revokeOtherSessions | GET `/me/sessions`、DELETE `/me/sessions/{sessionId}`、POST `/me/sessions/revoke-others` | user | 200 / 204 / 204 |
| listMyActivity | GET `/me/activity` | user | 200 |
| events | GET `/events`（`text/event-stream`） | user | 200 |
| listSubdomains / createSubdomain | GET / POST `/subdomains` | user | 200 / 201 |
| getSubdomain / updateSubdomain | GET / PATCH `/subdomains/{name}` | user（owner） | 200 |
| releaseSubdomain | POST `/subdomains/{name}/release` | owner | 202 |
| listSubdomainActivity | GET `/subdomains/{name}/activity` | owner | 200 |
| getPropagation | GET `/subdomains/{name}/propagation?recordName=&type=` | owner | 200 |
| listRecords / createRecord | GET / POST `/subdomains/{name}/records` | owner | 200 / 202 |
| replaceRecord / deleteRecord | PUT / DELETE `/subdomains/{name}/records/{recordId}` | owner | 202 |
| retryRecordSync | POST `/subdomains/{name}/records/{recordId}/retry` | owner | 202 |
| planPreset / applyPreset | POST `/subdomains/{name}/presets/{presetId}/plan`、`/apply` | owner | 200 / 202 |
| createTransfer | POST `/subdomains/{name}/transfer` | owner | 201 |
| listTransfers | GET `/transfers` | user | 200 |
| acceptTransfer / declineTransfer / cancelTransfer | POST `/transfers/{transferId}/{accept,decline,cancel}` | 收件人 / 收件人 / 寄件人 | 200 |
| adminOverview | GET `/admin/overview` | admin | 200 |
| adminListUsers / adminUpdateUser | GET `/admin/users`、PATCH `/admin/users/{userId}` | admin | 200 |
| adminListSubdomains | GET `/admin/subdomains` | admin | 200 |
| adminApprove / adminReject / adminSuspend / adminUnsuspend | POST `/admin/subdomains/{name}/{approve,reject,suspend,unsuspend}` | admin | 200 |
| adminListReports / adminResolveReport | GET `/admin/reports`、PATCH `/admin/reports/{reportId}` | admin | 200 |
| adminListReserved / adminAddReserved / adminRemoveReserved | GET / POST `/admin/reserved-names`、DELETE `/admin/reserved-names/{name}` | admin | 200 / 201 / 204 |
| adminAuditLog | GET `/admin/audit-logs` | admin | 200 |
| adminZone / adminReconcile | GET `/admin/zone`、POST `/admin/zone/reconcile` | admin | 200 / 202 |
| adminGetSettings / adminUpdateSettings | GET / PATCH `/admin/settings` | admin | 200 |

**權限不足時的回應**：存取別人的子網域一律回 **404**（`NOT_FOUND`），不回 403，避免透露存在與否。非 admin 存取 `/admin/*` 回 404。

**限流**（in-memory token bucket，replicas=1；擴充時改用 PG 計數或 Redis）

| 範圍 | Key | 額度 |
|---|---|---|
| 全域 | IP | 300 / 分 |
| `GET /availability/*` | IP | 60 / 分（burst 20） |
| `/auth/github/*` | IP | 20 / 分 |
| `POST /subdomains` | user | 5 / 天 |
| 紀錄寫入（create、replace、delete、retry） | user | 10 / 分，60 / 時 |
| `presets/*/apply` | user | 20 / 時 |
| `GET /propagation` | user | 12 / 分 |
| `POST /reports` | IP | 5 / 時 |
| `GET /events` | user | 同時最多 5 條連線 |

超過時回 `429`、`Retry-After`，以及 `code: RATE_LIMITED`。

### 3.7 驗證與 Session

**登入流程（GitHub OAuth App + PKCE S256 + state）**

```
1. GET /api/v1/auth/github/start?redirect=/dashboard
   - 驗證 redirect：必須以 "/" 開頭，不能以 "//" 或 "/\" 開頭，長度 ≤ 200；不合格就改成 /dashboard
   - state = 32 bytes 亂數（base64url）、verifier = 32 bytes 亂數，challenge = BASE64URL(SHA256(verifier))
   - Set-Cookie: __Host-dit_oauth=<HMAC 簽章後的 {state, verifier, redirect, exp}>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600
   - 302 → https://github.com/login/oauth/authorize?client_id&redirect_uri=<GITHUB_REDIRECT_URI>
           &scope=user:email&state&code_challenge&code_challenge_method=S256&allow_signup=true
     （不要求 read:user：GET /user 不需要它就能讀到公開資料，read:user 會額外授權私人 profile 欄位）
2. GET /api/v1/auth/github/callback?code&state
   - 讀 __Host-dit_oauth，驗證 HMAC 與期限，用 timingSafeEqual 比對 state；用完立刻清掉 cookie
   - POST https://github.com/login/oauth/access_token（client_id、client_secret、code、redirect_uri、code_verifier），Accept: application/json，逾時 5 秒
   - GET /user、GET /user/emails（取 primary 且 verified 的那一個；沒有就存 null）
   - **access token 用完即丟**，不存 DB 也不寫進 log
   - 以 github_id upsert：更新 login、avatar、email、last_login_at；若 github_id 列在 ADMIN_GITHUB_IDS 就設成 admin
   - 已停權 → 303 到 /login?error=suspended
   - 建立 session：token = 32 bytes 亂數；在 sessions 表存 id = sha256(token)
   - Set-Cookie: __Host-dit_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=5184000（60 天，等於 absolute 期限；實際有效與否以 server 端的 idle 與 absolute 期限為準）
   - 303 → redirect；寫一筆 audit auth.login
3. 每個請求：用 sha256(cookie) 查 session（同一個請求內記住結果）
   - 檢查 revoked_at、idle 與 absolute 期限、users.status
   - last_seen_at 超過 1 小時才更新，並同時把 idle_expires_at 延長 14 天
4. POST /api/v1/auth/logout：撤銷 session（設定 revoked_at）並清除 cookie
```

**CSRF 防護**：使用者子網域與 apex 同站，所以 **SameSite 不足以防禦**。
- 對所有 POST、PUT、PATCH、DELETE：
  - `Origin` 必須**完全等於** `APP_ORIGIN`（`https://dev-in.tw`），缺少 `Origin` 就拒絕；
  - 如果有 `Sec-Fetch-Site`，它必須是 `same-origin`，`same-site` 也要拒絕；
  - 有 body 時 `Content-Type` 必須是 `application/json`，這樣可以擋掉 simple form POST。
- 只帶 `Authorization: Bearer <PAT>`、沒有 cookie 的請求（P2）跳過 CSRF 檢查。
- 錯誤時回 `403 CSRF_REJECTED`。

**Cookie tossing**：所有 cookie 都用 `__Host-` 前綴，子網域無法覆寫或預先植入。前端**不**讀任何 cookie。

**安全標頭**
- API：`X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin`、`Cross-Origin-Resource-Policy: same-origin`、`Cache-Control: no-store`（認證相關路徑）。
- Web：
  - `Strict-Transport-Security: max-age=63072000`（**不加** includeSubDomains，見 §6 Q14）；
  - CSP：`default-src 'self'; script-src 'self' 'nonce-…' 'strict-dynamic' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; img-src 'self' https://avatars.githubusercontent.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://github.com`；
  - **決定**：`/dashboard/*`、`/admin/*`、`/login`、`/claim/*` 由 `proxy.ts` 產生 nonce，使用上面這份嚴格 CSP（這些頁面本來就是動態渲染）。行銷頁（`/`、`/explore`、`/docs/*`、`/status`、法務頁）維持靜態，使用不含 nonce 的版本：`script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com`，其餘指令相同。這些頁面沒有登入後的資料，風險可以接受。
  - `Permissions-Policy` 關閉不需要的功能。

**角色**：`user`、`admin`。`ADMIN_GITHUB_IDS`（以逗號分隔的 numeric id）在每次登入時同步。如果有人被移出清單，下次登入就降回 user。admin 的寫入操作一律寫稽核紀錄。

**本機與 e2e**：`AUTH_DEV_LOGIN=true` 時開放 `POST /auth/dev-login {githubLogin}`，用假的 GitHub 身分建立 session。`NODE_ENV=production` 時如果這個值為 true，**直接拒絕啟動**。

### 3.8 Cloudflare 同步策略

**原則**：DB 是期望狀態（desired state），Cloudflare 是實際狀態（actual state）。所有寫入都先進 DB，再由 worker 收斂到一致。

**DnsProvider port**

```ts
export interface ProviderRecordInput {
  fqdn: string; type: RecordType; ttl: number; content?: string; priority?: number;
  data?: Record<string, unknown>;          // SRV、CAA 用
  comment: string;                         // 所有權標記："dit:<recordId>"
}
export interface ProviderRecord extends ProviderRecordInput { id: string; modifiedAt: string; }
export interface DnsProvider {
  listAll(): AsyncIterable<ProviderRecord>;                       // 自動分頁
  create(input: ProviderRecordInput): Promise<ProviderRecord>;
  replace(id: string, input: ProviderRecordInput): Promise<ProviderRecord>;  // PUT：type 相同時才用
  delete(id: string): Promise<void>;                              // 404 也視為成功
  batch(ops: { deletes: string[]; replaces: { id: string; input: ProviderRecordInput }[];
               creates: ProviderRecordInput[] }): Promise<{ created: ProviderRecord[]; replaced: ProviderRecord[] }>;
  zoneInfo(): Promise<{ plan: string | null; recordCount: number }>;
}
```

實作有兩個：`CloudflareProvider`（正式）與 `MemoryProvider`（本機與測試，`DNS_PROVIDER=memory`）。這個 port 有實際用途：§6 Q1 如果決定改用自架 DNS（Lazco 的 `cloud-infra-dns`），只要再寫一個 adapter。

**寫入路徑（以新增紀錄為例）**

```
API（單一交易）：
  SELECT … FROM subdomains WHERE name=$1 AND owner_id=$2 FOR UPDATE   -- 同一個子網域的寫入序列化
  檢查：子網域是 active、紀錄配額、zone 容量、packages/dns 的各項規則（含 CNAME 排他）
  INSERT dns_records（version=1, sync_status='pending'）
  INSERT dns_sync_jobs（kind='upsert_record', record_id）ON CONFLICT（coalesce index）DO NOTHING
  INSERT audit_logs
  NOTIFY dns_sync
→ 202 { record }
```

**Worker**（與 API 同一個 process，`WORKER_ENABLED=true`；用 `LISTEN dns_sync` 喚醒，並每 5 秒保底輪詢）

```
取工作：UPDATE dns_sync_jobs SET status='running', locked_until=now()+'60s', attempts=attempts+1
        WHERE id IN (SELECT id FROM dns_sync_jobs WHERE status='queued' AND run_at<=now()
                     ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 10) RETURNING *
（running 但 locked_until 已過期的工作，由 sweeper 放回 queued）

upsert_record：
  r = 讀取紀錄的最新狀態（被刪就略過）
  if r.provider_record_id is null:
      先找 provider 上 comment = 'dit:<r.id>' 的紀錄（處理上次逾時但實際已建立的情況）→ 找到就接手
      找不到就 create
  elif r.provider_type != r.type:
      batch { deletes:[provider_record_id], creates:[new] }      -- Cloudflare 已禁止就地改 type
  else:
      replace(provider_record_id, new)
  成功：UPDATE … SET provider_record_id, provider_type, applied_version=$v,
        sync_status = CASE WHEN version=$v THEN 'synced' ELSE 'pending' END（版本又變了就保持 pending 並重新排入）
  → NOTIFY user_events（SSE 推送 record.sync）

delete_record：provider.delete → 刪掉 DB 紀錄 → 推送
purge_subdomain（釋出或停權）：
  用 batch 刪除該子網域所有 provider_record_id
  再掃一次 provider 上 scope 內、comment 為 dit: 開頭的紀錄（掃孤兒）
  釋出：刪除 subdomain，寫入 name_holds；停權：紀錄保留，sync_status='pending'，provider_record_id 設為 null
restore_subdomain（解除停權）：替每一筆紀錄排入 upsert_record
```

**錯誤分類**（`adapters/cloudflare/errors.ts`，比照 Lazco `rethrow<Domain>Error` 的模式）

| 類型 | 例子 | 處理方式 |
|---|---|---|
| 永久錯誤（使用者造成） | 81053/81057（紀錄已存在、衝突）、9000 系列驗證錯誤 | `sync_status='error'`，存可讀的 `sync_error_code`，不重試，通知使用者 |
| 容量 | 81045 Record quota exceeded | 標記 error（`ZONE_CAPACITY_EXHAUSTED`），把 `settings.registration_open` 設為 false，通知 admin |
| 暫時錯誤 | 429、5xx、逾時、連線錯誤 | 指數退避加 jitter：5s、30s、2m、10m、30m、1h、2h、4h，最多 8 次；之後設為 `dead`，紀錄 `error`，通知 admin |
| 認證 | 401、403（token 失效） | 暫停整個 worker 5 分鐘，通知 admin，`/status` 顯示 degraded |

**Reconciler**：每 `RECONCILE_INTERVAL_SECONDS`（預設 600）執行一次，用 `pg_try_advisory_lock` 確保只有一個實例在跑。
1. `listAll()`，依 comment 標記與 `(fqdn, type)` 建立索引。
2. DB 中 `synced` 的紀錄如果 provider 上不見了，標記 `pending` 並重新排入。
3. 內容不一致時重新排入，寫稽核 `record.drift_corrected`。
4. provider 上有 `dit:` 標記、但 DB 找不到對應紀錄的，屬於孤兒，直接刪除。**大量刪除煞車**：如果這一輪預計刪除的孤兒超過 `RECONCILE_MAX_ORPHAN_DELETES`（預設 10 筆），或超過受管紀錄的 10%，就**整輪中止、完全不刪**，發 Discord 告警，並在 `/admin/zone` 顯示待確認。只有 admin 呼叫 `POST /admin/zone/reconcile?force=true` 才能放行。這是為了防止 `DATABASE_URL` 指錯、DB 是空的或還原到舊版本時，一次把整個 zone 刪光。
5. 名稱落在某個使用者子網域範圍內、但**沒有** `dit:` 標記的紀錄，屬於 `unmanaged`。只回報給 admin，**不自動刪除**。
6. 名稱在 `SYSTEM_RECORD_NAMES` 裡的永遠不碰。
7. 把 `zone_snapshot`（recordCount、plan）寫進 `settings`，供容量閘門與 `/status` 使用。

**環境安全閥**
- `DNS_PROVIDER` 在 `NODE_ENV` 不是 `production` 時**預設為 `memory`**。本機要連真的 Cloudflare 必須明確設定。
- `DNS_PROVIDER=cloudflare` 搭配 `AUTH_DEV_LOGIN=true` 時**拒絕啟動**。
- 啟動時印出（並寫進 `/admin/zone`）目前連到的 zone 名稱與 ID。如果 `CLOUDFLARE_ZONE_ID` 對應的 zone 名稱不等於 `ROOT_DOMAIN`，拒絕啟動。

**一致性模型**：最終一致。正常情況下 202 之後 1 秒內就會 synced。UI 一定要顯示 pending 狀態（§4.4）。DR 時：還原 DB，跑一次 reconcile，就能重建整個 zone。

**CF API token**：權限只給 `Zone:DNS:Edit` 與 `Zone:Read`，只限 `dev-in.tw` 這個 zone，並開啟 **Client IP filtering**，限定為 Dokploy 主機的出口 IP。

### 3.9 DNS 驗證規則（`packages/dns`，前後端共用）

**子網域名稱（註冊用的 label）**
- `^(?!.*--)[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`：3–32 字元，禁止 `--`，這也一併擋掉了 `xn--`。禁止底線。
- 1–2 字元的名稱屬於 `premium`，MVP 一律不可註冊；P2 再加管理員指派的端點（DB 與合約的 `SubdomainName` 已允許 1–63 字元，不需要遷移）。
- 依序檢查：格式 → `reserved_names`（含啟動時自動匯入的 zone 既有名稱，類別 `zone`）→ 是否已被註冊 → `name_holds` → 全域容量。
- **風險檢查**（不阻擋，改成送 `pending_review`）：
  - 長度 **< 5** 的 brand（例如 `x`、`pi`、`aws`、`line`、`meta`、`gov`、`cht`）**只做完全比對**，命中就視為保留字，不做近似比對，也不做子字串比對。否則 `alex`、`nextjs`、`pipeline`、`online`、`metal` 這類正常名稱都會被送審；
  - 長度 ≥ 5 的 brand 才做近似比對：先做 leet 正規化（0→o、1→l/i、3→e、4→a、5→s、7→t、`-` 移除），結果相同或編輯距離 ≤ 1；
  - 長度 ≥ 5 的 brand 才做子字串比對，例如 `paypal-login`、`ctbc-bank`；
  - **誤判防護測試**（WP-A 必備）：`alex nextjs pipeline online olive metal bird laws api-tools xavier linear postgres pixel` 這組一般名稱必須回 `available`，不能是 `review`；
  - GitHub 帳號年齡 < `MIN_GITHUB_ACCOUNT_AGE_DAYS`（預設 30）；
  - `settings.review_mode = 'all'`。
- 建議名稱：可用的變化形，例如 `<name>-dev`、`<name>tw`、`<github_login>`，最多 5 個。

**紀錄名稱**（相對於子網域）
- `@` 或 1–3 個 label，每個 label 符合 `_?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?`。
- 允許底線，因為 `_acme-challenge`、`_github-pages-challenge-<user>`、`_vercel`、`_dmarc`、`_atproto`、`_discord`、SRV 的 `_svc._proto` 都需要。
- 完整 FQDN 不可超過 253 字元。不允許 wildcard（`*`），預設 P2 也不開。

**各類型規則**

| 類型 | 欄位 | 規則 |
|---|---|---|
| A | `address` | IPv4，**必須是公網 unicast**。拒絕 `0/8`、`10/8`、`100.64/10`、`127/8`、`169.254/16`、`172.16/12`、`192.0.0/24`、`192.0.2/24`、`192.168/16`、`198.18/15`、`198.51.100/24`、`203.0.113/24`、`224/4`、`240/4`、`255.255.255.255` |
| AAAA | `address` | IPv6，必須在 `2000::/3` 之內。拒絕 `::/128`、`::1`、`::ffff:0:0/96`、`64:ff9b::/96`、`100::/64`、`2001:db8::/32`、`fc00::/7`、`fe80::/10`、`ff00::/8` |
| CNAME | `target` | 合法的 hostname，不能是 IP。不能指向自己或形成環。指向 `*.dev-in.tw` 時，**只能指向自己擁有的子網域**。**排他性**：同一個名稱有 CNAME，就不能有其他紀錄，反之亦然 |
| TXT | `value` | 1–2,048 字元的可列印 ASCII；超過 255 字元由 provider 自動拆段。每個名稱最多 5 筆 |
| MX | `priority`, `exchange` | priority 0–65535；exchange 是 hostname，不能是 CNAME 目標，也不能是 IP |
| SRV（P1） | `priority`, `weight`, `port`, `target` | 名稱必須是 `_svc._proto[.label]`，`_proto` ∈ {`_tcp`, `_udp`, `_tls`} |
| CAA（P1） | `flags`, `tag`, `value` | flags ∈ {0, 128}；tag ∈ {`issue`, `issuewild`, `iodef`} |
| NS | – | **不開放**（ADR-007） |

- **TTL**：`1`（自動）或 60–86,400 秒。
- **proxied**：合約中沒有這個欄位，provider 一律送 `false`（ADR-007）。
- **重複**：相同的 `(name, type, data)` 不可重複出現。

**Presets**（`packages/dns/presets.ts`，宣告式，輸入參數後產生 `RecordInput[]`）

| id | 參數 | 產生的紀錄 |
|---|---|---|
| `github-pages` | `githubUser`（預設為登入者）、`verifyToken?` | `@ CNAME <githubUser>.github.io`；如果填了 `verifyToken`，加 `_github-pages-challenge-<githubUser> TXT <verifyToken>` |
| `vercel` | `target`（預設 `cname.vercel-dns.com`，可貼上 Vercel 提供的專屬值）、`verifyTxt?` | `@ CNAME <target>`；可選 `_vercel TXT` |
| `netlify` | `site` | `@ CNAME <site>.netlify.app` |
| `cloudflare-pages` | `project` | `@ CNAME <project>.pages.dev` |
| `zeabur`、`render`、`fly`（P1） | 依平台而定 | CNAME 或 A/AAAA |
| `bluesky`（P1） | `did` | `_atproto TXT did=<did>` |
| `improvmx`（P1） | – | `@ MX 10 mx1.improvmx.com`、`@ MX 20 mx2.improvmx.com`、`@ TXT v=spf1 include:spf.improvmx.com ~all` |
| `google-site-verification`（P1） | `token` | `@ TXT google-site-verification=<token>` |

`plan` 會回傳 `{creates, deletes, warnings}`，例如「現有的 `@ A` 會和 CNAME 衝突，套用時一併刪除」。`apply` 用 batch 一次送出。

### 3.10 濫用防護

| 威脅 | 對策 |
|---|---|
| 搶註、囤積名稱 | 每人上限（預設 1）、全域容量閘門、每天最多申請 5 次、需要 GitHub 帳號、帳號未滿 30 天要審核、釋出後冷卻 30 天 |
| 釣魚（品牌、同形字） | 禁止 `xn--` 與 `--`；brand 保留清單（含台灣金融、政府、電商、電信，見附錄 A）；leet 與編輯距離偵測後送審；檢舉後可一鍵停權 |
| 惡意內容、C2 | AUP 明文禁止；公開檢舉表單加 Turnstile；停權撤下 CF 紀錄；P2 加 Safe Browsing 或 URLhaus 定期掃描 |
| DNS rebinding、內網探測 | A/AAAA 只允許公網位址 |
| 子網域接管（dangling） | P2 偵測器：定期檢查 CNAME 指向的常見平台是否回傳「找不到站台」的特徵頁，通知擁有者，14 天後自動停用 |
| NS 委派濫用 | 不開放 |
| 利用 zone 擁有者的 Cloudflare 帳號（橘雲） | 不開放 proxied |
| 自動化灌量 | 限流（§3.6）、Turnstile（申請與檢舉）、登入必須走 GitHub |
| Session 竊取、CSRF、cookie tossing | §3.7 |
| 管理員帳號被盜 | admin 綁 GitHub numeric id；建議管理員的 GitHub 帳號啟用 2FA 或 passkey；P2 為 admin 加 WebAuthn step-up |
| 接收前擁有者的 email | 名稱冷卻期；轉移時可選擇不保留紀錄 |
| Let's Encrypt 額度被耗盡 | §3.1 (3) |

### 3.11 可觀測性

- **日誌**：pino JSON 輸出到 stdout（Dokploy 會收）。遵循 Lazco `docs/logging-guide.md` 的 **wide event** 原則：
  - 每個 HTTP 請求只輸出一行，欄位包含 `request_id`、`route`、`method`、`status`、`duration_ms`、`user_id`、`subdomain`、`error_code`、`db_ms`、`provider_calls`、`rate_limited`、`ip_hash`；
  - 每個 sync job 一行：`job_id`、`kind`、`record_id`、`attempt`、`outcome`、`provider_status`、`provider_error_code`、`duration_ms`；
  - **禁止**記錄 cookie、token、OAuth code、完整的 email。
- **Request ID**：沿用 Traefik 帶來的 `X-Request-Id`，沒有就自己產生；在回應標頭與 problem body 都回傳。
- **Metrics**（`METRICS_ENABLED`，預設關閉，綁在內部的 `:9464/metrics`，不經 Traefik）：`dit_sync_queue_depth`、`dit_sync_job_duration_seconds`、`dit_provider_errors_total{code}`、`dit_zone_records_used`、`dit_zone_records_limit`、`dit_logins_total`、`dit_http_requests_total{route,status}`。
- **錯誤追蹤**：可選 `SENTRY_DSN`（可用自架 GlitchTip），預設關閉。
- **告警**（Discord webhook，`DISCORD_WEBHOOK_URL`）：job 進入 dead、Cloudflare 認證失敗、zone 使用量 ≥ 80% 與 ≥ 95%、新檢舉、新的待審子網域、reconcile 漂移超過 5 筆。
- **公開狀態**：`/api/v1/status` 加上 `/status` 頁面。

### 3.12 測試策略

| 層級 | 工具 | 範圍 |
|---|---|---|
| 純規則 | Vitest、fast-check | `packages/dns` 的表格測試：IP 範圍邊界、名稱規則、CNAME 排他、preset 產出、leet 與編輯距離。property-based 測試正規化必須冪等。**覆蓋率 ≥ 95%** |
| 合約 | Vitest | 每個 fixture 都要能被 schema parse；endpoint map 的路徑不得重複；錯誤碼清單必須和文件一致 |
| API 單元與整合 | Vitest、**PGlite**（Postgres WASM，快速）、`MemoryProvider` | use case 與 route：權限（IDOR 回 404）、CSRF（缺 Origin、Origin 錯誤、`Sec-Fetch-Site: same-site` 都要回 403）、限流、冪等、`If-Match`、配額、審核分流 |
| Queue 與 worker | Vitest 搭配**真的 Postgres 18**（compose 或 CI service container） | `SKIP LOCKED` 併發取件不重複；退避；逾時後靠 comment 標記接手；改 type 走 batch；版本競態；reconcile 的四種漂移 |
| Cloudflare adapter | Vitest 搭配 msw/node，用錄好的回應 | envelope 解析、錯誤分類、分頁、batch |
| 合約一致性 | Vitest | 對 `endpoints` 裡每一項：路由存在，用 fixture 打 MemoryProvider 版的 API，回應要能被 response schema parse；`/api/openapi.json` 和 endpoint map 的路徑集合相同 |
| 前端元件 | Vitest、Testing Library | DNS 編輯器依類型切換欄位、驗證訊息、presets 的 diff、可用性狀態機 |
| E2E | Playwright | 兩種模式：(1) 對 mock server（WP-B 自己的 CI）；(2) 對 compose 起的真實堆疊，用 dev-login 加 MemoryProvider（WP-C）。流程：申請 → 新增紀錄 → 看到 synced → 改 type → 刪除；admin 審核；檢舉；轉移 |
| 無障礙 | `@axe-core/playwright` | 每個主要頁面 0 個 serious 或 critical 問題；`prefers-reduced-motion` 模式下截圖不得有動畫殘影 |
| 線上冒煙（可選） | Vitest，用 `CF_LIVE_TEST=1` 開啟 | 對真實 zone 的 `_e2e-<random>.dev-in.tw` 做建立、讀取、刪除，結束後清理 |

### 3.13 部署

**Dokploy 配置**
- **Postgres**：Dokploy Database service，映像 `postgres:18-alpine`，記憶體上限 256 MB（`shared_buffers=64MB`、`max_connections=30`），每日備份到 S3（Lazco Garage），保留 14 天。
- **api**：Application，Build type Dockerfile，`apps/api/Dockerfile`，build context 為 repo 根目錄；Watch paths 設 `apps/api/**`、`packages/**`、`pnpm-lock.yaml`。push 到 main 時自動部署。
  - Domain：`dev-in.tw`，Path `/api`（**不 strip**，Hono 用 `basePath('/api')`）。Traefik 以規則長度決定優先序，所以這條比 web 的 Host 規則優先。
  - Swarm：replicas 1；`update_config.order=start-first`，讓部署時不中斷；記憶體上限 192 MB。
- **web**：Application，`apps/web/Dockerfile`；Watch paths 設 `apps/web/**`、`packages/contract/**`、`pnpm-lock.yaml`。
  - Domain：`dev-in.tw`；`www.dev-in.tw` 用 Dokploy 的 redirect middleware 301 到 apex。
  - 記憶體上限 320 MB，replicas 1。
- 預估總記憶體約 650 MB 上限，實際使用約 350 MB。
- Apex 與 www 在 Cloudflare 設為 **DNS only（灰雲）**，讓 Traefik 自行用 Let's Encrypt HTTP-01 取得憑證，`X-Forwarded-For` 只信任一層 Traefik。如果日後要開橘雲，`clientIp` 改讀 `CF-Connecting-IP`，並且只信任 Cloudflare 的 IP 段。

**`apps/api/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/contract/package.json packages/contract/
COPY packages/dns/package.json packages/dns/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @dit/api...
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/api ./apps/api
# tsdown 把 workspace 套件與所有依賴打包成 dist/server.mjs 與 dist/migrate.mjs（noExternal: 全部）
# migrations/*.sql 複製到 dist/migrations
RUN pnpm --filter @dit/api build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/healthz >/dev/null || exit 1
CMD ["sh", "-c", "node dist/migrate.mjs && exec node --enable-source-maps dist/server.mjs"]
```

- 打包時如果遇到原生模組或動態 require 的問題，fallback 改用 `pnpm deploy --filter @dit/api --prod /out`。
- `migrate.mjs` 用 drizzle-orm 的 migrator，並以 `pg_advisory_lock` 包住，避免 start-first 部署時兩個實例同時跑 migration。
- 收到 SIGTERM 時：停止接新請求，等待執行中的 job（最多 20 秒），關閉 SSE 與 DB 連線。

**`apps/web/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/contract/package.json packages/contract/
COPY packages/dns/package.json packages/dns/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @dit/web...
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @dit/web build          # next.config：output 'standalone'、outputFileTracingRoot = repo 根目錄

FROM node:24-alpine AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1
CMD ["node", "apps/web/server.js"]
```

前端**完全不用 `NEXT_PUBLIC_*`**。Turnstile site key、root domain、各項上限都在 runtime 從 `GET /api/v1/meta` 取得，所以同一個映像可以用在任何環境，也不需要 build args。

**健康檢查**
- `GET /api/healthz`：liveness，只確認 process 存活，回 200 `{ok:true}`。
- `GET /api/readyz`：檢查 DB `select 1` 在 1 秒內完成，worker loop 最後一次心跳在 30 秒內；任一失敗回 503。
- `GET /healthz`（web）：回 200。

**環境變數**（全部由 Infisical 注入；api 以 zod 驗證，缺值就啟動失敗）

| 變數 | 服務 | 必填 | 預設或範例 | 說明 |
|---|---|---|---|---|
| `NODE_ENV` | 兩者 | ✓ | `production` | |
| `PORT` | 兩者 | | api `3001`、web `3000` | |
| `APP_ORIGIN` | 兩者 | ✓ | `https://dev-in.tw` | CSRF 比對、redirect、OG 的 metadataBase |
| `API_INTERNAL_URL` | web | ✓ | `http://<dokploy-api-service>:3001` | RSC 在 server 端打 API；`next.config` 的 `/api` rewrite（本機開發）也用它 |
| `DATABASE_URL` | api | ✓ | `postgres://dit:…@dit-postgres:5432/dit` | |
| `SESSION_SECRET` | api | ✓ | 至少 32 bytes 的亂數 | OAuth cookie 的 HMAC |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | api | ✓ | | 新建的 OAuth App |
| `GITHUB_REDIRECT_URI` | api | ✓ | `https://dev-in.tw/api/v1/auth/github/callback` | |
| `ADMIN_GITHUB_IDS` | api | ✓ | `12345678,87654321` | GitHub 的 numeric id |
| `ROOT_DOMAIN` | api | ✓ | `dev-in.tw` | |
| `DNS_PROVIDER` | api | | production 時為 `cloudflare`，其他環境為 `memory` | 搭配 `AUTH_DEV_LOGIN=true` 時不可設為 cloudflare |
| `RECONCILE_MAX_ORPHAN_DELETES` | api | | `10` | 大量刪除煞車（另有 10% 的比例上限） |
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ZONE_ID` | api | provider 為 cloudflare 時必填 | | 最小權限加 IP filtering |
| `ZONE_RECORD_LIMIT` | api | ✓ | `200` | 依 §6 Q1 的查詢結果設定 |
| `ZONE_HEADROOM` | api | | `20` | 保留給系統紀錄 |
| `SYSTEM_RECORD_NAMES` | api | | `@,www,api,_dmarc,_psl,mail` | reconciler 永遠不碰 |
| `MAX_SUBDOMAINS_PER_USER` | api | | `1` | |
| `MAX_RECORDS_PER_SUBDOMAIN` | api | | `10` | |
| `MIN_GITHUB_ACCOUNT_AGE_DAYS` | api | | `30` | |
| `NAME_COOLDOWN_DAYS` | api | | `30` | |
| `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` | api | ✓ | 本機用 `1x0000…` 測試金鑰 | site key 透過 `/meta` 下發給前端 |
| `TURNSTILE_EXPECTED_HOSTNAME` | api | | `dev-in.tw` | |
| `REPORT_IP_SALT` | api | ✓ | 亂數 | |
| `TRUSTED_PROXY_HOPS` | api | | `1` | |
| `WORKER_ENABLED` | api | | `true` | |
| `RECONCILE_INTERVAL_SECONDS` | api | | `600` | |
| `AUTH_DEV_LOGIN` | api | | `false` | production 時設為 true 會拒絕啟動 |
| `LOG_LEVEL` | api | | `info` | |
| `DISCORD_WEBHOOK_URL` | api | | | 告警 |
| `SENTRY_DSN` | 兩者 | | | 可選 |
| `METRICS_ENABLED` | api | | `false` | |

### 3.14 舊資料銷毀與金鑰輪替（上線前必做）

「資料可以清空」在這裡的意思是**排程銷毀**，不是放著不管：
1. 舊 MongoDB：`dropDatabase`，連同 volume 與 Dokploy、Zeabur 上的備份與快照一起刪除。檢查本機與 S3 有沒有任何 dump（`~/Project/Lazco/db-dumps-20260911` 已確認沒有 Dev-in.tw 的資料）。
2. Cloudflare zone：先 export BIND 檔留存（只留在擁有者本機），再刪除所有非系統紀錄。
3. 撤銷舊的 GitHub OAuth App secret（建議直接建一個新的 OAuth App）；撤銷舊的 Cloudflare API token；作廢舊的 `JWT_SECRET`。
4. 刪除 Zeabur 上的舊服務。
5. 在 Discord 與首頁公告：舊帳號與子網域已清除，請重新申請。如果要保留舊名稱的優先權，見 §6 Q18。
6. 把執行紀錄（時間、執行人、清單）寫成一份簡短的處理紀錄，作為個資處理的佐證。

---

## 4. UI/UX 改造

### 4.1 資訊架構（Sitemap）

```
公開
├─ /                     Landing（終端機 Hero、可用性查詢、運作方式、統計、最新成員）
├─ /claim/[name]         查詢結果與申請流程（未登入時，申請步驟前先導去登入）
├─ /explore              公開成員牆與台灣點陣地圖（P1）
├─ /docs, /docs/[slug]   教學：GitHub Pages、Vercel、Netlify、Cloudflare Pages、Email、Bluesky、FAQ
├─ /status               狀態頁（P1，P0 先做精簡版）
├─ /report               檢舉（可帶 ?name=）
├─ /terms, /privacy, /aup
└─ /login                說明會取得哪些資料，再用 GitHub 登入；顯示錯誤狀態

登入後（/dashboard）
├─ /dashboard                    總覽：子網域卡片、配額儀表、待處理的轉移、最近活動
├─ /dashboard/[name]             子網域總覽：狀態、快速設定（presets）、傳播檢查
│  ├─ /records                   DNS 編輯器
│  ├─ /settings                  描述、公開展示、轉移、釋出（危險區）
│  └─ /activity                  稽核時間軸
├─ /dashboard/transfers          收到的與送出的轉移
└─ /settings                     個人資料（唯讀，來自 GitHub）、裝置與 session、刪除帳號

管理（/admin，role=admin）
├─ /admin              總覽：待審數、未處理檢舉、同步失敗、zone 用量
├─ /admin/review       審核佇列
├─ /admin/reports      檢舉佇列
├─ /admin/subdomains   搜尋與篩選、停權與解除
├─ /admin/users        搜尋、停權、配額覆寫
├─ /admin/reserved     保留字
├─ /admin/audit        稽核紀錄
├─ /admin/zone         zone 儀表、漂移報告、立即對帳（P1）
└─ /admin/settings     註冊開關、審核模式（P1）

全域：⌘K / Ctrl+K 指令面板、`/` 聚焦搜尋、Skip link、主題切換（系統／淺／深）
```

### 4.2 設計語言：「Zone file × 台灣藍鵲」

**概念**：把 DNS 的 zone file（等寬、對齊的欄位、`IN A`）當成視覺母題，配色取自台灣特有種**台灣藍鵲**（深藍的身體、紅色的喙與腳、黑頭、白色尾端）。淺色模式像印在紙上的 RFC，深色模式像夜裡的終端機。**刻意不用**玻璃擬態、大面積漸層、通用 SaaS 卡片。

**字體**
- 介面：**Geist**（Latin）加 **Noto Sans TC**（CJK，用 next/font/google 的 unicode-range 切片，`preload: false`）。
- 資料與程式碼：**Geist Mono**。子網域名稱、DNS 值、指令一律用等寬字型，數字用 `font-variant-numeric: tabular-nums`。
- Hero 標語：**jf open 粉圓**（justfont，OFL 授權，台灣字型），只用在 Hero 一句話，用 `pyftsubset` 預先子集化到約 20 KB 以內，透過 `next/font/local` 載入。
- 字級（流體尺寸）：`--step-0: clamp(1rem, .96rem + .2vw, 1.125rem)`，以 1.25 倍率往上：step-1 到 step-5，Hero 的 `DEV-IN.TW` 用 step-6，等於 `clamp(3rem, 1.5rem + 7vw, 8rem)`。

**色彩 token**（OKLCH；兩種模式都定義在 `:root` 與 `.dark`；上線前用 culori 寫腳本檢查對比，納入 CI）

| Token | 淺色（紙） | 深色（夜） | 用途 |
|---|---|---|---|
| `--bg` | `oklch(0.985 0.006 95)` | `oklch(0.165 0.015 262)` | 背景 |
| `--surface` | `oklch(0.965 0.008 95)` | `oklch(0.205 0.018 262)` | 區塊 |
| `--ink` | `oklch(0.24 0.02 262)` | `oklch(0.94 0.012 95)` | 主要文字（對比 ≥ 12:1） |
| `--ink-muted` | `oklch(0.47 0.02 262)` | `oklch(0.72 0.015 262)` | 次要文字（≥ 4.5:1） |
| `--rule` | `oklch(0.88 0.01 262)` | `oklch(0.32 0.02 262)` | 1px 分隔線、格線 |
| `--magpie`（鵲藍） | `oklch(0.50 0.19 262)` | `oklch(0.72 0.15 262)` | 品牌色、連結、focus ring |
| `--beak`（鵲喙紅） | `oklch(0.58 0.21 33)` | `oklch(0.70 0.18 33)` | 強調、主要 CTA hover、選取 |
| `--signal`（訊號綠） | `oklch(0.52 0.15 150)` | `oklch(0.78 0.17 150)` | 可用、已同步 |
| `--amber` | `oklch(0.60 0.14 75)` | `oklch(0.82 0.15 80)` | pending、審核中 |
| `--danger` | `oklch(0.55 0.21 25)` | `oklch(0.68 0.19 25)` | 錯誤、停權、刪除 |

**形狀與質感**
- 圓角 6px（`--radius`），按鈕與輸入框 6px，Dialog 10px。
- 只用 1px `--rule` 線條加 4px 位移硬陰影（`box-shadow: 4px 4px 0 var(--rule)`），營造印刷感。
- 背景用 16px 點陣格（`radial-gradient` dots），並用 mask 淡出。

**元件風格**
- 狀態徽章採 zone file 寫法，例如 `[ SYNCED ]`、`[ PENDING ]`：方括號加等寬字型，搭配圖示，不只靠顏色辨識。
- 主要按鈕實心鵲藍，hover 時底線轉成鵲喙紅。
- 次要按鈕只有外框線。
- 危險按鈕用 danger 外框，確認對話框內才是實心。

**主題**：next-themes 的 `attribute="class"`、`defaultTheme="system"`，切換器有系統、淺、深三種狀態。主題切換本身用 View Transition 做圓形擴散（從按鈕位置展開，搭配 `clip-path: circle()`；reduced-motion 時直接切換）。

### 4.3 主要畫面規格

**Landing `/`**（Server Component；只有動畫元件是 client island）
1. **Hero**：
   - 左側是大字 `DEV-IN.TW`（Geist Mono，step-6）加粉圓標語「給臺灣開發者的一個名字」。
   - 主體是一個**終端機提示列**：`$ claim ▌.dev-in.tw`，游標閃爍，輸入框就嵌在提示列裡，`.dev-in.tw` 後綴緊跟著輸入的文字。
   - 下方是即時結果行（§4.4 #1）。按 Enter 或「申請」進入 `/claim/<name>`。
   - 背景是台灣點陣地圖 canvas（§4.4 #2），放在右側或後方。
2. **Ticker**：「剛剛 · `alice.dev-in.tw` 加入」橫向跑馬燈，只顯示 opt-in 的成員，hover 時暫停，旁邊有暫停按鈕。
3. **運作方式**：三個步驟（登入 → 申請 → 指向），以 zone file 行的樣式呈現，捲動時逐行出現，連接線跟著畫出（scroll-driven）。
4. **一鍵設定**：GitHub Pages、Vercel、Netlify、Cloudflare Pages 卡片，點擊後展開預覽會產生的紀錄。
5. **統計**：子網域數、成員數、紀錄數，用 odometer 效果。
6. **頁尾**：AUP、隱私、檢舉、狀態、GitHub、Discord、`security.txt`。

**Claim `/claim/[name]`**
- 頂部是同一個終端機提示列，可以繼續修改名稱。
- 結果卡依狀態顯示：
  - `available`：綠色，加「申請」CTA；
  - `review`：琥珀色，說明需要人工審核及原因；
  - `taken`、`reserved`、`invalid`、`cooldown`、`capacity_full`：各自的說明，加上**建議名稱**列（可點選）。
- 申請步驟（單頁三段，不用 Dialog）：
  ① 名稱確認；② 用途描述（可選，280 字以內）與 AUP 摘要，附條款連結與同意勾選；③ Turnstile 與送出。
- 沒登入時，按「申請」→ `/login?redirect=/claim/<name>`，登入後回到原頁且狀態保留。
- 成功後顯示**開通票券**動畫（§4.4 #4），CTA「設定 DNS」→ `/dashboard/<name>`。

**Login `/login`**
- 中央卡片：說明會讀取 GitHub 的公開資料與主要 email，**不會**存取 repo，也不會保存 GitHub token。
- 按鈕「使用 GitHub 登入」。錯誤狀態依 `?error=` 顯示：`suspended`、`oauth_failed`、`state_mismatch`。

**Dashboard `/dashboard`**
- 頁首：「哈囉，<login>」加上配額儀表：`子網域 1/1`、`zone 容量 132/200`（只有 admin 看得到 zone 容量；一般使用者在容量低於 10% 時才看到提示）。
- 子網域卡片：等寬大字 `alice.dev-in.tw`、狀態徽章、紀錄數、最後同步時間、快捷操作（開啟網站、管理 DNS、複製網址）。卡片和詳細頁共用 `view-transition-name`。
- 空狀態：終端機提示列加上「申請你的第一個子網域」。
- 側欄（≥ 1024px）或底部分頁（手機）：Dashboard、Transfers、Settings、Docs、Admin（僅 admin）。

**子網域詳細 `/dashboard/[name]`**
- 頁首：名稱（從 dashboard 卡片 morph 過來）、狀態、`開啟網站 ↗`、`複製`。
- 分頁：總覽、紀錄、設定、活動（URL 驅動，切換時有 view transition）。
- 總覽分頁：
  - 快速設定區：preset 卡片 → 參數表單 → **diff 預覽**（`+ @ CNAME octocat.github.io`、`- @ A 1.2.3.4`）→ 套用；
  - 傳播檢查面板：四個 resolver 的結果燈號（P1）；
  - 審核中或停權時顯示說明橫幅。

**DNS 編輯器 `/dashboard/[name]/records`**（本產品的核心畫面）
- 表格是 **zone file 行**：`NAME  TTL  TYPE  VALUE  STATUS  ACTIONS`，用 CSS subgrid 對齊欄位，全部等寬字型。NAME 顯示相對名稱，hover 時顯示完整 FQDN。
- 每一列都可以**選取與複製**，VALUE 旁有複製按鈕。
- 新增：表頭下方固定一列「新增紀錄」輸入列，鍵盤操作優先：
  - TYPE 下拉（A、AAAA、CNAME、TXT、MX，P1 加 SRV、CAA）；
  - 依類型切換欄位：MX 多出 priority，SRV 多出 priority、weight、port、target，CAA 多出 flags、tag、value；
  - NAME 預設 `@`，輸入時即時預覽 FQDN；
  - TTL 選單（自動、1 分、5 分、1 時、1 天）；
  - 即時用 `packages/dns` 驗證，例如「`10.0.0.1` 是私有位址，外部無法連線」；
  - 送出後**樂觀插入**一列 pending。
- 編輯：點列或按 Enter 進入行內編輯，Esc 取消，⌘Enter 儲存。送出時帶 `If-Match`，遇到 412 顯示「這筆紀錄已在別處被修改」，並提供重新載入或覆蓋。
- 刪除：先畫刪除線，同時出現 5 秒的 Undo toast，5 秒後才真正送出 DELETE。
- 同步狀態欄：`[ PENDING ]` 掃描線 → `[ SYNCED ✓ ]`；`[ ERROR ]` 可展開錯誤說明並提供「重試」。
- 頂部資訊列：`5 / 10 筆`、「CNAME 與其他紀錄不能同名」等提示，以及「切換成原始碼模式」（P2）。
- 手機版：每列改成卡片堆疊，欄位垂直排列；新增列改成底部 sheet。

**Admin**
- 共通：資料密集的表格（TanStack Table），可篩選、排序，cursor 分頁，每一列可以展開詳細。
- 所有危險操作都要填理由，送出後寫入稽核。
- `/admin/review`：每一列顯示名稱、申請人（GitHub 頭像、login、帳號年齡、公開 repo 數）、風險原因 chips、描述，操作為核准、駁回並填理由；快捷鍵 `a` 核准、`r` 駁回、`j/k` 上下移動。
- `/admin/reports`：檢舉內容、被檢舉子網域的即時 DNS 紀錄與擁有者，操作為「停權並結案」、「駁回」。
- `/admin/zone`（P1）：容量量表、漂移清單、「立即對帳」按鈕，dead job 列表可重試；被煞車擋下的對帳結果會醒目顯示，必須再按一次並輸入 `force` 確認才會執行。

**其他**
- `/explore`：成員格狀牆（頭像、子網域、描述），加上台灣點陣地圖，hover 成員卡片時，地圖上對應的點會亮起。
- `/status`：每個元件的狀態列加上最近 90 次檢查的 uptime 條，以及同步佇列深度。
- 404：終端機風格 `NXDOMAIN: 這個頁面不存在`，下方附搜尋列。

### 4.4 動畫與互動（可直接實作）

全域 motion token：

```css
:root{
  --dur-1:120ms; --dur-2:200ms; --dur-3:360ms; --dur-4:700ms;
  --ease-out:cubic-bezier(.22,1,.36,1); --ease-in-out:cubic-bezier(.65,0,.35,1);
}
```

Motion 的 spring 設定為 `{ type:"spring", stiffness:420, damping:32 }`。任何動畫都不能阻擋輸入。

| # | 點子 | 實作細節 | reduced-motion 時 |
|---|---|---|---|
| 1 | **終端機式可用性回饋** | 輸入 debounce 300ms 後，結果行先顯示 `resolving…`，三個點依序點亮（模擬向三個 resolver 查詢，總長 ≤ 400ms，結果先回來就提前結束）。結果出現後逐字顯示（每字 8ms，上限 200ms）：`NXDOMAIN → 可以申請 ✓`（訊號綠）或 `NOERROR → 已被使用`（danger）。指示燈用 Motion `layoutId` 在 idle、checking、ok、no 之間 morph。`.dev-in.tw` 後綴以 spring 貼合在輸入文字後方 | 直接顯示結果文字，不逐字、不點亮 |
| 2 | **台灣點陣地圖** | 離線從 Natural Earth（public domain）的台灣、澎湖、金門、馬祖、蘭嶼、綠島多邊形取 0.02° 格點，約 2,500 點，存成 JSON（約 15 KB）。用 **WebGL2 point sprites 一次 draw call** 渲染（不支援時退回 Canvas2D）。每個公開成員以 `hash(name)` 對應到一個點並點亮；有新成員加入（SSE 公開事件或載入時取最新 10 筆）時產生 ripple。滑鼠視差 ≤ 8px。用 `next/dynamic` 且 `ssr:false`，在 `requestIdleCallback` 之後才載入；離開視窗（IntersectionObserver）或分頁隱藏時暫停；DPR 上限 1.5；畫布設 `aria-hidden` | 靜態 SVG，沒有 ripple |
| 3 | **捲動驅動的「運作方式」** | 純 CSS：`animation-timeline: view(); animation-range: entry 10% cover 40%;`，zone file 行由左往右展開（`clip-path: inset(0 100% 0 0)` 到 `inset(0)`），連接線用 SVG `stroke-dashoffset` 隨捲動畫出。包在 `@supports (animation-timeline: view())` 內，不支援時直接顯示 | 靜態 |
| 4 | **開通票券** | 申請成功後，卡片以 `rotateY(180deg)` 翻面（`perspective: 1200px`，`--dur-4`），背面是票券：`alice.dev-in.tw`、序號（第 N 位成員）、開通時間、QR code（連到子網域）。下方的「傳播中」進度環由真實的 propagation API 驅動，每 3 秒輪詢，四個 resolver 都看到之後才畫滿 | 不翻面，直接顯示票券；進度環改為文字百分比 |
| 5 | **共享元素轉場** | React 19.3 的 `<ViewTransition name={\`sub-${name}\`}>` 包住子網域名稱：從 claim 結果、dashboard 卡片到詳細頁頁首都會 morph。分頁切換用 `<ViewTransition enter="slide-in" exit="slide-out">`，在 CSS 定義 `::view-transition-old/new(.slide-in)` | 全域 `@media (prefers-reduced-motion: reduce){ ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*){ animation:none !important } }` |
| 6 | **同步狀態動畫** | pending：`[ PENDING ]` 底下有一條 1px 掃描線，以 `background-position` 由左往右無限循環，1.2s 一圈。收到 SSE 的 synced 後：狀態換成 `[ SYNCED ]`，旁邊的勾勾用 SVG `stroke-dashoffset` 畫出（240ms），整列背景以 `--signal` 10% 透明度閃一下再淡出（600ms）。error：整列水平晃動 ±2px 兩次（160ms），錯誤說明用 `interpolate-size: allow-keywords` 搭配 `height:auto` 展開 | 不晃動、不閃爍、不掃描，只改文字與顏色 |
| 7 | **樂觀插入與刪除** | 新增列用 Motion `layout` 加 `initial={{opacity:0,y:-4}}`。刪除先套刪除線（`text-decoration-color` 過渡），列高再用 `layout` 收合；Undo 時反向播放 | 立即出現或消失 |
| 8 | **Preset diff 預覽** | `+`、`-` 行像 git diff 一樣逐行 stagger（每行 30ms）；套用後 `+` 行「落」進下方的紀錄表（用 FLIP，Motion `layoutId` 從 diff 行移動到表格列） | 直接顯示 |
| 9 | **⌘K 指令面板** | 用 `cmdk`，外觀是終端機。輸入時即時做語法上色，例如 `add cname www alice.github.io` 會把 type、name、value 分色。支援的指令：`claim <name>`、`go <name>`、`add <type> <name> <value> [ttl]`（解析後開啟已預填的新增列）、`dig <name>`（顯示該名稱的傳播結果）、`theme light\|dark\|system`、`logout`。按 ↑ 可以叫出歷史（localStorage） | 無影響（沒有動畫） |
| 10 | **Odometer 統計數字** | 純 CSS：`@property --n { syntax:'<integer>'; inherits:false; initial-value:0 }`，搭配 `counter-reset: n var(--n)` 與 `content: counter(n)`，進入視窗時才轉換到目標值（800ms） | 直接顯示最終數字 |
| 11 | **主題切換** | `document.startViewTransition` 加 `clip-path: circle(0 at x y)` 到 `circle(150% at x y)` | 直接切換 |
| 12 | **Popover 與 Dialog 進場** | 用 `@starting-style` 加 `transition-behavior: allow-discrete`，Dialog 從 `scale(.98)` 與 `opacity 0` 進場；tooltip 用 CSS anchor positioning（不支援時退回 Radix） | 只做淡入 |
| 13 | **游標光暈** | 卡片在 `pointermove` 時更新 `--x`、`--y`，`background: radial-gradient(240px at var(--x) var(--y), color-mix(in oklch, var(--magpie) 10%, transparent), transparent)`；只在 `(hover:hover) and (pointer:fine)` 時啟用 | 關閉 |
| 14 | **彩蛋** | 在指令面板輸入 `dig dev-in.tw`，會以 ASCII art 顯示台灣藍鵲並列出系統紀錄 | 無影響 |

**效能預算**
- Landing 首屏 JS ≤ 160 KB gzip（WebGL chunk 另外延遲載入，≤ 25 KB）；LCP ≤ 2.0s（行動 4G）；CLS < 0.05。
- 所有 canvas 與迴圈動畫在 `document.hidden` 時暫停。
- 只動 `transform`、`opacity`、`clip-path`。

### 4.5 無障礙

- **縮放**：移除 `maximumScale` 與 `userScalable:false`（修正 D-24）。
- **reduced motion**：
  - Motion 全域設 `<MotionConfig reducedMotion="user">`，再加上 CSS media query 雙重保險；
  - 所有超過 5 秒的循環動畫（跑馬燈、掃描線、地圖 ripple）都要有可見的**暫停控制**（WCAG 2.2.2）；
  - 在 Playwright 用 `reducedMotion: 'reduce'` 跑一輪截圖，確認沒有動畫殘影。
- **鍵盤**：
  - 所有功能都能用鍵盤完成；Tab 順序符合視覺順序；Dialog 與 sheet 鎖住焦點，關閉後焦點回到觸發元素；
  - DNS 表格的行內編輯支援 Enter、Esc、⌘Enter；
  - 全域快捷鍵：`/` 聚焦搜尋、⌘K 開啟指令面板、`?` 顯示快捷鍵說明；
  - 所有快捷鍵都要能在設定裡關閉（WCAG 2.1.4）。
- **焦點**：2px `--magpie` 外框加 2px offset，用 `:focus-visible`，兩種主題下對比都 ≥ 3:1。
- **對比**：文字 ≥ 4.5:1，大字與 UI 元件 ≥ 3:1（WCAG 2.2 AA），在 CI 用腳本檢查所有 token 組合。狀態一律同時有圖示、文字、顏色，不只靠顏色。
- **動態內容**：
  - 可用性結果放在 `aria-live="polite"`，只播報最終結果，不播報 `resolving…`；
  - 同步狀態變化用 polite 播報，例如「www CNAME 已同步」；
  - 錯誤用 `role="alert"`。
- **表單**：每個欄位都有 `<label>`；說明與錯誤用 `aria-describedby` 連結；網域相關輸入設 `autocapitalize="none" autocomplete="off" spellcheck="false"`，IP 欄位設 `inputmode="decimal"`。
- **目標尺寸**：可點擊區域至少 24×24px（WCAG 2.5.8），icon 按鈕 32×32px。
- **語言**：`<html lang="zh-Hant">`，整句英文的區塊加 `lang="en"`。
- **可複製**：移除 `select-none`（修正 D-25）。
- **自動檢查**：axe 對每個主要頁面在兩種主題下都要 0 個 serious 或 critical 問題；手動用 VoiceOver 走一次申請流程。

---

## 5. 工作包與 API 合約

### 5.0 流程與分工

```
WP0（單一 agent，約 0.5 天）──合併到 main，合約凍結──┬─▶ WP-A 後端（branch wp-a/backend）──┐
                                                    └─▶ WP-B 前端（branch wp-b/frontend）──┴─▶ WP-C 整合與上線
```

**檔案所有權**（各包只能改自己的範圍，避免衝突）

| 路徑 | WP0 | WP-A | WP-B |
|---|---|---|---|
| 根目錄設定、CI | 建立 | 只能在 `ci.yml` 的 api job 中修改 | 只能在 `ci.yml` 的 web job 中修改 |
| `packages/contract/**` | 建立並凍結 | 只能做**新增性**變更，且必須寫變更紀錄 | 唯讀 |
| `packages/dns/**` | 建立型別與 stub | **擁有**（實作與測試） | 唯讀 |
| `apps/api/**` | 空殼 | 擁有 | 不碰 |
| `apps/web/**` | 空殼 | 不碰 | 擁有 |

**合約變更流程**
- 新增性變更（新的 optional 欄位、新端點、新錯誤碼）：由 WP-A 修改，在 `docs/PLAN.md` 的「合約變更紀錄」加一行（日期、內容、原因），合併到 main。WP-B 定期 **merge main 進自己的 branch**（不 rebase）後跟進。
- **破壞性變更**（刪除或改名欄位、改型別、改路徑）：禁止，必須經擁有者核准。
- 兩邊都依 `main` 上的合約版本工作，一律用 `git merge`，不 rebase、不 force push。

### 5.1 WP0：Scaffold 與合約（先做）

**範圍**
1. 建立 `Dev-in-tw/dev-in.tw`（AGPL-3.0），clone 到 `/Users/haco/Project/Lazco/Dev-in.tw/dev-in.tw/`。
2. 根目錄：
   - `package.json`，`packageManager: pnpm@10.x`，`engines.node: ">=24"`；TypeScript 用最新穩定版（撰寫時為 **7.x**，原生編譯器；如果某個工具還不支援，web 可以暫時鎖 6.x，並在 AGENTS.md 註明）；
   - `pnpm-workspace.yaml`、`biome.json`、`tsconfig.base.json`（§3.4）、`.editorconfig`、`.gitignore`、`.nvmrc`（`24`）；
   - `compose.dev.yml`（postgres:18-alpine）；
   - `AGENTS.md`（開發規則摘要：指令、所有權、合約規則、commit 規範）與 `CLAUDE.md`（指向 AGENTS.md）；
   - `docs/PLAN.md`（複製本檔）、`docs/adr/0001…0008.md`（附錄 B）。
3. `packages/contract`：§5.3 的完整內容、`fixtures.ts`（每個 response schema 至少一個合法範例，涵蓋各種狀態），以及測試：fixture 都能 parse、路徑不重複。
4. `packages/dns`：匯出所有函式的**簽章**（§5.3 末段）。實作先回傳「全部合法」，加上 `TODO(WP-A)` 註記；presets 的定義可以先寫好。
5. `apps/api`、`apps/web`：可以 build 的最小空殼，分別有 `/api/healthz` 與 `/healthz`。
6. CI：`biome ci` → `pnpm -r typecheck` → `pnpm -r test` → `pnpm -r build`，兩個 Dockerfile 的 build 也要跑。

**完成條件**：上述 CI 全部通過；`pnpm --filter @dit/contract test` 通過；合併到 main 並打 tag `contract-v1`。

### 5.2 WP-A：後端（apps/api + packages/dns）

**範圍**
- `packages/dns` 完整實作（§3.9），覆蓋率 ≥ 95%。
- DB schema、migrations、seed（保留字見附錄 A）。啟動時把 zone 既有的名稱以 `zone` 類別匯入保留字。
- 所有 §3.6 的端點，依 §5.3 合約實作，並以 `@hono/zod-openapi` 產出 `/api/openapi.json` 與 `/api/docs`（Scalar）。
- 認證、session、CSRF、限流、安全標頭（§3.7）。
- Sync queue、worker、reconciler、DnsProvider（Cloudflare 與 Memory 兩種實作）（§3.8）。
- Turnstile、DoH 傳播檢查（P1）、Discord 告警（P1）、SSE（P1）。
- 每日 housekeeping：清除過期 session、idempotency key、name hold，清空 90 天前的 audit IP，處理到期的轉移。
- `apps/api/Dockerfile`、health 與 ready 檢查、graceful shutdown。
- `AUTH_DEV_LOGIN`、`DNS_PROVIDER=memory`，讓 WP-C 和 e2e 不需要真的 GitHub 與 Cloudflare 就能跑。

**P0 與 P1 的切分**：P0 端點必須在 WP-A 完成時全部可用。P1 端點（SSE、propagation、transfers、sessions、directory、stats、activity、zone 與 settings 管理、SRV/CAA）**也要實作**，但如果時間不夠，可以先回 `501 NOT_IMPLEMENTED`（錯誤碼已定義在合約裡），前端會優雅降級。

**完成條件**
- [ ] `pnpm biome ci .` 通過
- [ ] `pnpm --filter @dit/api typecheck` 與 `--filter @dit/dns typecheck` 通過（strict、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`）
- [ ] `pnpm --filter @dit/api test` 與 `--filter @dit/dns test` 通過，包含以下測試：
  - [ ] 合約一致性：endpoint map 的每一項都有實作，回應能被 schema parse，OpenAPI 的路徑集合等於 endpoint map
  - [ ] 安全：IDOR 回 404；CSRF 的三種拒絕情境；`__Host-` cookie 的屬性；callback 的 state 不符時拒絕；redirect 開放轉址防護；被停權的 session 立即失效
  - [ ] 規則：私有 IP、CNAME 排他、跨使用者 CNAME、`xn--`、保留字、冷卻期、配額、容量閘門
  - [ ] Worker（真 Postgres）：併發取件不重複；退避；逾時後靠 comment 接手；改 type 走 batch；版本競態；purge 與 restore；reconcile 的四種漂移
  - [ ] Reconcile 大量刪除煞車：空 DB 對上有 50 筆 `dit:` 紀錄的 provider 時，**一筆都不刪**，並產生告警；`force=true` 才會刪
  - [ ] 環境安全閥：非 production 預設 memory；cloudflare 搭配 dev-login 時拒絕啟動；zone 名稱不符時拒絕啟動
  - [ ] 品牌誤判防護（§3.9 那組一般名稱都必須回 `available`）
  - [ ] 冪等與 `If-Match`
- [ ] `packages/dns` 覆蓋率 ≥ 95%，`modules/identity`、`modules/records`、`sync/*` 覆蓋率 ≥ 85%
- [ ] `pnpm --filter @dit/api build` 通過；`docker build -f apps/api/Dockerfile .` 通過；映像 ≤ 200 MB；以非 root 執行；閒置時 RSS ≤ 120 MB
- [ ] `docker compose`（postgres 加 api，`DNS_PROVIDER=memory`、`AUTH_DEV_LOGIN=true`）啟動後，`/api/readyz` 回 200

### 5.3 API 合約（`packages/contract`，TypeScript + zod 4）

> 這是 WP0 要建立的**實際檔案內容**（依 Biome 格式化後提交）。**已驗證**（2026-10-14，於 repo 外的暫存目錄）：整段合併成單一檔案後，以 `zod@4` 加 TypeScript 7.0.2（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`erasableSyntaxOnly`）`tsc --noEmit` 0 錯誤；Node 24 原生 type stripping 可直接執行；名稱、紀錄名稱、hostname 的 regex 與 `DnsRecord` intersection 的行為抽測符合預期。WP0 拆檔時補上各檔之間的 import 即可。schema 本身不使用 `.transform()`，以免 OpenAPI 產生 input 與 output 不一致；輸入的正規化（轉小寫、去掉結尾的點）由前端在送出前處理，後端在進入驗證前也再做一次。

```ts
// ───────────────────────── src/primitives.ts
import { z } from "zod";

export const Uuid = z.uuid();
export const IsoDateTime = z.iso.datetime({ offset: true });

/** 使用者可自行註冊的 label：3–32 字元、小寫英數與連字號、頭尾不可為連字號、不可含 "--"（同時擋掉 xn--） */
export const SUBDOMAIN_LABEL_RE = /^(?!.*--)[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
export const SubdomainLabel = z.string().regex(SUBDOMAIN_LABEL_RE);
/** 任何已存在的子網域名稱（含日後由管理員指派的 1–2 字元 premium 名稱）；用於路徑參數與回應 */
export const SUBDOMAIN_NAME_RE = /^(?!.*--)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const SubdomainName = z.string().regex(SUBDOMAIN_NAME_RE);

/** 紀錄名稱（相對於子網域）："@" 或 1–3 個 label，label 可以底線開頭 */
const LABEL = "_?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
export const RECORD_NAME_RE = new RegExp(`^(?:@|${LABEL}(?:\\.${LABEL}){0,2})$`);
export const RecordName = z.string().regex(RECORD_NAME_RE);

/** 目標主機名（CNAME、MX、SRV），不含結尾的點 */
export const HOSTNAME_RE =
  /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
export const Hostname = z.string().regex(HOSTNAME_RE);

export const GithubLogin = z.string().regex(/^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/);

export const PageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const page = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const Usage = z.object({ used: z.int().min(0), limit: z.int().min(0) });

export const PublicUser = z.object({
  githubLogin: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.url(),
});
export type PublicUser = z.infer<typeof PublicUser>;

// ───────────────────────── src/errors.ts
export const ErrorCode = z.enum([
  // 通用
  "VALIDATION_FAILED", "NOT_FOUND", "UNAUTHENTICATED", "FORBIDDEN", "CSRF_REJECTED",
  "RATE_LIMITED", "VERSION_CONFLICT", "IDEMPOTENCY_KEY_REUSED", "NOT_IMPLEMENTED", "INTERNAL",
  // 帳號
  "ACCOUNT_SUSPENDED", "REGISTRATION_CLOSED", "TURNSTILE_FAILED", "CONFIRMATION_MISMATCH",
  // 名稱與子網域
  "NAME_INVALID", "NAME_RESERVED", "NAME_TAKEN", "NAME_COOLDOWN",
  "SUBDOMAIN_QUOTA_EXCEEDED", "ZONE_CAPACITY_EXHAUSTED", "SUBDOMAIN_NOT_ACTIVE",
  // 紀錄
  "RECORD_QUOTA_EXCEEDED", "RECORD_CONFLICT", "RECORD_DUPLICATE", "RECORD_TYPE_NOT_ALLOWED",
  "RECORD_TARGET_NOT_ALLOWED", "IP_NOT_PUBLIC", "PRESET_PARAMS_INVALID",
  // 轉移與檢舉
  "TRANSFER_RECIPIENT_NOT_FOUND", "TRANSFER_RECIPIENT_QUOTA", "TRANSFER_INVALID_STATE",
  "TRANSFER_ALREADY_PENDING",
  // 上游
  "UPSTREAM_DNS_ERROR", "UPSTREAM_GITHUB_ERROR",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const FieldIssue = z.object({ path: z.string(), code: z.string(), message: z.string() });

/** RFC 9457 problem details，加上 code、requestId、errors 擴充欄位 */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.int().min(400).max(599),
  code: ErrorCode,
  detail: z.string().optional(),
  instance: z.string().optional(),
  requestId: z.string(),
  errors: z.array(FieldIssue).optional(),
  retryAfter: z.int().optional(),
});
export type Problem = z.infer<typeof Problem>;

// ───────────────────────── src/user.ts
export const Role = z.enum(["user", "admin"]);
export const UserStatus = z.enum(["active", "suspended"]);

export const Me = z.object({
  id: Uuid,
  githubId: z.int(),
  githubLogin: z.string(),
  displayName: z.string().nullable(),
  avatarUrl: z.url(),
  email: z.email().nullable(),
  role: Role,
  status: UserStatus,
  quota: z.object({ subdomains: Usage, recordsPerSubdomain: z.int() }),
  incomingTransfers: z.int().min(0),
  createdAt: IsoDateTime,
});
export type Me = z.infer<typeof Me>;

export const UpdateMeBody = z.object({ displayName: z.string().trim().max(50).nullable() }).partial();
export const DeleteMeBody = z.object({ confirm: z.string() }); // 必須等於 githubLogin

export const Session = z.object({
  id: z.string(), // 對外的 opaque id（非 token hash）
  current: z.boolean(),
  userAgent: z.string().nullable(),
  ipApprox: z.string().nullable(), // 例如 "203.0.113.x"
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
});

// ───────────────────────── src/naming.ts
export const AvailabilityStatus = z.enum([
  "available", "review", "taken", "reserved", "invalid", "cooldown", "capacity_full",
]);
export const Availability = z.object({
  name: z.string(),
  fqdn: z.string(),
  status: AvailabilityStatus,
  reason: z.string().optional(), // 繁中說明
  reviewReasons: z.array(z.string()).optional(), // status=review 時
  suggestions: z.array(SubdomainLabel).max(5),
});
export type Availability = z.infer<typeof Availability>;

// ───────────────────────── src/subdomain.ts
export const SubdomainStatus = z.enum(["pending_review", "active", "suspended", "releasing"]);
export const Subdomain = z.object({
  name: SubdomainName,
  fqdn: z.string(),
  status: SubdomainStatus,
  description: z.string().max(280),
  showInDirectory: z.boolean(),
  records: Usage,
  reviewReasons: z.array(z.string()),
  suspendedReason: z.string().nullable(),
  pendingTransferId: Uuid.nullable(),
  createdAt: IsoDateTime,
  activatedAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
});
export type Subdomain = z.infer<typeof Subdomain>;

export const CreateSubdomainBody = z.object({
  name: SubdomainLabel,
  description: z.string().max(280).default(""),
  acceptTerms: z.literal(true),
  turnstileToken: z.string().min(1),
});
export const UpdateSubdomainBody = z
  .object({ description: z.string().max(280), showInDirectory: z.boolean() })
  .partial();
export const ReleaseSubdomainBody = z.object({ confirm: z.string() }); // 必須等於 name

// ───────────────────────── src/dns.ts
export const RecordType = z.enum(["A", "AAAA", "CNAME", "TXT", "MX", "SRV", "CAA"]);
export type RecordType = z.infer<typeof RecordType>;
export const Ttl = z.union([z.literal(1), z.int().min(60).max(86_400)]);

const common = { name: RecordName, ttl: Ttl };
export const ARecordInput = z.object({ type: z.literal("A"), ...common, address: z.ipv4() });
export const AAAARecordInput = z.object({ type: z.literal("AAAA"), ...common, address: z.ipv6() });
export const CNAMERecordInput = z.object({ type: z.literal("CNAME"), ...common, target: Hostname });
export const TXTRecordInput = z.object({
  type: z.literal("TXT"),
  ...common,
  value: z.string().min(1).max(2048),
});
export const MXRecordInput = z.object({
  type: z.literal("MX"),
  ...common,
  priority: z.int().min(0).max(65_535),
  exchange: Hostname,
});
export const SRVRecordInput = z.object({
  type: z.literal("SRV"),
  ...common,
  priority: z.int().min(0).max(65_535),
  weight: z.int().min(0).max(65_535),
  port: z.int().min(1).max(65_535),
  target: Hostname,
});
export const CAARecordInput = z.object({
  type: z.literal("CAA"),
  ...common,
  flags: z.union([z.literal(0), z.literal(128)]),
  tag: z.enum(["issue", "issuewild", "iodef"]),
  value: z.string().min(1).max(255),
});
export const RecordInput = z.discriminatedUnion("type", [
  ARecordInput, AAAARecordInput, CNAMERecordInput, TXTRecordInput,
  MXRecordInput, SRVRecordInput, CAARecordInput,
]);
export type RecordInput = z.infer<typeof RecordInput>;

export const SyncStatus = z.enum(["pending", "synced", "error", "deleting"]);
export const RecordMeta = z.object({
  id: Uuid,
  fqdn: z.string(),
  version: z.int().positive(),
  syncStatus: SyncStatus,
  syncError: z.object({ code: z.string(), message: z.string() }).nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export const DnsRecord = z.intersection(RecordInput, RecordMeta);
export type DnsRecord = z.infer<typeof DnsRecord>;

export const RecordList = z.object({ items: z.array(DnsRecord), usage: Usage });

export const ResolverId = z.enum(["cloudflare", "google", "quad9", "quad101"]);
export const Propagation = z.object({
  fqdn: z.string(),
  type: RecordType,
  expected: z.array(z.string()),
  resolvers: z.array(
    z.object({
      id: ResolverId,
      label: z.string(), // 例如 "Cloudflare 1.1.1.1"、"TWNIC Quad101"
      answers: z.array(z.string()),
      matches: z.boolean(),
      latencyMs: z.int().nullable(),
      error: z.string().nullable(),
    }),
  ),
  checkedAt: IsoDateTime,
});
export const PropagationQuery = z.object({ recordName: RecordName.default("@"), type: RecordType });

// ───────────────────────── src/preset.ts
export const PresetId = z.enum([
  "github-pages", "vercel", "netlify", "cloudflare-pages",
  "zeabur", "render", "fly", "bluesky", "improvmx", "google-site-verification",
]);
export const Preset = z.object({
  id: PresetId,
  title: z.string(),
  description: z.string(),
  docsSlug: z.string(),
  available: z.boolean(), // P1 的 preset 在後端尚未支援時為 false
  params: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      placeholder: z.string(),
      required: z.boolean(),
      pattern: z.string().optional(), // 前端即時驗證用的 regex 原始碼
      defaultFrom: z.enum(["githubLogin"]).optional(),
    }),
  ),
});
export const PresetBody = z.object({
  recordName: RecordName.default("@"),
  params: z.record(z.string(), z.string().max(255)),
});
export const PresetPlan = z.object({
  creates: z.array(RecordInput),
  deletes: z.array(DnsRecord),
  warnings: z.array(z.string()),
});

// ───────────────────────── src/transfer.ts
export const TransferStatus = z.enum(["pending", "accepted", "declined", "cancelled", "expired"]);
export const Transfer = z.object({
  id: Uuid,
  subdomain: SubdomainName,
  from: PublicUser,
  to: PublicUser,
  status: TransferStatus,
  keepRecords: z.boolean(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export const CreateTransferBody = z.object({
  toGithubLogin: GithubLogin,
  keepRecords: z.boolean().default(true),
});
export const TransferList = z.object({ incoming: z.array(Transfer), outgoing: z.array(Transfer) });

// ───────────────────────── src/report.ts
export const ReportCategory = z.enum(["phishing", "malware", "spam", "illegal", "impersonation", "other"]);
export const ReportStatus = z.enum(["open", "actioned", "dismissed"]);
export const CreateReportBody = z.object({
  subdomain: SubdomainName,
  category: ReportCategory,
  details: z.string().min(10).max(2000),
  contactEmail: z.email().optional(),
  turnstileToken: z.string().min(1),
});
export const ReportReceipt = z.object({ id: Uuid, createdAt: IsoDateTime });

// ───────────────────────── src/public.ts
export const Meta = z.object({
  rootDomain: z.string(),
  turnstileSiteKey: z.string(),
  registrationOpen: z.boolean(),
  limits: z.object({
    subdomainsPerUser: z.int(),
    recordsPerSubdomain: z.int(),
    nameMinLength: z.int(),
    nameMaxLength: z.int(),
  }),
  allowedRecordTypes: z.array(RecordType),
  zoneNearlyFull: z.boolean(), // 使用量 ≥ 90%，一般使用者只看得到這個布林值
  github: z.object({ org: z.url(), discord: z.url().nullable() }),
});
export const DirectoryEntry = z.object({
  name: SubdomainName,
  fqdn: z.string(),
  description: z.string(),
  owner: PublicUser,
  since: IsoDateTime,
});
export const Stats = z.object({
  subdomains: z.int(),
  members: z.int(),
  records: z.int(),
  latest: z.array(DirectoryEntry).max(10),
});
export const ComponentStatus = z.enum(["operational", "degraded", "down"]);
export const ServiceStatus = z.object({
  overall: ComponentStatus,
  components: z.array(
    z.object({
      id: z.enum(["api", "database", "dns_provider", "sync_worker"]),
      status: ComponentStatus,
      detail: z.string().nullable(),
    }),
  ),
  syncQueue: z.object({
    pending: z.int(),
    failed: z.int(),
    oldestPendingSeconds: z.int().nullable(),
  }),
  lastReconcileAt: IsoDateTime.nullable(),
  checkedAt: IsoDateTime,
});
export const AuditEvent = z.object({
  id: Uuid,
  action: z.string(),
  actor: PublicUser.nullable(), // null 代表系統
  actorType: z.enum(["user", "admin", "system"]),
  target: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: IsoDateTime,
});

// ───────────────────────── src/admin.ts
export const AdminUser = z.object({
  id: Uuid,
  githubId: z.int(),
  githubLogin: z.string(),
  avatarUrl: z.url(),
  email: z.email().nullable(),
  role: Role,
  status: UserStatus,
  suspendedReason: z.string().nullable(),
  githubCreatedAt: IsoDateTime,
  subdomainCount: z.int(),
  quotaOverride: z
    .object({ subdomains: z.int().nullable(), recordsPerSubdomain: z.int().nullable() })
    .nullable(),
  createdAt: IsoDateTime,
  lastLoginAt: IsoDateTime,
});
export const AdminUpdateUserBody = z
  .object({
    status: UserStatus,
    reason: z.string().max(500),
    quotaOverride: z
      .object({ subdomains: z.int().min(0).nullable(), recordsPerSubdomain: z.int().min(0).nullable() })
      .nullable(),
  })
  .partial();
export const AdminSubdomain = Subdomain.extend({
  owner: PublicUser.extend({ id: Uuid, githubCreatedAt: IsoDateTime }),
});
export const AdminDecisionBody = z.object({ reason: z.string().max(500).optional() });
export const AdminReasonBody = z.object({ reason: z.string().min(1).max(500) });
export const AdminReport = z.object({
  id: Uuid,
  subdomain: z.string(),
  subdomainExists: z.boolean(),
  category: ReportCategory,
  details: z.string(),
  contactEmail: z.email().nullable(),
  reporter: PublicUser.nullable(),
  status: ReportStatus,
  handledBy: PublicUser.nullable(),
  resolutionNote: z.string().nullable(),
  createdAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
});
export const AdminResolveReportBody = z.object({
  status: z.enum(["actioned", "dismissed"]),
  resolutionNote: z.string().max(1000),
  suspendSubdomain: z.boolean().default(false),
});
export const ReservedCategory = z.enum(["system", "brand", "offensive", "premium", "zone"]);
export const ReservedName = z.object({
  name: z.string(),
  category: ReservedCategory,
  note: z.string().nullable(),
  createdBy: PublicUser.nullable(),
  createdAt: IsoDateTime,
});
export const AddReservedBody = z.object({
  name: z.string().regex(/^[a-z0-9-]{1,63}$/),
  category: ReservedCategory,
  note: z.string().max(200).optional(),
});
export const AdminOverview = z.object({
  pendingReview: z.int(),
  openReports: z.int(),
  failedSyncs: z.int(),
  zone: Usage,
  users: z.int(),
  subdomains: z.int(),
});
export const DriftKind = z.enum(["missing", "modified", "orphan", "unmanaged"]);
export const ZoneReport = z.object({
  plan: z.string().nullable(),
  usage: Usage,
  systemRecords: z.int(),
  managedRecords: z.int(),
  drift: z.array(
    z.object({ kind: DriftKind, fqdn: z.string(), type: z.string(), detail: z.string() }),
  ),
  deadJobs: z.array(
    z.object({ id: z.int(), kind: z.string(), lastError: z.string().nullable(), updatedAt: IsoDateTime }),
  ),
  lastReconcileAt: IsoDateTime.nullable(),
});
export const AdminSettings = z.object({
  registrationOpen: z.boolean(),
  reviewMode: z.enum(["risk", "all", "none"]),
});
export const AuditQuery = PageQuery.extend({
  actorId: Uuid.optional(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  action: z.string().optional(),
});

// ───────────────────────── src/events.ts  （SSE：event 名稱 = type，data = JSON）
export const ServerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("record.sync"),
    subdomain: SubdomainName,
    recordId: Uuid,
    version: z.int(),
    syncStatus: SyncStatus,
    syncError: z.object({ code: z.string(), message: z.string() }).nullable(),
  }),
  z.object({ type: z.literal("record.deleted"), subdomain: SubdomainName, recordId: Uuid }),
  z.object({ type: z.literal("subdomain.status"), subdomain: SubdomainName, status: SubdomainStatus }),
  z.object({ type: z.literal("transfer.updated"), transferId: Uuid, status: TransferStatus }),
  z.object({ type: z.literal("ping"), at: IsoDateTime }), // 每 25 秒一次，避免被 Traefik 的 idle timeout 切斷
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

// ───────────────────────── src/endpoints.ts
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type AuthLevel = "public" | "user" | "admin";

export interface Endpoint {
  method: HttpMethod;
  /** 相對於 /api/v1；路徑參數寫成 {name} */
  path: `/${string}`;
  auth: AuthLevel;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  headers?: readonly ("Idempotency-Key" | "If-Match")[];
  status: 200 | 201 | 202 | 204 | 302 | 303;
  /** null = 沒有 JSON body（204、redirect、SSE） */
  response: z.ZodType | null;
  errors: readonly ErrorCode[];
}

const NameParam = z.object({ name: SubdomainName });
const RecordParams = NameParam.extend({ recordId: Uuid });
const PresetParams = NameParam.extend({ presetId: PresetId });
const TransferParams = z.object({ transferId: Uuid });
const SessionParams = z.object({ sessionId: z.string() });
const UserParams = z.object({ userId: Uuid });
const ReportParams = z.object({ reportId: Uuid });
const ReservedParams = z.object({ name: z.string() });
const AvailabilityParams = z.object({ name: z.string().max(80) }); // 允許不合法的輸入，由回應的 status=invalid 說明原因

const OWNER_ERRORS = ["UNAUTHENTICATED", "NOT_FOUND", "ACCOUNT_SUSPENDED"] as const;
const WRITE_ERRORS = [...OWNER_ERRORS, "CSRF_REJECTED", "RATE_LIMITED", "VALIDATION_FAILED"] as const;

export const endpoints = {
  // 公開
  getMeta: { method: "GET", path: "/meta", auth: "public", status: 200, response: Meta, errors: [] },
  getStats: { method: "GET", path: "/stats", auth: "public", status: 200, response: Stats, errors: [] },
  getStatus: { method: "GET", path: "/status", auth: "public", status: 200, response: ServiceStatus, errors: [] },
  listDirectory: {
    method: "GET", path: "/directory", auth: "public", query: PageQuery, status: 200,
    response: page(DirectoryEntry), errors: [],
  },
  checkAvailability: {
    method: "GET", path: "/availability/{name}", auth: "public", params: AvailabilityParams, status: 200,
    response: Availability, errors: ["RATE_LIMITED"],
  },
  listPresets: {
    method: "GET", path: "/presets", auth: "public", status: 200,
    response: z.object({ items: z.array(Preset) }), errors: [],
  },
  createReport: {
    method: "POST", path: "/reports", auth: "public", body: CreateReportBody, status: 201,
    response: ReportReceipt, errors: ["VALIDATION_FAILED", "TURNSTILE_FAILED", "RATE_LIMITED", "CSRF_REJECTED"],
  },

  // 認證
  startGithubLogin: {
    method: "GET", path: "/auth/github/start", auth: "public",
    query: z.object({ redirect: z.string().max(200).optional() }), status: 302, response: null, errors: [],
  },
  githubCallback: {
    method: "GET", path: "/auth/github/callback", auth: "public",
    query: z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }),
    status: 303, response: null, errors: [],
  },
  devLogin: {
    method: "POST", path: "/auth/dev-login", auth: "public",
    body: z.object({ githubLogin: GithubLogin, role: Role.default("user"), githubAgeDays: z.int().default(365) }),
    status: 204, response: null, errors: ["NOT_FOUND"],
  },
  logout: { method: "POST", path: "/auth/logout", auth: "user", status: 204, response: null, errors: ["CSRF_REJECTED"] },

  // 我
  getMe: { method: "GET", path: "/me", auth: "user", status: 200, response: Me, errors: ["UNAUTHENTICATED"] },
  updateMe: {
    method: "PATCH", path: "/me", auth: "user", body: UpdateMeBody, status: 200, response: Me, errors: WRITE_ERRORS,
  },
  deleteMe: {
    method: "DELETE", path: "/me", auth: "user", body: DeleteMeBody, status: 202, response: null,
    errors: [...WRITE_ERRORS, "CONFIRMATION_MISMATCH"],
  },
  listSessions: {
    method: "GET", path: "/me/sessions", auth: "user", status: 200,
    response: z.object({ items: z.array(Session) }), errors: ["UNAUTHENTICATED"],
  },
  revokeSession: {
    method: "DELETE", path: "/me/sessions/{sessionId}", auth: "user", params: SessionParams, status: 204,
    response: null, errors: WRITE_ERRORS,
  },
  revokeOtherSessions: {
    method: "POST", path: "/me/sessions/revoke-others", auth: "user", status: 204, response: null, errors: WRITE_ERRORS,
  },
  listMyActivity: {
    method: "GET", path: "/me/activity", auth: "user", query: PageQuery, status: 200,
    response: page(AuditEvent), errors: ["UNAUTHENTICATED"],
  },
  events: { method: "GET", path: "/events", auth: "user", status: 200, response: null, errors: ["UNAUTHENTICATED", "RATE_LIMITED"] },

  // 子網域
  listSubdomains: {
    method: "GET", path: "/subdomains", auth: "user", status: 200,
    response: z.object({ items: z.array(Subdomain) }), errors: ["UNAUTHENTICATED"],
  },
  createSubdomain: {
    method: "POST", path: "/subdomains", auth: "user", body: CreateSubdomainBody, headers: ["Idempotency-Key"],
    status: 201, response: Subdomain,
    errors: [
      ...WRITE_ERRORS, "REGISTRATION_CLOSED", "TURNSTILE_FAILED", "NAME_INVALID", "NAME_RESERVED", "NAME_TAKEN",
      "NAME_COOLDOWN", "SUBDOMAIN_QUOTA_EXCEEDED", "ZONE_CAPACITY_EXHAUSTED", "IDEMPOTENCY_KEY_REUSED",
    ],
  },
  getSubdomain: {
    method: "GET", path: "/subdomains/{name}", auth: "user", params: NameParam, status: 200,
    response: Subdomain, errors: OWNER_ERRORS,
  },
  updateSubdomain: {
    method: "PATCH", path: "/subdomains/{name}", auth: "user", params: NameParam, body: UpdateSubdomainBody,
    status: 200, response: Subdomain, errors: WRITE_ERRORS,
  },
  releaseSubdomain: {
    method: "POST", path: "/subdomains/{name}/release", auth: "user", params: NameParam, body: ReleaseSubdomainBody,
    status: 202, response: Subdomain, errors: [...WRITE_ERRORS, "CONFIRMATION_MISMATCH"],
  },
  listSubdomainActivity: {
    method: "GET", path: "/subdomains/{name}/activity", auth: "user", params: NameParam, query: PageQuery,
    status: 200, response: page(AuditEvent), errors: OWNER_ERRORS,
  },
  getPropagation: {
    method: "GET", path: "/subdomains/{name}/propagation", auth: "user", params: NameParam,
    query: PropagationQuery, status: 200, response: Propagation, errors: [...OWNER_ERRORS, "RATE_LIMITED"],
  },

  // 紀錄
  listRecords: {
    method: "GET", path: "/subdomains/{name}/records", auth: "user", params: NameParam, status: 200,
    response: RecordList, errors: OWNER_ERRORS,
  },
  createRecord: {
    method: "POST", path: "/subdomains/{name}/records", auth: "user", params: NameParam, body: RecordInput,
    headers: ["Idempotency-Key"], status: 202, response: DnsRecord,
    errors: [
      ...WRITE_ERRORS, "SUBDOMAIN_NOT_ACTIVE", "RECORD_QUOTA_EXCEEDED", "ZONE_CAPACITY_EXHAUSTED",
      "RECORD_CONFLICT", "RECORD_DUPLICATE", "RECORD_TYPE_NOT_ALLOWED", "RECORD_TARGET_NOT_ALLOWED",
      "IP_NOT_PUBLIC", "IDEMPOTENCY_KEY_REUSED",
    ],
  },
  replaceRecord: {
    method: "PUT", path: "/subdomains/{name}/records/{recordId}", auth: "user", params: RecordParams,
    body: RecordInput, headers: ["If-Match"], status: 202, response: DnsRecord,
    errors: [
      ...WRITE_ERRORS, "SUBDOMAIN_NOT_ACTIVE", "VERSION_CONFLICT", "RECORD_CONFLICT", "RECORD_DUPLICATE",
      "RECORD_TYPE_NOT_ALLOWED", "RECORD_TARGET_NOT_ALLOWED", "IP_NOT_PUBLIC",
    ],
  },
  deleteRecord: {
    method: "DELETE", path: "/subdomains/{name}/records/{recordId}", auth: "user", params: RecordParams,
    headers: ["If-Match"], status: 202, response: DnsRecord, errors: [...WRITE_ERRORS, "VERSION_CONFLICT"],
  },
  retryRecordSync: {
    method: "POST", path: "/subdomains/{name}/records/{recordId}/retry", auth: "user", params: RecordParams,
    status: 202, response: DnsRecord, errors: WRITE_ERRORS,
  },

  // Presets
  planPreset: {
    method: "POST", path: "/subdomains/{name}/presets/{presetId}/plan", auth: "user", params: PresetParams,
    body: PresetBody, status: 200, response: PresetPlan, errors: [...WRITE_ERRORS, "PRESET_PARAMS_INVALID"],
  },
  applyPreset: {
    method: "POST", path: "/subdomains/{name}/presets/{presetId}/apply", auth: "user", params: PresetParams,
    body: PresetBody, headers: ["Idempotency-Key"], status: 202,
    response: z.object({ created: z.array(DnsRecord), deletedIds: z.array(Uuid) }),
    errors: [
      ...WRITE_ERRORS, "PRESET_PARAMS_INVALID", "SUBDOMAIN_NOT_ACTIVE", "RECORD_QUOTA_EXCEEDED",
      "ZONE_CAPACITY_EXHAUSTED", "IDEMPOTENCY_KEY_REUSED",
    ],
  },

  // 轉移
  createTransfer: {
    method: "POST", path: "/subdomains/{name}/transfer", auth: "user", params: NameParam, body: CreateTransferBody,
    status: 201, response: Transfer,
    errors: [...WRITE_ERRORS, "TRANSFER_RECIPIENT_NOT_FOUND", "TRANSFER_ALREADY_PENDING", "SUBDOMAIN_NOT_ACTIVE"],
  },
  listTransfers: {
    method: "GET", path: "/transfers", auth: "user", status: 200, response: TransferList, errors: ["UNAUTHENTICATED"],
  },
  acceptTransfer: {
    method: "POST", path: "/transfers/{transferId}/accept", auth: "user", params: TransferParams, status: 200,
    response: Transfer, errors: [...WRITE_ERRORS, "TRANSFER_INVALID_STATE", "TRANSFER_RECIPIENT_QUOTA"],
  },
  declineTransfer: {
    method: "POST", path: "/transfers/{transferId}/decline", auth: "user", params: TransferParams, status: 200,
    response: Transfer, errors: [...WRITE_ERRORS, "TRANSFER_INVALID_STATE"],
  },
  cancelTransfer: {
    method: "POST", path: "/transfers/{transferId}/cancel", auth: "user", params: TransferParams, status: 200,
    response: Transfer, errors: [...WRITE_ERRORS, "TRANSFER_INVALID_STATE"],
  },

  // 管理
  adminOverview: {
    method: "GET", path: "/admin/overview", auth: "admin", status: 200, response: AdminOverview, errors: ["NOT_FOUND"],
  },
  adminListUsers: {
    method: "GET", path: "/admin/users", auth: "admin",
    query: PageQuery.extend({ q: z.string().max(64).optional(), status: UserStatus.optional() }),
    status: 200, response: page(AdminUser), errors: ["NOT_FOUND"],
  },
  adminUpdateUser: {
    method: "PATCH", path: "/admin/users/{userId}", auth: "admin", params: UserParams, body: AdminUpdateUserBody,
    status: 200, response: AdminUser, errors: WRITE_ERRORS,
  },
  adminListSubdomains: {
    method: "GET", path: "/admin/subdomains", auth: "admin",
    query: PageQuery.extend({ q: z.string().max(64).optional(), status: SubdomainStatus.optional() }),
    status: 200, response: page(AdminSubdomain), errors: ["NOT_FOUND"],
  },
  adminApproveSubdomain: {
    method: "POST", path: "/admin/subdomains/{name}/approve", auth: "admin", params: NameParam,
    body: AdminDecisionBody, status: 200, response: AdminSubdomain,
    errors: [...WRITE_ERRORS, "SUBDOMAIN_NOT_ACTIVE"],
  },
  adminRejectSubdomain: {
    method: "POST", path: "/admin/subdomains/{name}/reject", auth: "admin", params: NameParam,
    body: AdminReasonBody, status: 200, response: AdminSubdomain, errors: WRITE_ERRORS,
  },
  adminSuspendSubdomain: {
    method: "POST", path: "/admin/subdomains/{name}/suspend", auth: "admin", params: NameParam,
    body: AdminReasonBody, status: 200, response: AdminSubdomain, errors: WRITE_ERRORS,
  },
  adminUnsuspendSubdomain: {
    method: "POST", path: "/admin/subdomains/{name}/unsuspend", auth: "admin", params: NameParam,
    body: AdminDecisionBody, status: 200, response: AdminSubdomain, errors: WRITE_ERRORS,
  },
  adminListReports: {
    method: "GET", path: "/admin/reports", auth: "admin",
    query: PageQuery.extend({ status: ReportStatus.optional() }), status: 200, response: page(AdminReport),
    errors: ["NOT_FOUND"],
  },
  adminResolveReport: {
    method: "PATCH", path: "/admin/reports/{reportId}", auth: "admin", params: ReportParams,
    body: AdminResolveReportBody, status: 200, response: AdminReport, errors: WRITE_ERRORS,
  },
  adminListReserved: {
    method: "GET", path: "/admin/reserved-names", auth: "admin",
    query: PageQuery.extend({ q: z.string().max(64).optional(), category: ReservedCategory.optional() }),
    status: 200, response: page(ReservedName), errors: ["NOT_FOUND"],
  },
  adminAddReserved: {
    method: "POST", path: "/admin/reserved-names", auth: "admin", body: AddReservedBody, status: 201,
    response: ReservedName, errors: WRITE_ERRORS,
  },
  adminRemoveReserved: {
    method: "DELETE", path: "/admin/reserved-names/{name}", auth: "admin", params: ReservedParams, status: 204,
    response: null, errors: WRITE_ERRORS,
  },
  adminAuditLog: {
    method: "GET", path: "/admin/audit-logs", auth: "admin", query: AuditQuery, status: 200,
    response: page(AuditEvent), errors: ["NOT_FOUND"],
  },
  adminZone: { method: "GET", path: "/admin/zone", auth: "admin", status: 200, response: ZoneReport, errors: ["NOT_FOUND"] },
  adminReconcile: {
    method: "POST", path: "/admin/zone/reconcile", auth: "admin",
    query: z.object({ force: z.enum(["true", "false"]).default("false") }), // force=true 才能越過大量刪除煞車
    status: 202, response: null, errors: WRITE_ERRORS,
  },
  adminGetSettings: {
    method: "GET", path: "/admin/settings", auth: "admin", status: 200, response: AdminSettings, errors: ["NOT_FOUND"],
  },
  adminUpdateSettings: {
    method: "PATCH", path: "/admin/settings", auth: "admin", body: AdminSettings.partial(), status: 200,
    response: AdminSettings, errors: WRITE_ERRORS,
  },
} as const satisfies Record<string, Endpoint>;

export type Endpoints = typeof endpoints;
export type EndpointName = keyof Endpoints;

// ───────────────────────── src/client.ts  （前端使用；後端測試也可以拿來用）
type Out<T> = T extends z.ZodType ? z.output<T> : void;
type Part<E, K extends "params" | "query" | "body"> = E extends { [P in K]: infer S extends z.ZodType }
  ? z.input<S>
  : never;

export type RequestOf<N extends EndpointName> = {
  params?: Part<Endpoints[N], "params">;
  query?: Part<Endpoints[N], "query">;
  body?: Part<Endpoints[N], "body">;
  idempotencyKey?: string;
  ifMatch?: number;
  signal?: AbortSignal;
};
export type ResponseOf<N extends EndpointName> = Out<Endpoints[N]["response"]>;

export class ApiError extends Error {
  readonly problem: Problem; // 不用 parameter property：要符合 erasableSyntaxOnly（Node 原生 type stripping）
  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.problem = problem;
  }
  get code(): ErrorCode {
    return this.problem.code;
  }
}

export interface ClientOptions {
  baseUrl: string; // 瀏覽器端用 "/api/v1"；RSC 用 `${API_INTERNAL_URL}/api/v1`
  fetch?: typeof fetch;
  headers?: () => HeadersInit | Promise<HeadersInit>; // RSC 用來轉發 cookie
  validateResponses?: boolean; // dev 與測試時為 true
}

export function createClient(opts: ClientOptions) {
  return async function call<N extends EndpointName>(
    name: N,
    req: RequestOf<N> = {} as RequestOf<N>,
  ): Promise<ResponseOf<N>> {
    const ep = endpoints[name] as Endpoint;
    // 實作要點（WP0 完成）：
    // 1. 用 params 替換 {name}（encodeURIComponent），把 query 序列化
    // 2. headers：Content-Type: application/json（有 body 時）、Idempotency-Key、If-Match: `"${ifMatch}"`
    // 3. credentials: "same-origin"；response 不是 2xx 時 parse Problem，丟出 ApiError
    // 4. 204、redirect、SSE 回傳 undefined；validateResponses 為 true 時用 ep.response.parse 檢查
    throw new Error(`not implemented: ${String(name)} ${ep.method} ${ep.path}`);
  };
}
```

**`packages/dns` 匯出簽章**（WP0 先寫 stub，由 WP-A 實作）

```ts
export type Violation = { path: string; code: string; message: string }; // code 對應 FieldIssue.code
export type Verdict = { ok: true } | { ok: false; violations: Violation[] };

export function normalizeLabel(input: string): string;                         // trim、轉小寫、全形轉半形
export function checkLabelSyntax(label: string): Verdict;                      // 3–32、不可含 --、不可有底線
export function leetSkeleton(label: string): string;
export function confusableWith(label: string, brands: readonly string[]): string | null;
export function isPublicIPv4(ip: string): boolean;
export function isPublicIPv6(ip: string): boolean;
export function toFqdn(recordName: string, sub: string, root: string): string;
export function validateRecord(input: RecordInput, ctx: {
  sub: string; root: string;
  existing: readonly DnsRecord[];         // 同一個子網域的其他紀錄（編輯時排除自己）
  ownedSubdomains: readonly string[];     // 用來允許 CNAME 指向自己的其他子網域
  allowedTypes: readonly RecordType[];
}): Verdict;                              // 含 CNAME 排他、重複、TXT 每名稱上限、SRV 名稱格式
export function planPreset(id: PresetId, params: Record<string, string>, ctx: {
  sub: string; root: string; recordName: string; githubLogin: string; existing: readonly DnsRecord[];
}): { creates: RecordInput[]; deletes: DnsRecord[]; warnings: string[] } | Verdict;
export const PRESETS: readonly Preset[];
export const RESERVED_SEED: readonly { name: string; category: ReservedCategory; note?: string }[];
export function toZoneLine(r: DnsRecord): string;    // "www  300  IN  CNAME  alice.github.io."
```

### 5.4 WP-B：前端（apps/web）

**範圍**
- 設計系統：`globals.css` 的 token（§4.2）；調整 shadcn 元件的樣式；字體；主題切換（三種狀態）。icon **只用 lucide**。
- `lib/api.server.ts`：用 `createClient` 加 `cookies()` 轉發，透過 React `cache()` 保證同一個請求只算一次 `getMe`。`lib/api.client.ts`：`baseUrl: "/api/v1"`，搭配 TanStack Query 的 hooks（query key 以 endpoint 名稱加參數組成）。
- `proxy.ts`：沒有 `__Host-dit_session` cookie 時，把 `/dashboard/*` 與 `/admin/*` 導向 `/login?redirect=`。真正的權限判斷在 layout 裡呼叫 `getMe()`；非 admin 進入 `/admin` 直接 `notFound()`。
- §4.1 的所有頁面與 §4.3 的規格；§4.4 動畫的 #1–#13；§4.5 無障礙。
- SSE：`lib/sse.ts` 以 `EventSource('/api/v1/events')` 收事件，依 `ServerEvent` 更新 Query cache。斷線時指數退避重連；如果 SSE 回 501（P1 未完成），改成每 3 秒輪詢 pending 的紀錄。
- **Mock server**（`apps/web/mock/server.ts`，Hono，:3001，`/api/v1/*`）：
  - 用 contract 的 fixtures 加上 in-memory 狀態，實作所有端點的「合理行為」：建立紀錄時先回 pending，1.2 秒後推送 SSE synced；`10.x` 位址回 `IP_NOT_PUBLIC`；名稱 `taken` 回 taken 等；
  - `POST /auth/dev-login` 直接設定 cookie；
  - `pnpm --filter @dit/web dev:mock` 同時啟動 mock 與 next dev，`next.config` 的 rewrite 把 `/api` 轉到 mock。
- 文件：`content/docs/*.mdx`，至少要有 GitHub Pages、Vercel、Netlify、Cloudflare Pages、FAQ、條款、隱私、AUP（法務文字先放草稿，標示「待擁有者確認」）。
- `/.well-known/security.txt`（`Contact: mailto:security@dev-in.tw`、`Expires`、`Preferred-Languages: zh-Hant, en`）。
- `apps/web/Dockerfile`、`/healthz`。

**完成條件**
- [ ] `pnpm biome ci .` 通過
- [ ] `pnpm --filter @dit/web typecheck` 通過（strict、`noUncheckedIndexedAccess`；web 不開 `exactOptionalPropertyTypes`）
- [ ] `pnpm --filter @dit/web test`（Vitest 元件測試）通過：DNS 編輯器依類型切換欄位、驗證訊息、可用性狀態機、preset diff、指令面板的指令解析
- [ ] `pnpm --filter @dit/web e2e`（Playwright 對 mock server）通過：申請流程（未登入 → 登入 → 申請 → 票券）、新增、編輯、改 type、刪除並 Undo、preset 套用、admin 審核、檢舉；以及標記為 **`@p1`** 的 spec：轉移、SSE 即時狀態、傳播檢查、完整狀態頁、session 管理
- [ ] 每個依賴 P1 端點的頁面在收到 `501 NOT_IMPLEMENTED` 時要優雅降級（隱藏入口或顯示「即將推出」），並有一個 e2e 驗證這個行為
- [ ] axe：所有主要頁面在淺色與深色下都是 0 個 serious 或 critical；`reducedMotion: 'reduce'` 下截圖無動畫
- [ ] Lighthouse（mobile，Landing）：Performance ≥ 90、Accessibility 100、Best Practices ≥ 95、SEO 100
- [ ] 無 hydration warning；console 無 error；JS 預算符合 §4.4
- [ ] `pnpm --filter @dit/web build` 通過；`docker build -f apps/web/Dockerfile .` 通過；以非 root 執行；映像 ≤ 250 MB
- [ ] 全站搜尋不到 `localStorage` 存放 token，也沒有任何 `NEXT_PUBLIC_` 變數

### 5.5 WP-C：整合與上線（兩包都合併後）

1. 在 compose 裡起 postgres、api（`DNS_PROVIDER=memory`、`AUTH_DEV_LOGIN=true`）與 web，跑 WP-B 的 Playwright 套件，切換成 `@integration` 模式。P0 spec 必須全過；`@p1` spec 遇到對應端點回 `NOT_IMPLEMENTED` 時標記為 skip，不算失敗（由 test fixture 先打一次該端點來判斷）。上線前列出被 skip 的 P1 項目，作為下一輪待辦。
2. 依 §3.14 銷毀舊資料，輪替所有金鑰。
3. 建立新的 GitHub OAuth App（正式與本機各一）、Turnstile widget（hostname `dev-in.tw`）、CF API token（最小權限加 IP filtering），寫入 Infisical。
4. 在 Dokploy 依 §3.13 建立 Postgres、api、web，設定網域與路由、備份。
5. 確認 Cloudflare 上 `dev-in.tw` 與 `www` 的 A/AAAA 指向主機（灰雲）；`_dmarc`、`security@` 與 `abuse@` 的 Email Routing。
6. 冒煙測試：真實 GitHub 登入；在 `_e2e-*` 名稱上做真實的 Cloudflare 讀寫；跑一次 reconcile。
7. 打開 `registration_open`，發布公告。
8. （§6 Q13）時機成熟時準備 PSL 的 PR。

---

## 6. 需要擁有者決定的問題

| # | 問題 | 建議預設值 | 影響 |
|---|---|---|---|
| Q1 | **Cloudflare zone 的 plan 與紀錄上限？** 請執行：`curl -sH "Authorization: Bearer $T" https://api.cloudflare.com/client/v4/zones/$ZONE \| jq '.result.plan.name, .result.created_on'`，以及 `…/zones/$ZONE/dns_records?per_page=1 \| jq '.result_info.total_count'` | 先用查到的實際值設定 `ZONE_RECORD_LIMIT`。如果是 200：初期維持 Free（約 70 個子網域），**用戶數接近上限時升級 Pro**（3,500）；長期可以評估自架 DNS adapter | 配額、成本、DnsProvider |
| Q2 | Repo 策略 | 新建 `Dev-in-tw/dev-in.tw` monorepo（AGPL-3.0），舊的兩個 repo 加上 README 指標後封存 | 平行開發、CI |
| Q3 | 後端框架 | Hono on Node 24（不沿用 NestJS） | §3.2 |
| Q4 | 資料庫 | 專用的 Postgres 18（Dokploy database service）。如果 Lazco 已經有共用的 Postgres 叢集，也可以在那裡開一個 DB 和使用者 | 資源、備份 |
| Q5 | 每人子網域數、每個子網域紀錄數 | 1 個、10 筆（Q1 如果是 Pro，改為 2 個、10 筆）；管理員可以個別覆寫 | 濫用、容量 |
| Q6 | 是否需要人工審核 | **依風險審核**：帳號未滿 30 天或名稱近似品牌才送審，其餘自動開通；後台可以切換成全部審核 | 體驗、營運負擔 |
| Q7 | 保留字清單 | 採用附錄 A 的種子清單，另外 1–2 字元名稱保留，zone 既有名稱自動保留 | 釣魚防護 |
| Q8 | 管理員是誰 | Haco（加上 OnCloud？）。請提供 **GitHub numeric id**（`gh api users/<login> --jq .id`） | `ADMIN_GITHUB_IDS` |
| Q9 | 是否支援非 GitHub 登入 | **MVP 只支援 GitHub**（目標族群就是開發者，帳號年齡也能拿來評估風險）。identity 模組保留 provider 欄位，之後可以擴充 GitLab | 濫用、複雜度 |
| Q10 | 是否開放 proxied（橘雲） | **不開放** | 帳號風險、SSL |
| Q11 | 是否開放 NS 委派 | **不開放**；P2 再評估只給可信使用者 | 濫用 |
| Q12 | 子網域是否有到期與續約 | **MVP 不設到期**；P2 加入「12 個月沒登入，而且 GitHub 帳號已刪除」就回收 | 閒置名稱 |
| Q13 | 是否申請加入 PSL | **是，但等子網域超過 1,000 個再送**。在那之前先確認網域註冊期限 > 2 年並開啟自動續約；如果 LE 額度出問題，先申請 LE 提高額度 | 憑證額度、cookie 隔離 |
| Q14 | HSTS 是否加 `includeSubDomains` | **不加**（會強迫所有使用者站台都走 HTTPS） | 使用者自由度 |
| Q15 | API 網域 | 同源 `dev-in.tw/api`；`api.dev-in.tw` 列為保留字，P2 推出 PAT 時才啟用 | §3.1 |
| Q16 | 是否收集 email | 收 GitHub primary verified email，只用在濫用聯絡與重要通知，不做行銷 | 個資、聯絡管道 |
| Q17 | 公開展示預設 | **預設不公開**，由使用者自行開啟 | 隱私 |
| Q18 | 舊使用者與舊名稱 | **全部清空**、不保留。替代方案：只匯出 `(name, githubId)`，給原擁有者 30 天的優先申請期（需要多寫一個一次性腳本） | 公告內容 |
| Q19 | Turnstile | 用在申請與檢舉；為 dev-in.tw 建立新的 widget | 濫用 |
| Q20 | 營運主體與法務文字 | 以 LAZCO STUDIO LTD 名義營運；WP-B 先寫條款、隱私、AUP 的草稿，由擁有者確認 | 上線阻塞項 |
| Q21 | 告警通道 | 在現有 Discord 伺服器開一個私人的 admin 頻道，用 webhook 推送 | 營運 |
| Q22 | 是否需要 staging | **不需要**：本機 compose 加上 `DNS_PROVIDER=memory` 加上 e2e 已經足夠；之後真的需要時再開 `staging.dev-in.tw`，並使用獨立的 zone | 成本 |
| Q23 | 是否放 analytics | 不放（如果 Lazco 已有自架的 Umami 或 Plausible，可以只放在行銷頁） | 隱私 |
| Q24 | 平台站台的 email | 開 `abuse@`、`security@`、`hello@`，用 Cloudflare Email Routing 轉寄給擁有者 | 營運 |

---

## 附錄 A：保留字種子清單（`packages/dns/reserved-seed.ts`）

- **system**：`www api app admin administrator root dashboard console panel portal status docs doc help support faq blog news about contact legal terms privacy security abuse postmaster hostmaster webmaster noc mail email smtp imap pop pop3 mx ns ns1 ns2 ns3 ns4 dns dot doh cdn static assets img images media files download downloads upload auth login logout signin signup register account accounts oauth sso id me my user users profile settings billing pay payment payments shop store cart wallet dev staging stage test testing demo sandbox beta alpha preview internal intranet vpn proxy gateway git gitlab github ci jenkins grafana prometheus metrics monitor monitoring health healthz readyz explore claim report og well-known autodiscover autoconfig lazco dev-in devin dit official team staff moderator mod system null undefined localhost`
- **brand**（觸發近似比對與送審）：
  - 國際：`google gmail youtube apple icloud microsoft outlook office live azure amazon aws facebook meta instagram whatsapp messenger threads twitter x tiktok bytedance netflix spotify paypal stripe visa mastercard binance coinbase metamask openai chatgpt anthropic claude github gitlab vercel netlify cloudflare discord telegram line linecorp steam epic`
  - 台灣：`ctbc cathay cathaybk esun fubon taishin megabank firstbank landbank hncb sinopac post chunghwapost cht chunghwa fetnet taiwanmobile twm gov moi mof nhi nhia ird etax mohw cdc police npa judicial momo pchome shopee ruten pxmart familymart 7-eleven seven linepay jkopay pi easycard icash ipass ntu nthu nctu ncku ntust ntut twnic`
- **offensive**：另外維護一份清單，只放在 private seed 檔中，不出現在公開文件。
- **premium**：所有 1–2 字元的名稱（由 regex 規則處理）。
- **zone**：啟動時從 Cloudflare 匯入現存的所有 label。

## 附錄 B：ADR 摘要（WP0 展開為 `docs/adr/*.md`）

| ADR | 標題 | 狀態 | 決策 | 放棄的東西 |
|---|---|---|---|---|
| 0001 | Monorepo 與合約優先 | Proposed | pnpm workspace，`packages/contract` 是前後端唯一的型別來源 | 舊 repo 的 issue 與網址連續性 |
| 0002 | Hono on Node 24 取代 NestJS | Proposed | 手寫 composition root，不用 DI 框架 | NestJS 的模組化與 DI 慣例，需要靠團隊紀律補足 |
| 0003 | PostgreSQL 為事實來源，outbox 驅動 DNS 同步 | Proposed | DB 存期望狀態；worker 加 reconciler；用 `SKIP LOCKED` 當 queue | 多一個容器；寫入後要等最終一致 |
| 0004 | 同源 API 加 `__Host-` server session | Proposed | 不用 JWT；Origin 與 Fetch Metadata 雙重檢查 | 無狀態驗證；`api.dev-in.tw` 不能用 cookie |
| 0005 | DnsProvider port | Proposed | Cloudflare 與 Memory 兩個 adapter；保留自架 DNS 的可能 | 少量抽象成本 |
| 0006 | 不收集身分個資 | Proposed | 只保存 GitHub 身分與 email | 無法做實名驗證（本來就不需要） |
| 0007 | 不開放 NS 委派與 proxied | Proposed | DNS only，類型白名單 | 進階使用者的彈性 |
| 0008 | 依風險分流審核 | Proposed | 自動開通加上依風險送審 | 全面人工審核的保守性 |

## 附錄 C：參考資料

- Cloudflare 各方案的 DNS 紀錄上限：https://developers.cloudflare.com/style-guide/components/product-features/ 、https://community.cloudflare.com/t/record-quota-exceeded-error-on-free-plan-with-less-than-200-dns-records/706938
- Cloudflare Batch DNS records：https://developers.cloudflare.com/dns/manage-dns-records/how-to/batch-record-changes/ 、https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/batch/
- Cloudflare API 棄用（PATCH/PUT 改 type）：https://developers.cloudflare.com/fundamentals/api/reference/deprecations/
- GitHub OAuth PKCE：https://github.blog/changelog/2025-07-14-pkce-support-for-oauth-and-github-app-authentication/ 、https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps
- Let's Encrypt rate limits：https://letsencrypt.org/docs/rate-limits/
- Public Suffix List 規範：https://github.com/publicsuffix/list/wiki/Guidelines
- Next.js 16.4（React 19.3、View Transitions 穩定、Cache Components）：https://nextjs.org/blog/next-16-4
- Drizzle ORM 版本狀態：https://orm.drizzle.team/ （1.0 仍在 RC，採用 0.45.x）
- Lazco 內部參考：`~/Project/Lazco/lazco-workspace/docs/logging-guide.md`（wide events）、`docs/turnstile-widgets.md`、`.agents/rules/backend-sdk-errors.md`（SDK 錯誤包裝模式）

## 合約變更紀錄

| 日期 | 版本 | 變更 | 原因 | 提出者 |
|---|---|---|---|---|
| 2026-10-14 | contract-v1 | 依 §5.3 建立初版合約並凍結。相對於 §5.3 的新增：每個 schema 都匯出同名的 `z.infer` 型別；`errors.ts` 新增 `ERROR_STATUS`（錯誤碼對應的 HTTP 狀態）與 `problemType()`；`client.ts` 完成 `createClient` 實作，並新增 `Client` 型別、`resolvePath()`、`serializeQuery()`、`ApiError.status`；`events.ts` 新增 `ServerEventType`；`ClientOptions.headers` 的型別由 DOM 的 `HeadersInit` 改為等價的 `HeadersInput`（`ConstructorParameters<typeof Headers>[0]`），讓合約不依賴 DOM lib、在 Node（`@types/node`）與瀏覽器都能型別檢查；`client.ts` 的 `Out<T>` 對無 body 的端點改為 `undefined`（原為 `void`，Biome `noConfusingVoidType`）；fixtures 以 `@dit/contract/fixtures` 子路徑匯出（`responses`、`requests`、`availability`、`subdomains`、`records`、`events`、`problems`、`presets`、`users`、`ids`） | 讓前後端對狀態碼與 problem `type` 有單一來源；fixtures 不進正式 bundle | WP0 |

---

## 7. 擁有者決定（2026-10-14，定案）

| # | 問題 | 決定 |
|---|---|---|
| 1 | Cloudflare zone 方案與上限 | dev-in.tw 為 Free 方案、2023-05-11 建立，適用 **1,000 筆**紀錄上限（非 2024-09 後的 200 筆）。目前 4 筆舊紀錄（含 `jason`、`testtttt` 兩筆測試資料，上線前清除）。不需升級 Pro。 |
| 2 | Repo | 新建公開 monorepo **`Dev-in-tw/dev-in.tw`**（AGPL-3.0）。舊的 `Dev-in.tw-Frontend`、`Dev-in.tw-Backend` 於上線後封存（WP-C）。 |
| 3–4 | 後端與資料庫 | Hono on Node 24；PostgreSQL 18 + Drizzle，部署於 Lazco Dokploy「Dev-in.tw」專案。 |
| 5 | 配額 | **每人 2 個子網域、每個子網域 10 筆紀錄**（皆為設定值）。 |
| 8 | 管理員 | `ADMIN_GITHUB_IDS=51485352`（HACO8888）。 |
| 20 | 營運主體 | **Lazco Labs（拉資科科技有限公司，Lazco Corporation）**。專案名稱為 **Dev-in.tw**，由 Lazco 組成的小組負責維運。條款、隱私權政策、使用規範與頁尾以此署名；信箱 `abuse@`、`security@`、`hello@dev-in.tw`。 |
| 其餘 | 6、7、9–19、21–24 | 全部採用 §6 的建議預設值。 |

部署環境：Lazco Dokploy（`dokploy.lazco.tw`）的「Dev-in.tw」專案；GitHub provider「Dev-in.tw」（githubId `8A9w8Z46RzB7v4u9bxAQZ`）已安裝於 Dev-in-tw 組織；機密放在 Lazco Infisical 的「Dev-in.tw」專案（`0ecf25d9-dcd0-4902-9a1f-0fa4fd8dfee0`），Dokploy 以 vault provider `dev-in-tw` 引用（`${{vault.dev-in-tw.KEY}}`）。
