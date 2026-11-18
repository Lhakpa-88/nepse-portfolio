-- OPTIONAL PostgreSQL / Supabase schema.
-- The application does NOT require a database: public market data is JSON on GitHub Pages and the private
-- portfolio lives in the browser (optionally synced as an encrypted file). This schema mirrors those
-- structures as an upgrade path for multi-device sync or a multi-year price archive. It is not wired in.

-- ---------------------------------------------------------------- public market data
create table if not exists companies (
  symbol        text primary key,
  name          text,
  sector        text,
  updated_at    timestamptz not null default now()
);

create table if not exists daily_prices (
  symbol        text not null references companies(symbol),
  trade_date    date not null,
  open          numeric(14,2),
  high          numeric(14,2),
  low           numeric(14,2),
  close         numeric(14,2) not null check (close > 0),
  volume        numeric(18,0),
  turnover      numeric(18,2),
  source        text not null,                 -- provider that supplied the row (never 'estimated')
  fetched_at    timestamptz not null default now(),
  primary key (symbol, trade_date)
);

create table if not exists index_values (
  index_name    text not null,
  trade_date    date not null,
  value         numeric(14,2) not null,
  pct_change    numeric(8,2),
  source        text not null,
  primary key (index_name, trade_date)
);

create table if not exists fundamentals (
  symbol        text not null references companies(symbol),
  fiscal_year   text not null,
  quarter       text not null,
  eps           numeric(14,2),
  book_value    numeric(14,2),
  roe           numeric(8,2),
  roa           numeric(8,2),
  npl           numeric(8,2),
  car           numeric(8,2),
  net_profit    numeric(20,2),
  source        text not null,
  fetched_at    timestamptz not null default now(),
  primary key (symbol, fiscal_year, quarter)
);

create table if not exists dividends (
  symbol        text not null references companies(symbol),
  fiscal_year   text not null,
  cash_pct      numeric(8,2) not null default 0,
  bonus_pct     numeric(8,2) not null default 0,
  book_closure  date,
  primary key (symbol, fiscal_year)
);

create table if not exists source_status (
  capability    text not null,                 -- prices | indices | history | fundamentals | news
  run_at        timestamptz not null default now(),
  ok            boolean not null,
  source        text,
  role          text,                          -- primary | secondary | fallback
  detail        jsonb,
  primary key (capability, run_at)
);

create table if not exists news_items (
  id            text primary key,
  title         text not null,
  url           text not null,
  source        text not null,
  published_at  timestamptz,
  category      text,
  impact        text check (impact in ('Critical', 'High', 'Moderate', 'General')),
  sentiment     text check (sentiment in ('Positive', 'Negative', 'Neutral')),
  confirmed     boolean not null default false,
  symbols       text[] not null default '{}',
  first_seen    timestamptz not null default now()
);

-- ---------------------------------------------------------------- private portfolio (row-level security)
create table if not exists transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null,                 -- auth.uid() in Supabase
  trade_date    date not null check (trade_date <= current_date),
  symbol        text not null,
  type          text not null check (type in ('BUY', 'SELL', 'IPO', 'RIGHT', 'BONUS', 'DIVIDEND', 'ADJUST')),
  qty           numeric(18,4) not null,
  price         numeric(14,2) not null check (price >= 0),
  commission    numeric(14,2),                 -- null = auto from fee schedule
  sebon_fee     numeric(14,2),
  dp_charge     numeric(14,2),
  cgt_or_tax    numeric(14,2),
  other_charges numeric(14,2),
  broker        text,
  notes         text,
  voided        boolean not null default false, -- rows are never deleted
  supersedes    uuid references transactions(id),
  created_at    timestamptz not null default now()
);
-- duplicate prevention for active rows
create unique index if not exists transactions_no_duplicates
  on transactions (user_id, trade_date, symbol, type, qty, price) where not voided;

create table if not exists transaction_audit (
  id            bigint generated always as identity primary key,
  user_id       uuid not null,
  at            timestamptz not null default now(),
  action        text not null check (action in ('ADD', 'CORRECT', 'VOID', 'RESTORE', 'IMPORT')),
  transaction_id uuid references transactions(id),
  detail        text not null
);

create table if not exists watchlist (
  user_id       uuid not null,
  symbol        text not null,
  list          text not null default 'watch' check (list in ('watch', 'avoid')),
  buy_low       numeric(14,2),
  buy_high      numeric(14,2),
  target_sell   numeric(14,2),
  notes         text,
  added_at      timestamptz not null default now(),
  primary key (user_id, symbol)
);

create table if not exists position_plans (
  user_id       uuid not null,
  symbol        text not null,
  target        numeric(14,2),
  stop          numeric(14,2),
  thesis        text,
  primary key (user_id, symbol)
);

create table if not exists fee_schedules (
  effective_from date primary key,
  label          text,
  schedule       jsonb not null                -- same shape as one entry of config/fees.json
);

-- Supabase: only the owner can read or write their rows; the audit table is append-only.
alter table transactions      enable row level security;
alter table transaction_audit enable row level security;
alter table watchlist         enable row level security;
alter table position_plans    enable row level security;

create policy own_transactions on transactions      for all    using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_watchlist    on watchlist         for all    using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_plans        on position_plans    for all    using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy read_own_audit   on transaction_audit for select using (user_id = auth.uid());
create policy add_own_audit    on transaction_audit for insert with check (user_id = auth.uid());
