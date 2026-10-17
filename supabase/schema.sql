-- 장부결제 v20 스키마
-- Supabase 대시보드 → SQL Editor에 전체를 붙여넣고 Run.
-- 여러 번 실행해도 안전하도록 작성됨 (if not exists / or replace).

-- ============================================================
-- 1. 거래처
-- ============================================================
create table if not exists public.companies (
  id          text primary key,              -- 앱이 만든 ID 그대로 (예: c1775035972050)
  name        text not null,
  manager     text,
  phone       text,
  reg_date    text,                          -- 앱의 createdAt ("YYYY-MM-DD")
  extra       jsonb not null default '{}',   -- 위 컬럼에 없는 앱 필드 (데이터 유실 방지용)
  inserted_at timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz                    -- null이 아니면 삭제된 행 (소프트 삭제)
);

-- ============================================================
-- 2. 거래 (충전 deposit / 사용 usage)
-- ============================================================
create table if not exists public.transactions (
  id             text primary key,           -- 앱이 만든 ID 그대로 (예: t1791975510117)
  company_id     text not null,               -- FK 없음: 기존 데이터에 거래처가 삭제된 거래가 있을 수 있음
  type           text not null check (type in ('deposit', 'usage')),
  amount         bigint not null,
  description    text,                       -- 앱의 desc
  occurred_at    timestamptz not null,       -- 앱의 date
  staff          text,
  client_name    text,                       -- 앱의 clientName
  ppl            integer,
  sig_path       text,                       -- 서명 이미지 경로 (Storage: signatures 버킷)
  staff_sig_path text,
  admin_sig_path text,
  extra          jsonb not null default '{}',
  inserted_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

create index if not exists transactions_company_idx on public.transactions (company_id) where deleted_at is null;
create index if not exists transactions_occurred_idx on public.transactions (occurred_at);

-- ============================================================
-- 3. 변경 이력 (누가 언제 무엇을 바꿨는지, 실수 복구용)
-- ============================================================
create table if not exists public.audit_log (
  id         bigserial primary key,
  table_name text not null,
  row_id     text not null,
  action     text not null,                  -- INSERT / UPDATE
  old_row    jsonb,
  new_row    jsonb,
  changed_by uuid default auth.uid(),
  changed_at timestamptz not null default now()
);

-- updated_at 자동 갱신 (BEFORE UPDATE)
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- 이력 기록 (AFTER: upsert 시 실제로 일어난 동작만 기록됨)
create or replace function public.write_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_log (table_name, row_id, action, old_row, new_row)
  values (tg_table_name, new.id, tg_op,
          case when tg_op = 'UPDATE' then to_jsonb(old) end,
          to_jsonb(new));
  return null;
end $$;

drop trigger if exists companies_touch on public.companies;
drop trigger if exists companies_audit on public.companies;
create trigger companies_touch before update on public.companies
  for each row execute function public.touch_updated_at();
create trigger companies_audit after insert or update on public.companies
  for each row execute function public.write_audit();

drop trigger if exists transactions_touch on public.transactions;
drop trigger if exists transactions_audit on public.transactions;
create trigger transactions_touch before update on public.transactions
  for each row execute function public.touch_updated_at();
create trigger transactions_audit after insert or update on public.transactions
  for each row execute function public.write_audit();

-- ============================================================
-- 4. 보안 정책 (RLS): 로그인한 사용자만 읽기/쓰기, 실제 삭제(DELETE)는 불가
-- ============================================================
alter table public.companies    enable row level security;
alter table public.transactions enable row level security;
alter table public.audit_log    enable row level security;

drop policy if exists companies_select on public.companies;
drop policy if exists companies_insert on public.companies;
drop policy if exists companies_update on public.companies;
create policy companies_select on public.companies for select to authenticated using (true);
create policy companies_insert on public.companies for insert to authenticated with check (true);
create policy companies_update on public.companies for update to authenticated using (true) with check (true);

drop policy if exists transactions_select on public.transactions;
drop policy if exists transactions_insert on public.transactions;
drop policy if exists transactions_update on public.transactions;
create policy transactions_select on public.transactions for select to authenticated using (true);
create policy transactions_insert on public.transactions for insert to authenticated with check (true);
create policy transactions_update on public.transactions for update to authenticated using (true) with check (true);

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log for select to authenticated using (true);

-- ============================================================
-- 5. 서명 이미지 저장소 (비공개 버킷)
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('signatures', 'signatures', false, 1048576, array['image/jpeg', 'image/png'])
on conflict (id) do nothing;

drop policy if exists signatures_select on storage.objects;
drop policy if exists signatures_insert on storage.objects;
drop policy if exists signatures_update on storage.objects;
create policy signatures_select on storage.objects for select to authenticated using (bucket_id = 'signatures');
create policy signatures_insert on storage.objects for insert to authenticated with check (bucket_id = 'signatures');
create policy signatures_update on storage.objects for update to authenticated using (bucket_id = 'signatures');
