# Dev-in.tw 威脅模型

- 版本：2026-10-14（上線當天，配合 [`AUDIT-2026-10.md`](AUDIT-2026-10.md)）
- 範圍：`apps/api`（Hono + PostgreSQL + DNS sync worker）、`apps/web`（Next.js 16）、`packages/dns`、
  `packages/contract`，以及它們依賴的部署環境（Lazco Dokploy / Docker Swarm / Traefik、Cloudflare）。
- 方法：先畫資料流與信任邊界，再依 STRIDE 逐一列出威脅、現有緩解與殘餘風險。設計決策以
  [`docs/PLAN.md`](../PLAN.md) §3.6–3.10 與 §7 為準。

## 1. 系統概觀

使用者用 GitHub 登入，免費申請 `<name>.dev-in.tw`，在網頁上管理 A / AAAA / CNAME / TXT / MX / SRV / CAA
紀錄。PostgreSQL 是期望狀態，sync worker 把它收斂到 Cloudflare 的 `dev-in.tw` zone。

```
瀏覽器 ──HTTPS──▶ [Cloudflare 代理（目前）] ──▶ Traefik ──┬─ dev-in.tw/*      ─▶ web:3000（Next.js）
                                                           └─ dev-in.tw/api/* ─▶ api:3001（Hono）
web（RSC）──HTTP（Docker overlay）──▶ api:3001            轉發瀏覽器的 cookie 與 X-Forwarded-For
api ──▶ PostgreSQL 18（同一個 Dokploy 專案，不對外）
api ──HTTPS──▶ Cloudflare API（DNS:Edit，限 dev-in.tw zone）
api ──HTTPS──▶ GitHub OAuth / REST、Cloudflare Turnstile、四個固定的 DoH resolver、Discord webhook
使用者子網域 ──DNS──▶ 使用者自己的主機（任意內容，平台不代管）
```

**部署模式**：目前 `dev-in.tw` 在 Cloudflare 代理後面（`TRUST_CLOUDFLARE=true`）；之後可能把 DNS 搬到 Lazco
自建 DNS，屆時不再有 Cloudflare 代理。所有應用層控制都必須在兩種模式下成立（見 §5）。

## 2. 資產

| 資產 | 分類 | 位置 | 被破壞時的影響 |
|---|---|---|---|
| `dev-in.tw` zone 的完整性（使用者紀錄、系統紀錄 `@`、`www`、`_dmarc`、`_psl`、`mail`） | 關鍵 | Cloudflare（實際）、PostgreSQL（期望） | 全站或大量使用者的網站、信件、憑證被劫持；zone 被清空 |
| Cloudflare API token | 機密 | Infisical → Dokploy 環境變數 | 同上（可任意改 zone） |
| Session token（`__Host-dit_session`） | 機密 | 瀏覽器 cookie；DB 只存 SHA-256 | 冒用使用者；admin session 被盜等於控制整個平台 |
| `SESSION_SECRET`（簽 OAuth state cookie）、GitHub client secret、Turnstile secret、`REPORT_IP_SALT` | 機密 | Infisical | 偽造登入流程、繞過人機驗證、還原 IP 雜湊 |
| 使用者個資：GitHub id / login、主要 email、session 的 IP 與 User-Agent、稽核紀錄 IP（90 天） | 個資 | PostgreSQL | 個資外洩（PLAN §3.11 與隱私權政策的承諾） |
| 檢舉內容與聯絡 email | 個資 | PostgreSQL | 檢舉人身分外洩、報復 |
| 管理功能（停權、核准、保留字、強制對帳） | 高權限 | API `/admin/*` | 惡意停權、釋出他人名稱、繞過大量刪除煞車 |
| 可用性：API、worker、zone 紀錄配額（1,000 筆）、Cloudflare API 額度 | 營運 | — | 服務中斷、無法申請 |
| 網域信譽 | 營運 | — | 被列入黑名單（Safe Browsing、垃圾信），連帶影響所有使用者 |

## 3. 信任邊界

