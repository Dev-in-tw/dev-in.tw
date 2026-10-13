# ADR 0004：同源 API 加 `__Host-` server session

- 狀態：Accepted（擁有者已於 2026-10-14 確認，見 `docs/PLAN.md` §7）
- 日期：2026-10-14
- 詳細設計：`docs/PLAN.md`

## 背景

舊系統把 JWT 放在 URL query 再存進 localStorage（D-03、D-04），7 天有效且無法撤銷；OAuth 沒有 state 與 PKCE（D-05）。在進入 Public Suffix List 之前，`*.dev-in.tw` 使用者子網域與 `dev-in.tw` 同站，SameSite 擋不住它們發出的請求，也能做 cookie tossing。

## 決策

- API 與網站同源：`https://dev-in.tw/api/*`，由 Traefik PathPrefix 路由。
- GitHub OAuth App + PKCE S256 + state；GitHub access token 用完即丟。
- Server-side session：cookie `__Host-dit_session`（HttpOnly、Secure、SameSite=Lax、Path=/），DB 只存 token 的 sha256；閒置 14 天、絕對 60 天，可撤銷。
- CSRF：所有寫入請求要求 `Origin` 完全等於 `APP_ORIGIN`、`Sec-Fetch-Site`（若有）為 `same-origin`、body 只接受 JSON；違反時回 `403 CSRF_REJECTED`。
- 所有 cookie 都用 `__Host-` 前綴；前端不讀任何 cookie，也不在 JS 可讀的儲存空間放 token。

## 影響

- 進不進 PSL 都能運作（進 PSL 後 `api.dev-in.tw` 會變成跨站）。
- 每個請求要查一次 session（同一請求內快取）。

## 放棄的東西

無狀態驗證；`api.dev-in.tw` 不能用 cookie。
