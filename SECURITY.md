# 安全政策（Security Policy）

Dev-in.tw 由 Lazco Labs（拉資科科技有限公司，Lazco Corporation）組成的小組維運。我們很感謝願意花時間
找出問題並私下告訴我們的人。

*English summary at the end of this file.*

## 通報方式

- **Email：[security@dev-in.tw](mailto:security@dev-in.tw)**（會轉寄給 Lazco 維運小組）。
- 也可以在 GitHub 使用 [Private vulnerability reporting](https://github.com/Dev-in-tw/dev-in.tw/security/advisories/new)。
- **請不要**在公開 issue、PR、Discord 或社群貼文中揭露尚未修補的漏洞。

信件請盡量包含：

1. 影響範圍與嚴重度的初步判斷（例如：可以讀到別人的 DNS 紀錄、可以用別人的身分寫入）。
2. 重現步驟、請求與回應（請遮蔽你自己的 cookie 與 token）、使用的瀏覽器或工具。
3. 你希望被如何致謝（名字或 GitHub 帳號），或希望匿名。

如果是**使用者子網域上的惡意內容**（釣魚、惡意程式、C2 等），那是濫用而不是平台漏洞，請改用
[檢舉表單](https://dev-in.tw/report) 或寫信到 [abuse@dev-in.tw](mailto:abuse@dev-in.tw)。

## 回應時程

| 階段 | 目標 |
|---|---|
| 確認收到 | 3 個工作天內 |
| 初步評估（是否成立、嚴重度） | 7 天內 |
| 修補上線：Critical | 7 天內 |
| 修補上線：High | 30 天內 |
| 修補上線：Medium / Low | 90 天內，或併入下一次例行更新 |

修補上線後，我們會和通報者協調公開時間（預設在修補後 30 天、或通報後 90 天，以較早者為準），並在
GitHub Security Advisory 中致謝。Dev-in.tw 是免費服務，**目前沒有漏洞獎金**。

## 範圍

**在範圍內**

- `https://dev-in.tw` 網站與 `https://dev-in.tw/api/*`。
- 這個 repo 的程式碼（`apps/api`、`apps/web`、`packages/*`）與 CI 設定。
- 會影響其他使用者的 DNS 管理邏輯：越權讀寫別人的子網域或紀錄、繞過名稱或紀錄驗證、讓 sync worker
  修改或刪除不屬於你的 zone 紀錄、子網域接管等。

**不在範圍內**

- 使用者自行架設、透過 CNAME / A 紀錄指向的網站內容（請走檢舉流程）。
- Cloudflare、GitHub、Lazco 其他服務本身的漏洞（請通報給各自的廠商）。
- 需要大量流量的阻斷服務（DoS / DDoS）、社交工程、實體攻擊。
- 沒有實際影響的「最佳實務」回報，例如：缺少某個非必要標頭、沒有實際利用方式的版本號洩漏、
  需要受害者自己貼程式碼的 self-XSS、在沒有敏感操作的頁面上的 clickjacking。
- 已知且刻意接受的設計取捨（見 [`docs/security/THREAT_MODEL.md`](docs/security/THREAT_MODEL.md) 的殘餘風險）。

## 測試守則（Safe harbor）

研究時請遵守下列守則：

- 只使用**你自己的**帳號與子網域；需要第二個帳號時請自己再開一個，不要存取他人的資料。
- 不要申請品牌、政府、金融機構相似的名稱，也不要架設任何釣魚或惡意內容；測試用的子網域用完請釋出。
- 不要進行會影響服務可用性的測試（大量請求、大量自動化掃描、塞爆 zone 配額、刻意觸發大量 DNS 變更），也不要進行社交工程。
- 證明漏洞存在後就停止；一旦接觸到他人的資料，請立即停止、不要保存或散布，並在通報中說明。
- 依上方「回應時程」的公開時間協調公開，在那之前不要公開漏洞細節。

對於善意、遵守本守則並及時通報的研究，Lazco Labs（拉資科科技有限公司）不會就該研究行為**提出刑事告訴或民事求償**，並會在必要時向第三方說明你的行為屬於本政策授權的測試。

本承諾**不適用於**：違反上述守則、存取或保存他人資料超出證明漏洞所必要的範圍、以漏洞要求報酬或威脅公開，或任何其他違法行為。
本承諾也**無法代表**其他使用者或第三方服務（例如 Cloudflare、GitHub）放棄其權利。

## 支援版本

只有部署在 `https://dev-in.tw` 的最新版本（`main` 分支）會收到安全修補。

---

## English summary

- **Report to [security@dev-in.tw](mailto:security@dev-in.tw)** or via GitHub private vulnerability
  reporting. Do not open public issues for unfixed vulnerabilities. Abuse on user subdomains goes to
  [abuse@dev-in.tw](mailto:abuse@dev-in.tw) or <https://dev-in.tw/report>.
- We acknowledge within 3 business days, triage within 7 days, and aim to fix Critical issues within
  7 days, High within 30 days and Medium/Low within 90 days. Disclosure is coordinated; there is no bounty.
- In scope: the dev-in.tw website and API, this repository, and DNS management logic that affects
  other users. Out of scope: content on user-operated subdomains, third-party platforms, volumetric
  DoS, social engineering, and best-practice reports without demonstrated impact.
- For good-faith research that follows the rules above and is reported promptly, Lazco Labs will not file a
  criminal complaint or civil claim over that research. This does not cover rule violations, retaining other
  people's data beyond what is needed to show the issue, extortion, or other unlawful acts, and it cannot waive
  the rights of other users or third-party services.