| # | 邊界 | 跨越的資料 | 主要控制 |
|---|---|---|---|
| B1 | 網際網路 → Cloudflare / Traefik | 所有 HTTP 請求 | TLS、Cloudflare WAF（目前）、Traefik 不信任外部 forwarded headers |
| B2 | Traefik → web / api 容器 | HTTP + `X-Forwarded-For` | client IP 依 `TRUSTED_PROXY_HOPS` 從右數；`CF-Connecting-IP` 只在來源屬於 Cloudflare 時採信 |
| B3 | 瀏覽器 → API（同源 `/api`） | cookie、JSON body | `__Host-` cookie、CSRF（Origin / Sec-Fetch-Site / JSON）、zod 驗證、32 KiB body 上限、限流 |
| B4 | 使用者子網域 ↔ `dev-in.tw`（**同一個 site**，PSL 尚未收錄） | cookie、same-site 請求 | `__Host-` 前綴、Origin 必須完全等於 `APP_ORIGIN`、`Sec-Fetch-Site` 不接受 `same-site`、重複 cookie 視為無效 |
| B5 | API → PostgreSQL | SQL | Drizzle 參數化查詢、交易與 `FOR UPDATE`、DB 不對外 |
| B6 | API → Cloudflare / GitHub / Turnstile / DoH / Discord | 憑證與查詢 | 固定的主機（沒有使用者指定的 URL）、逾時、錯誤原文不外傳 |
| B7 | CDN 載入的第三方 JS（`/api/docs` 的 Scalar、Turnstile） | 程式碼 | Scalar 版本固定、跑在 CSP sandbox（opaque origin）；Turnstile 只在 iframe 與 nonce CSP 下載入 |
| B8 | 建置供應鏈（npm、GitHub Actions、Docker Hub） | 程式碼與映像 | lockfile + `minimumReleaseAge: 4320`、`onlyBuiltDependencies: []`、新 workflow 以 SHA 釘版本、base image 以 digest 釘版本、CodeQL、`pnpm audit` |
| B9 | 管理員 | 高權限操作 | GitHub numeric id 白名單（每個請求重新比對）、admin 端點對非 admin 回 404、所有寫入寫稽核 |

## 4. 威脅與緩解（STRIDE）

狀態：**已緩解**；**部分**＝部分緩解，見 §7 殘餘風險；**外部**＝接受或需在程式碼外處理（見稽核報告）。

### S：冒用身分

| 威脅 | 元件 | 風險 | 緩解 | 狀態 |
|---|---|---|---|---|
| Login CSRF：把受害者登入成攻擊者的帳號 | OAuth callback | 高 | `state` 綁在 HMAC 簽章的 `__Host-dit_oauth` cookie、PKCE S256、10 分鐘期限、用完即清 | 已緩解 |
| 子網域植入 cookie（cookie tossing / session fixation） | B4 | 高 | 所有 cookie 用 `__Host-`；同名 cookie 出現兩次時視為沒有；登入成功時撤銷瀏覽器原本帶的 session | 已緩解 |
| Session 被竊後長期有效 | session | 中 | server 端 session（只存 SHA-256）、idle 14 天、absolute 60 天、登出與裝置撤銷、停權時撤銷全部 | 已緩解 |
| 被移出 `ADMIN_GITHUB_IDS` 的管理員仍有權限 | 授權 | 中 | 每個請求依白名單重算有效角色 | 已緩解 |
| 管理員 GitHub 帳號被盜 | 管理員 | 高 | 綁 numeric id；管理員帳號需啟用 2FA / passkey（程式碼外）；P2：admin WebAuthn step-up | 外部 |
| 人機驗證被繞過 | 申請、檢舉 | 低 | Turnstile siteverify、比對 hostname、網路錯誤 fail closed | 已緩解 |

### T：竄改

