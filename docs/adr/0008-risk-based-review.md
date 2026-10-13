# ADR 0008：依風險分流審核

- 狀態：Accepted（擁有者已於 2026-10-14 確認，見 `docs/PLAN.md` §7）
- 日期：2026-10-14
- 詳細設計：`docs/PLAN.md`

## 背景

全面人工審核會讓體驗變差、營運負擔變重；完全不審核則容易被拿來做品牌釣魚（D-12）。

## 決策

- 預設自動開通，符合以下任一條件時進 `pending_review`：
  - GitHub 帳號年齡 < `MIN_GITHUB_ACCOUNT_AGE_DAYS`（預設 30）；
  - 名稱近似品牌（長度 ≥ 5 的 brand 才做 leet、編輯距離 ≤ 1 與子字串比對；長度 < 5 只做完全比對並視為保留字）；
  - `settings.review_mode = 'all'`。
- 管理後台可以切換 `review_mode`（`risk`、`all`、`none`）。
- WP-A 必須通過品牌誤判防護測試（PLAN.md §3.9 列出的一般名稱都要回 `available`）。

## 影響

- 大部分使用者可以立即開通。
- 可疑申請由管理員在 `/admin/review` 處理。

## 放棄的東西

全面人工審核的保守性。
