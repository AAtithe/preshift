-- Preshift Rota schema for Neon (Postgres). Safe to run repeatedly: npm run db:migrate
--
-- Everything lives in its own schema because the firm database already has unrelated
-- public.users and public.sessions tables. Never move these into public.

create schema if not exists preshift;

create table if not exists preshift.accounts (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists preshift.users (
  id             uuid primary key default gen_random_uuid(),
  account_id     uuid not null references preshift.accounts(id) on delete cascade,
  email          text not null unique,
  name           text not null,
  password_hash  text not null,
  created_at     timestamptz not null default now(),
  last_login_at  timestamptz
);

-- admin is recorded now so admin-only screens (user management, set-up for other accounts) can
-- be gated on it when they are built. Today it grants nothing extra.
alter table preshift.users add column if not exists role text not null default 'manager'
  check (role in ('admin', 'manager'));

-- Set when an admin provisions the password, so the user picks their own on first sign-in.
alter table preshift.users add column if not exists must_change_password boolean not null default false;

-- Only a SHA-256 of the session token is stored, so a database leak does not leak live sessions.
create table if not exists preshift.sessions (
  id          text primary key,
  user_id     uuid not null references preshift.users(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user_idx on preshift.sessions(user_id);

-- Single-use reset links. As with sessions, only the SHA-256 of the token is stored.
create table if not exists preshift.password_resets (
  id          text primary key,
  user_id     uuid not null references preshift.users(id) on delete cascade,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists password_resets_user_idx on preshift.password_resets(user_id, created_at);

-- Failed attempts drive the lockout in api/auth/login.ts.
create table if not exists preshift.login_attempts (
  email   text not null,
  ok      boolean not null,
  at      timestamptz not null default now()
);
create index if not exists login_attempts_email_at_idx on preshift.login_attempts(email, at);

-- One rota per account. version gives optimistic locking so two managers cannot silently
-- overwrite each other's changes.
create table if not exists preshift.rota_state (
  account_id  uuid primary key references preshift.accounts(id) on delete cascade,
  state       jsonb not null,
  version     integer not null default 1,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references preshift.users(id) on delete set null
);