| 威脅 | 元件 | 風險 | 緩解 | 狀態 |
|---|---|---|---|---|
| CSRF（含來自使用者子網域的 same-site 請求） | API 寫入 | 高 | Origin 完全等於 `APP_ORIGIN`、`Sec-Fetch-Site` 只接受 `same-origin`、body 只接受 `application/json` | 已緩解 |
| IDOR：改別人的子網域或紀錄 | API | 高 | 所有查詢都帶 `owner_id`；不是自己的一律 404；紀錄以 `subdomain_id` 限定 | 已緩解 |
| 併發繞過配額、CNAME 排他、轉移狀態 | API | 中 | 子網域與使用者列 `FOR UPDATE`、轉移列鎖定後重新檢查狀態與擁有者 | 已緩解 |
| DNS 內容指向內網（rebinding、內網探測） | `packages/dns` | 中 | A / AAAA 只允許公網 unicast；CNAME / MX / SRV 不能是 IP、不能指向 `.local`、`.internal`、`.localhost`、`.home.arpa` 等特殊用途網域 | 部分 |
| 委派或橘雲讓使用者繞過平台控管 | DNS | 高 | 不開放 NS、provider 一律 `proxied=false`（ADR-0007） | 已緩解 |
| Sync worker 改到系統紀錄或其他人的紀錄 | worker | 關鍵 | 只動有 `dit:<recordId>` 標記的紀錄；`SYSTEM_RECORD_NAMES` 對帳時永遠略過，且無論保留字表如何都不能被申請 | 已緩解 |
| DB 指錯或還原到舊版本，把 zone 刪光 | reconciler | 關鍵 | 大量刪除煞車（> 10 筆或 > 10%）、只有 admin `force=true` 能放行、啟動時比對 zone 名稱 | 已緩解 |
| 管理員手動加的 zone 名稱被使用者申請，並替它拿憑證 | 命名 | 中 | 啟動時與**每一輪對帳**都把沒有 `dit:` 標記的 zone 名稱匯入為保留字 | 已緩解 |
| 同形異義字、品牌仿冒 | 命名 | 中 | 子網域禁止 `--`（含 `xn--`）、品牌保留與近似比對送審；子網域底下的紀錄名稱也不能用 `xn--` | 部分 |
| 開放轉址（登入後導向） | web / API | 中 | 兩端都只接受站內相對路徑，擋控制字元與反斜線，最後以 URL 解析確認同源 | 已緩解 |
| 供應鏈：npm 套件、CI action、base image 被竄改 | B8 | 高 | lockfile、三天 `minimumReleaseAge`、不執行 install script、Dependabot cooldown、SHA / digest 釘版本、CodeQL | 部分 |
| CDN 上的 Scalar 被竄改後以使用者身分操作 API | `/api/docs` | 高 | 版本固定；CSP `sandbox allow-scripts`（沒有 `allow-same-origin`）：opaque origin、讀不到 cookie、寫入請求的 `Origin: null` 被 CSRF 擋下 | 已緩解 |

### R：否認

| 威脅 | 緩解 | 狀態 |
|---|---|---|
| 使用者或管理員否認做過某個操作 | 所有寫入在同一個交易寫 `audit_logs`（只新增）、request id 貫穿 log 與 problem 回應；IP 保留 90 天 | 已緩解 |
| 自動處理（對帳、接管偵測、轉移過期）無從追查 | 以 `system` actor 寫稽核；wide event log | 已緩解 |

### I：資訊洩漏

| 威脅 | 緩解 | 狀態 |
|---|---|---|
| 錯誤訊息洩漏內部細節 | 5xx 只回通用訊息與 request id；上游錯誤只回 `UPSTREAM_*`；production 不做回應 schema 驗證的 500 細節 | 已緩解 |
| Log 洩漏機密或個資 | 不記 cookie、token、OAuth code、完整 email；pino redact 為最後防線；IP 只記加鹽雜湊 | 已緩解（Traefik access log 見 R5） |
| 敏感回應被快取 | API 一律 `Cache-Control: no-store`（除公開的 `openapi.json`）；登入後頁面 `private, no-store` | 已緩解 |
| 跨站讀取 API 回應 | 沒有 CORS（`openapi.json` 例外，公開且不帶 cookie）、CORP `same-origin`、COOP `same-origin` | 已緩解 |
| 子網域存在與否、轉移對象是否註冊過 | 不是自己的子網域回 404；轉移邀請每人每小時 10 次 | 部分 |
| SSRF（傳播檢查、任何外部 fetch） | 所有對外請求都是固定主機；DoH 只把使用者的名稱放進 DNS 查詢內容、不跟隨轉址；Next 圖片最佳化只允許本站圖片 | 已緩解 |

### D：阻斷服務

