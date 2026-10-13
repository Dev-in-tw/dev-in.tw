/**
 * 初始 schema（docs/PLAN.md §3.5）。與 PLAN 的差異：
 * - 主鍵不使用 `default uuidv7()`：一律由應用程式產生 UUIDv7（lib/ids.ts），
 *   讓測試與 CI 可以在 PostgreSQL 16+ 執行；正式環境是 PostgreSQL 18。
 * - sessions 多一個 `public_id`：對外顯示的 opaque id（§5.3 Session.id「非 token hash」）。
 * - users 多一個 `deletion_requested_at`：刪除帳號是 202 非同步流程，子網域清除完才刪除 user。
 * - subdomains 多一個 `suspended_by_user`：使用者被停權而連帶停權的子網域，解除時一併恢復。
 */
export const sql = /* sql */ `
create extension if not exists citext;

create type user_role         as enum ('user','admin');
create type user_status       as enum ('active','suspended');
create type subdomain_status  as enum ('pending_review','active','suspended','releasing');
create type record_type       as enum ('A','AAAA','CNAME','TXT','MX','SRV','CAA');
create type sync_status       as enum ('pending','synced','error','deleting');
create type transfer_status   as enum ('pending','accepted','declined','cancelled','expired');
create type report_status     as enum ('open','actioned','dismissed');
create type report_category   as enum ('phishing','malware','spam','illegal','impersonation','other');
create type reserved_category as enum ('system','brand','offensive','premium','zone');

create table users (
  id                    uuid primary key,
  github_id             bigint not null unique,
  github_login          citext not null,
  display_name          text,
  avatar_url            text not null,
  email                 citext,
  github_created_at     timestamptz not null,
  role                  user_role not null default 'user',
  status                user_status not null default 'active',
  suspended_reason      text,
  quota_subdomains      int check (quota_subdomains >= 0),
  quota_records         int check (quota_records >= 0),
  deletion_requested_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  last_login_at         timestamptz not null default now()
);
create index users_github_login_idx on users (github_login);

create table sessions (
  id                  text primary key,
  public_id           uuid not null unique,
  user_id             uuid not null references users(id) on delete cascade,
  created_at          timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  idle_expires_at     timestamptz not null,
  absolute_expires_at timestamptz not null,
  ip                  inet,
  user_agent          text,
  revoked_at          timestamptz
);
create index sessions_user_id_idx on sessions (user_id);

create table subdomains (
  id                uuid primary key,
  name              citext not null unique
                    check (name ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' and name !~ '--'),
  owner_id          uuid not null references users(id) on delete restrict,
  status            subdomain_status not null,
  description       text not null default '' check (char_length(description) <= 280),
  show_in_directory boolean not null default false,
  review_reasons    text[] not null default '{}',
  suspended_reason  text,
  suspended_by_user boolean not null default false,
  created_at        timestamptz not null default now(),
  activated_at      timestamptz,
  updated_at        timestamptz not null default now()
);
create index subdomains_owner_idx on subdomains (owner_id);
create index subdomains_status_idx on subdomains (status) where status <> 'active';

create table dns_records (
  id                 uuid primary key,
  subdomain_id       uuid not null references subdomains(id) on delete cascade,
  name               text not null,
  type               record_type not null,
  ttl                int not null check (ttl = 1 or ttl between 60 and 86400),
  data               jsonb not null,
  version            int not null default 1,
  applied_version    int not null default 0,
  provider_record_id text unique,
  provider_type      record_type,
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
  record_id     uuid,
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
create index dns_sync_jobs_status_idx on dns_sync_jobs (status, updated_at desc) where status in ('running','dead');

create table reserved_names (
  name        citext primary key,
  category    reserved_category not null,
  note        text,
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table name_holds (
  name              citext primary key,
  previous_owner_id uuid references users(id) on delete set null,
  reason            text not null,
  hold_until        timestamptz not null
);

create table transfers (
  id            uuid primary key,
  subdomain_id  uuid not null references subdomains(id) on delete cascade,
  from_user_id  uuid not null references users(id) on delete cascade,
  to_user_id    uuid not null references users(id) on delete cascade,
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
  id               uuid primary key,
  subdomain_name   citext not null,
  subdomain_id     uuid references subdomains(id) on delete set null,
  category         report_category not null,
  details          text not null check (char_length(details) between 10 and 2000),
  contact_email    citext,
  reporter_user_id uuid references users(id) on delete set null,
  reporter_ip_hash text,
  status           report_status not null default 'open',
  handled_by       uuid references users(id) on delete set null,
  resolution_note  text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);
create index reports_status_idx on reports (status, created_at desc);
create index reports_subdomain_idx on reports (subdomain_id);

create table audit_logs (
  id            uuid primary key,
  actor_type    text not null check (actor_type in ('user','admin','system')),
  actor_user_id uuid references users(id) on delete set null,
  action        text not null,
  target_type   text not null,
  target_id     text not null,
  target_label  text not null,
  metadata      jsonb not null default '{}',
  ip            inet,
  request_id    text,
  created_at    timestamptz not null default now()
);
create index audit_target_idx on audit_logs (target_type, target_id, created_at desc);
create index audit_actor_idx  on audit_logs (actor_user_id, created_at desc);
create index audit_created_idx on audit_logs (created_at);

create table idempotency_keys (
  user_id         uuid not null references users(id) on delete cascade,
  key             text not null,
  request_hash    text not null,
  response_status int not null,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  primary key (user_id, key)
);

create table settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
`;
