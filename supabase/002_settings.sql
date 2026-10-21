-- v19.9 설정(ledger_cfg)을 서버에 저장하는 테이블
-- 이미 schema.sql을 실행한 프로젝트에서 이 파일만 SQL Editor에 붙여넣고 Run. 여러 번 실행해도 안전.

create table if not exists public.settings (
  id          text primary key,            -- 항상 'main' 한 행
  value       jsonb not null default '{}', -- 충전요청 기준 금액, 정기 문자, 매장 홍보(사진 포함) 등
  inserted_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- updated_at 자동 갱신 (변경 이력 audit_log는 홍보 사진 용량 때문에 기록하지 않음)
drop trigger if exists settings_touch on public.settings;
create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();

alter table public.settings enable row level security;
drop policy if exists settings_select on public.settings;
drop policy if exists settings_insert on public.settings;
drop policy if exists settings_update on public.settings;
create policy settings_select on public.settings for select to authenticated using (true);
create policy settings_insert on public.settings for insert to authenticated with check (true);
create policy settings_update on public.settings for update to authenticated using (true) with check (true);