| 威脅 | 緩解 | 狀態 |
|---|---|---|
| 大 body 耗盡記憶體（192 MB 容器） | `/v1/*` body 上限 32 KiB（含 chunked） | 已緩解 |
| 限流被繞過或 bucket 塞爆記憶體 | IPv6 以 /64 計、補滿的 bucket 每分鐘清除、最多 100,000 個並淘汰最久沒用的 | 已緩解 |
| SSE 連線耗盡 | 每人 5、每來源 IP（/64）20、全 process 1,000；名額在串流前同步保留、`finally` 釋放；每分鐘重新驗證 session | 已緩解 |
| 公開健康檢查被當成打 DB 的放大器 | 同一秒內共用一次 DB 查詢 | 已緩解 |
| 搶註、灌爆 zone 配額 | 每人 2 個子網域、每個 10 筆紀錄、每天 5 次申請、全域容量閘門、Turnstile、帳號年齡送審 | 已緩解 |
| 耗盡 Cloudflare API 額度 | 讀取一律走 DB；worker 以 `CLOUDFLARE_RPS` 節流；紀錄寫入每人每分 10 / 每時 60 | 已緩解 |
| Cookie bombing：子網域對 `.dev-in.tw` 種大量 cookie，讓受害者對主站的請求超過標頭上限 | 只能靠 PSL 根治 | 外部 |
| 量體型 DDoS | Cloudflare（目前）；搬家後需 Traefik 層限流或 CrowdSec（程式碼外） | 外部 |

### E：權限提升

| 威脅 | 緩解 | 狀態 |
|---|---|---|
| 一般使用者呼叫 admin 端點 | 每個 admin 端點在 `define()` 統一檢查有效角色，非 admin 回 404 | 已緩解 |
| Mass assignment（改到 role、status、配額） | 每個端點的 body 都是明確的 zod schema；role 只由白名單決定 | 已緩解 |
| 停權後仍能操作 | 每個請求檢查 `users.status`；停權撤銷所有 session；SSE 每分鐘重新驗證 | 已緩解 |
| 子網域接管（dangling CNAME） | 釋出、停權、轉移時清掉紀錄；每 6 小時以 DoH 檢查 CNAME 目標，兩個 resolver 都 NXDOMAIN 時通知擁有者（稽核時間軸）與管理員 | 部分 |

## 5. 有／沒有 Cloudflare 代理

| 控制 | 有 Cloudflare（現在） | 沒有 Cloudflare（搬到 Lazco DNS 之後） |
|---|---|---|
| Client IP | Traefik 看到的來源是 Cloudflare 機房 → 改用 `CF-Connecting-IP` | Traefik 看到的就是 client（`X-Forwarded-For` 最右邊）；`isCloudflareIp()` 為 false，自動不採信 `CF-Connecting-IP`。**應把 `TRUST_CLOUDFLARE` 設回 `false`** |
| 繞過代理直連 origin | 偽造的 `CF-Connecting-IP` 因來源不是 Cloudflare 而被忽略；但其他 Cloudflare 租戶仍能從 Cloudflare IP 連進來，建議 Authenticated Origin Pulls | 不適用 |
| HSTS | 由 web 與 API 自己送（不靠 Cloudflare 的 HSTS 設定，也不加 `includeSubDomains`） | 同左 |
| CSP、COOP、CORP 等 | 由應用程式送 | 同左 |
| 限流 | 應用層 token bucket（不依賴 Cloudflare） | 同左；建議另外在 Traefik 加一層 |
| Body 上限 | 應用層 32 KiB | 同左；建議 Traefik `buffering` 也設上限 |
| 憑證 | Cloudflare edge + Traefik Let's Encrypt | Traefik Let's Encrypt |
| 量體型 DDoS | Cloudflare | 無，需要另外規劃 |

## 6. 假設

1. web 與 api 容器只能經由 Traefik 連到（不對主機 publish 3000 / 3001）。web 的 RSC 會把瀏覽器的
   `X-Forwarded-For` 原樣轉給 API；若 web 可以被直接連到，攻擊者就能偽造 SSR 請求的 client IP。
2. Traefik 不信任外部送來的 forwarded headers（預設值）。
3. PostgreSQL 只在 Dokploy 的內部網路上。
4. API replicas = 1（限流與 SSE 名額存在記憶體）；擴充時要改用 PG 或 Redis。
5. Cloudflare API token 只有 `Zone:DNS:Edit` + `Zone:Read`、只限 `dev-in.tw`，並開啟 Client IP filtering。

## 7. 殘餘風險

