-- InvestHouse — миграция для платформы сигналов.
-- Применить один раз в Supabase Dashboard → SQL Editor → New query → Run.

-- 1. Таблица сигналов. Один сигнал = одна рекомендация, одинаковая для всех подписчиков пары.
create table if not exists public.signals (
  id bigserial primary key,
  symbol text not null,
  side text not null check (side in ('LONG','SHORT')),
  entry numeric not null,
  stop numeric not null,
  target numeric not null,
  rsi numeric,
  atr numeric,
  rr numeric,
  interval text,
  outcome text not null default 'open' check (outcome in ('open','target','stop','timeout','manual')),
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  exit_price numeric,
  r_multiple numeric
);
create index if not exists signals_symbol_entered_at_idx on public.signals (symbol, entered_at desc);
create index if not exists signals_outcome_idx on public.signals (outcome);

alter table public.signals enable row level security;

-- Все авторизованные читают весь журнал (сигналы — публичная история, персональна только лс-доставка).
drop policy if exists signals_read_authenticated on public.signals;
create policy signals_read_authenticated
  on public.signals for select
  to authenticated
  using (true);
-- Писать может только серверный роль (service_role) — через scheduler. anon/authenticated писать не могут.

-- 2. Профиль пользователя: подписки и Telegram-линк.
create table if not exists public.user_profile (
  user_id uuid primary key references auth.users(id) on delete cascade,
  symbols text[] not null default '{}',          -- список пар, на которые подписан
  telegram_chat_id bigint,                        -- если подключил TG
  telegram_link_code text,                        -- одноразовый код для привязки
  telegram_linked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists user_profile_tg_code_idx on public.user_profile (telegram_link_code)
  where telegram_link_code is not null;
create index if not exists user_profile_tg_chat_idx on public.user_profile (telegram_chat_id)
  where telegram_chat_id is not null;

alter table public.user_profile enable row level security;

drop policy if exists profile_select_own on public.user_profile;
create policy profile_select_own on public.user_profile
  for select to authenticated using (auth.uid() = user_id);

drop policy if exists profile_insert_own on public.user_profile;
create policy profile_insert_own on public.user_profile
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists profile_update_own on public.user_profile;
create policy profile_update_own on public.user_profile
  for update to authenticated using (auth.uid() = user_id);

-- Триггер updated_at
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end $$ language plpgsql;

drop trigger if exists user_profile_touch on public.user_profile;
create trigger user_profile_touch before update on public.user_profile
  for each row execute function public.touch_updated_at();

-- 3. Realtime для живой ленты сигналов. Включает Supabase realtime на этой таблице.
alter publication supabase_realtime add table public.signals;
