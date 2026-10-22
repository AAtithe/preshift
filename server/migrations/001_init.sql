-- Preshift schema. Global tables hold identity; every other table belongs to one
-- organisation and is fenced by row level security on app.org_id, which the
-- server sets per transaction. A query that forgets to set it sees nothing.

create extension if not exists pgcrypto;

-- Identity: global, read only by the auth code.
create table organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create type member_role as enum ('owner', 'finance', 'gm', 'troncmaster', 'staff');

create table memberships (
  user_id uuid not null references users(id) on delete cascade,
  organisation_id uuid not null references organisations(id) on delete cascade,
  role member_role not null,
  -- Null means every site in the organisation.
  site_ids text[],
  -- The person's own employee record, for staff and troncmasters.
  employee_id text,
  created_at timestamptz not null default now(),
  primary key (user_id, organisation_id)
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  organisation_id uuid not null references organisations(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index sessions_user on sessions(user_id);

create table invites (
  token_hash text primary key,
  organisation_id uuid not null references organisations(id) on delete cascade,
  email text not null,
  role member_role not null,
  site_ids text[],
  employee_id text,
  invited_by uuid not null references users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz
);

-- Tenant data. Ids are the client's own string ids, unique within an organisation.
create table sites (
  organisation_id uuid not null references organisations(id) on delete cascade,
  id text not null,
  name text not null,
  labour_target_pct numeric(6,4) not null,
  tracking_code text not null,
  open_minute int not null,
  close_minute int not null,
  location jsonb,
  geofence_metres int,
  food_cost_target_pct numeric(6,4),
  drink_cost_target_pct numeric(6,4),
  concept text,
  region text,
  primary key (organisation_id, id)
);

create table roles (
  organisation_id uuid not null references organisations(id) on delete cascade,
  id text not null,
  name text not null,
  department text not null,
  nominal_code text not null,
  primary key (organisation_id, id)
);

create table employees (
  organisation_id uuid not null references organisations(id) on delete cascade,
  id text not null,
  name text not null,
  site_id text not null,
  role_ids text[] not null,
  pay_basis text not null,
  hourly_rate numeric(10,2) not null,
  annual_salary numeric(12,2) not null,
  date_of_birth date not null,
  contracted_hours numeric(6,2) not null,
  max_weekly_hours numeric(6,2) not null,
  opted_out_of_48 boolean not null,
  irregular_hours boolean not null,
  pension_enrolled boolean not null,
  availability jsonb not null default '[]',
  leave jsonb not null default '[]',
  right_to_work jsonb,
  nmw_reducing_deductions_weekly numeric(10,2),
  started_on date,
  pay_frequency text,
  primary key (organisation_id, id)
);

create table shifts (
  organisation_id uuid not null references organisations(id) on delete cascade,
  id text not null,
  employee_id text not null,
  role_id text not null,
  site_id text not null,
  date date not null,
  start_minute int not null,
  end_minute int not null,
  break_minutes int not null,
  published boolean not null default false,
  primary key (organisation_id, id)
);
create index shifts_site_date on shifts(organisation_id, site_id, date);

create table clocks (
  organisation_id uuid not null references organisations(id) on delete cascade,
  id text not null,
  employee_id text not null,
  site_id text not null,
  role_id text not null,
  shift_id text,
  date date not null,
  clock_in int not null,
  clock_out int,
  break_minutes int not null,
  approved boolean,
  source text not null,
  primary key (organisation_id, id)
);
create index clocks_site_date on clocks(organisation_id, site_id, date);

create table forecast (
  organisation_id uuid not null references organisations(id) on delete cascade,
  site_id text not null,
  date date not null,
  hour int not null,
  sales numeric(12,2) not null,
  covers int not null,
  primary key (organisation_id, site_id, date, hour)
);

create table actuals (
  organisation_id uuid not null references organisations(id) on delete cascade,
  site_id text not null,
  date date not null,
  hour int not null,
  sales numeric(12,2) not null,
  covers int not null,
  primary key (organisation_id, site_id, date, hour)
);

create table demand_rules (
  organisation_id uuid not null references organisations(id) on delete cascade,
  site_id text not null,
  role_id text not null,
  sales_per_labour_hour numeric(10,2),
  covers_per_hour numeric(10,2),
  minimum_while_open int not null,
  maximum int not null,
  primary key (organisation_id, site_id, role_id)
);

create table tips (
  organisation_id uuid not null references organisations(id) on delete cascade,
  id text not null,
  site_id text not null,
  date date not null,
  source text not null,
  amount numeric(12,2) not null,
  paid_on date,
  primary key (organisation_id, id)
);

create table tronc_schemes (
  organisation_id uuid not null references organisations(id) on delete cascade,
  site_id text not null,
  troncmaster text not null,
  independent boolean not null,
  points_per_hour jsonb not null,
  department_shares jsonb,
  service_charge text not null,
  policy_published_on date,
  last_reviewed_on date,
  primary key (organisation_id, site_id)
);

create table dishes (
  organisation_id uuid not null references organisations(id) on delete cascade,
  id text not null,
  site_id text not null,
  name text not null,
  category text not null,
  price numeric(10,2) not null,
  recipe_cost numeric(10,2) not null,
  primary key (organisation_id, id)
);

create table dish_sales (
  organisation_id uuid not null references organisations(id) on delete cascade,
  site_id text not null,
  date date not null,
  dish_id text not null,
  units int not null,
  primary key (organisation_id, site_id, date, dish_id)
);

create table purchases (
  organisation_id uuid not null references organisations(id) on delete cascade,
  id text not null,
  site_id text not null,
  date date not null,
  supplier text not null,
  category text not null,
  amount numeric(12,2) not null,
  primary key (organisation_id, id)
);

create table stock_counts (
  organisation_id uuid not null references organisations(id) on delete cascade,
  site_id text not null,
  date date not null,
  category text not null,
  value numeric(12,2) not null,
  primary key (organisation_id, site_id, date, category)
);

-- Who did what, when. Append only: the app role can insert and read, never change.
create table audit_events (
  organisation_id uuid not null references organisations(id) on delete cascade,
  id bigint generated always as identity,
  at timestamptz not null default now(),
  user_id uuid,
  action text not null,
  site_id text,
  detail jsonb not null default '{}',
  primary key (organisation_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['sites','roles','employees','shifts','clocks','forecast','actuals','demand_rules','tips',
    'tronc_schemes','dishes','dish_sales','purchases','stock_counts','audit_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant on %I using (organisation_id = nullif(current_setting('app.org_id', true), '')::uuid)
      with check (organisation_id = nullif(current_setting('app.org_id', true), '')::uuid)$p$, t);
  end loop;
end $$;

-- The application connects as preshift_app, which owns nothing and so can never switch row level security off.
do $$
begin
  if exists (select from pg_roles where rolname = 'preshift_app') then
    grant usage on schema public to preshift_app;
    grant select, insert, update, delete on organisations, users, memberships, sessions, invites, sites, roles, employees,
      shifts, clocks, forecast, actuals, demand_rules, tips, tronc_schemes, dishes, dish_sales, purchases, stock_counts
      to preshift_app;
    grant select, insert on audit_events to preshift_app;
  end if;
end $$;