| # | 風險 | 為什麼接受 / 如何處理 |
|---|---|---|
| R1 | **同一個 site**：在 PSL 收錄 `dev-in.tw` 之前，使用者子網域和主站同 site，能對 `.dev-in.tw` 種 cookie（cookie bombing）、讓 SameSite 失去作用。 | 程式碼已用 `__Host-`、嚴格 Origin、拒絕 `same-site` 擋下會造成越權的路徑；cookie bombing 只能等 PSL（程式碼外第 8 項）。 |
| R2 | 行銷頁的 CSP 是 `script-src 'self' 'unsafe-inline'`（PLAN §3.7 的決定，為了靜態生成）。 | 這些頁面不顯示登入後資料；若出現 XSS，仍能以同源身分呼叫 API。React 預設跳脫輸出，沒有 `dangerouslySetInnerHTML` 處理使用者內容。之後可評估以建置時 hash 取代。 |
| R3 | DNS rebinding 無法完全阻止：CNAME 指向攻擊者自己的網域，就能回答任何 IP。 | 私有 IP 與特殊用途網域的檢查是縱深防禦；真正的防線在受害端（瀏覽器的 Private Network Access、服務檢查 Host）。 |
| R4 | GitHub Pages、Vercel、Netlify 等平台對 `*.github.io` 之類有萬用解析，站台刪除後名稱仍存在，NXDOMAIN 偵測抓不到。 | HTTP 指紋偵測需要對使用者指定的主機發請求（SSRF 面），刻意不做；文件教使用者先刪紀錄再刪站台，並依賴檢舉。**不要**把 `dev-in.tw` 設為 GitHub Pages 的 verified domain，那會讓所有使用者都不能用 GitHub Pages。 |
| R5 | OAuth `code` 與 `state` 會出現在 Traefik / Cloudflare 的 access log（query string）。 | `code` 一次性且需要 PKCE verifier，風險低；仍建議縮短保存或遮蔽（程式碼外）。 |
| R6 | 限流與 SSE 名額在記憶體：重啟歸零、多 replica 不共享。 | replicas = 1；擴充前改用 PG 計數或 Redis。 |
| R7 | 使用者描述等自由文字可以含 Unicode 雙向控制字元。 | 由 React 跳脫輸出，不會執行；只有視覺混淆的可能，列為後續改善。 |
| R8 | GitHub login 可改名與回收；轉移邀請以 login 找人，若對方改名後未再登入，邀請會送到舊資料對應的帳號。 | 接受者必須是 Dev-in.tw 既有使用者並自行接受；影響有限。 |
| R9 | 既有 CI job 的 actions 仍以 tag 釘版本。 | 新增的 workflow 已用 SHA；既有 `checks` job 屬 WP0，建議由擁有者一併改成 SHA（Dependabot 會維護）。 |
| R10 | 管理員只有 GitHub 一個因子。 | 依賴 GitHub 帳號的 2FA / passkey；P2 加 WebAuthn step-up。 |

## 8. 安全需求（可驗證）

每一條都有對應的自動化測試，修改相關程式碼時不可移除：

1. 所有寫入請求：`Origin == APP_ORIGIN`，`Sec-Fetch-Site ∈ {same-origin, 缺少}`，有 body 時必須是 JSON
   （`apps/api/test/security.test.ts`）。
2. Cookie 一律 `__Host-`、`HttpOnly`、`Secure`、`SameSite=Lax`、`Path=/`、沒有 `Domain`；同名 cookie 重複時視為無效
   （`security.test.ts`、`security-session.test.ts`）。
3. Admin 權限每個請求依 `ADMIN_GITHUB_IDS` 判定（`security-session.test.ts`）。
4. `/v1/*` 的 body 不超過 32 KiB（`security-body.test.ts`）。
5. API 回應帶 `default-src 'none'` 的 CSP、COOP、CORP、`no-store`、HSTS 且不含 `includeSubDomains` / `preload`；
   `/api/docs` 是沒有 `allow-same-origin` 的 sandbox（`security-headers.test.ts`）；web 的標頭集合由
   `apps/web/e2e/security-headers.spec.ts` 固定。
6. 限流 IPv6 以 /64 計、bucket 數有上限（`security-ratelimit.test.ts`）。
7. SSE 名額與 session 重新驗證（`security-events.test.ts`）。
8. DNS 目標與名稱規則（`packages/dns/test/security-rules.test.ts`、`ip-rules.test.ts`、`record-rules.test.ts`）。
9. 對帳的大量刪除煞車與 `SYSTEM_RECORD_NAMES`（`reconcile.test.ts`、`security-abuse.test.ts`）。
10. 接管偵測只查固定 resolver、兩個都 NXDOMAIN 才通知（`security-takeover.test.ts`）。
