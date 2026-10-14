/**
 * 隱私權政策 v1.1 的技術控制：
 * - legal_consents：使用者同意的服務條款／隱私權政策版本與時間（首次登入、申請子網域、改版後重新同意）。
 *   seq 決定先後（同一毫秒內的兩筆也有順序）。刻意不存 IP 或 User-Agent（資料最小化）；
 *   跟著帳號刪除（on delete cascade）。
 * - reports.redacted_at：結案滿保存期限後，聯絡 email、IP 雜湊、說明內容與檢舉人關聯已清除的時間。
 *   說明內容清除後是空字串，所以放寬長度檢查。
 */
export const sql = /* sql */ `
create table legal_consents (
  id               uuid primary key,
  seq              bigint generated always as identity unique,
  user_id          uuid not null references users(id) on delete cascade,
  terms_version    text not null,
  privacy_version  text not null,
  context          text not null check (context in ('login','subdomain_create','prompt')),
  accepted_at      timestamptz not null default now()
);
create index legal_consents_user_idx on legal_consents (user_id, seq desc);

alter table reports add column redacted_at timestamptz;
alter table reports drop constraint reports_details_check;
alter table reports add constraint reports_details_check
  check (redacted_at is not null or char_length(details) between 10 and 2000);
create index reports_retention_idx on reports (resolved_at)
  where redacted_at is null and resolved_at is not null;
`;
