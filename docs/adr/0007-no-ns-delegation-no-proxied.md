# ADR 0007：不開放 NS 委派與 proxied

- 狀態：Accepted（擁有者已於 2026-10-14 確認，見 `docs/PLAN.md` §7）
- 日期：2026-10-14
- 詳細設計：`docs/PLAN.md`

## 背景

舊系統允許 NS 紀錄（D-09），使用者可以把子網域委派到外部 DNS，完全繞過平台控管，還有 dangling delegation 被接管的風險；也允許 `proxied=true`（D-10），使用者流量會經過組織的 Cloudflare 帳號，ToS 與濫用申訴都算在 zone 擁有者頭上，且 Universal SSL 只涵蓋一層子網域。

## 決策

- 紀錄類型白名單：MVP 開放 A、AAAA、CNAME、TXT、MX；P1 開放 SRV、CAA。**不開放 NS**（P2 再評估只給可信使用者）。
- 合約中沒有 `proxied` 欄位，provider 一律送 `false`（DNS only）。
- A/AAAA 只允許公網 unicast 位址；CNAME 指向 `*.dev-in.tw` 時只能指向自己擁有的子網域。

## 影響

- 濫用面最小，zone 設定不會外溢到使用者。
- 需要 CDN 的使用者要自己在平台端處理。

## 放棄的東西

進階使用者的彈性。
