-- ============================================================
-- 결(Gyeol) — Postgres 스키마 (Firestore 이전)
--
-- 핵심 설계: **쓰기 가능한 컬럼은 `data jsonb` 하나뿐이다.**
--
-- 앱은 Firestore 문서를 통째로 다루고(`{ id, ...data }`) 부분 패치로 저장한다(merge).
-- 그 모양을 유지해야 화면 수백 개를 안 건드리고 옮길 수 있다. 그런데 필터·정렬·권한
-- 판정에 쓰이는 필드는 진짜 컬럼이어야 인덱스와 RLS 가 걸린다.
--
-- 둘 다 얻는 방법이 생성 컬럼(generated always as ... stored)이다.
-- `"storeId"` 같은 컬럼은 `data` 에서 자동으로 계산되므로:
--   · 인덱스·외래키·RLS 정책이 평범한 컬럼처럼 걸린다
--   · 쓰기 경로는 `data` 하나라 저장 로직이 테이블마다 갈라지지 않는다
--     (save_doc() 이 모든 테이블에 그대로 통한다 — 20_doc_api.sql 참고)
--   · 앱이 보내는 문서에서 storeId 만 따로 빼내는 변환이 필요 없다
--
-- 컬럼명은 앱과 같은 camelCase 를 따옴표로 쓴다. snake_case 로 바꾸면 데이터 계층마다
-- 이름을 번역해야 하고, 그 번역이 곧 버그가 된다.
--
-- 승격(=생성 컬럼으로 노출) 대상은 "앱이 실제로 필터·정렬·권한 판정에 쓰는가"로 골랐다.
-- 나머지를 컬럼으로 펴는 정규화는 이전이 끝난 뒤 별도로 한다 — 이전과 재설계를
-- 같이 하면 무엇이 깨졌는지 구분할 수 없다.
-- ============================================================

-- ------------------------------------------------------------
-- users — 계정. id 는 auth.users 의 uuid 를 그대로 쓴다.
--   Firestore 시절엔 앱이 만든 자체 ID 라 보안 규칙이 요청자를 식별하지 못했고,
--   그게 "익명 로그인만 하면 전 매장 접근" 구멍의 근본 원인이었다. 여기서 끊는다.
--
--   role 만 예외적으로 실제 컬럼이다. 계정의 종류는 본인이 바꿀 수 없어야 하는데,
--   생성 컬럼이면 data 를 고쳐 스스로 승격할 수 있게 된다.
-- ------------------------------------------------------------
create table if not exists public.users (
  id                uuid primary key references auth.users(id) on delete cascade,
  role              text not null check (role in ('customer','owner','staff')),
  "employerStoreId" uuid    generated always as ((data->>'employerStoreId')::uuid) stored,
  "employerStatus"  text    generated always as (data->>'employerStatus') stored,
  "staffLevel"      int     generated always as ((data->>'staffLevel')::int) stored,
  phone             text    generated always as (data->>'phone') stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.users is '계정 — 손님·사장님·직원. 사장님의 id 가 곧 그 매장의 storeId.';
comment on column public.users.role is '생성 컬럼이 아니다 — data 를 고쳐 스스로 승격하는 것을 막기 위해 실제 컬럼으로 둔다.';

create index if not exists users_phone_idx on public.users (phone);
create index if not exists users_employer_idx on public.users ("employerStoreId");
create index if not exists users_role_idx on public.users (role);

-- 방문 기록
create table if not exists public.visits (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  "customerId" uuid generated always as ((data->>'customerId')::uuid) stored,
  date text generated always as ((data->>'date')) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.visits is '방문 기록';
create index if not exists visits_store_idx on public.visits ("storeId");
create index if not exists visits_customerid_idx on public.visits ("storeId", "customerId");
create index if not exists visits_date_idx on public.visits ("storeId", date);

-- 쿠폰
create table if not exists public.coupons (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  "customerId" uuid generated always as ((data->>'customerId')::uuid) stored,
  status text generated always as ((data->>'status')) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.coupons is '쿠폰';
create index if not exists coupons_store_idx on public.coupons ("storeId");
create index if not exists coupons_customerid_idx on public.coupons ("storeId", "customerId");
create index if not exists coupons_status_idx on public.coupons ("storeId", status);

-- 매장 테이블 배치
create table if not exists public.tables (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  number int generated always as ((data->>'number')::int) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.tables is '매장 테이블 배치';
create index if not exists tables_store_idx on public.tables ("storeId");
create index if not exists tables_number_idx on public.tables ("storeId", number);

-- 테이블 구역
create table if not exists public.sections (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.sections is '테이블 구역';
create index if not exists sections_store_idx on public.sections ("storeId");

-- 고객 커뮤니케이션 이력
create table if not exists public.communications (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  "customerId" uuid generated always as ((data->>'customerId')::uuid) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.communications is '고객 커뮤니케이션 이력';
create index if not exists communications_store_idx on public.communications ("storeId");
create index if not exists communications_customerid_idx on public.communications ("storeId", "customerId");

-- 등급 수동 지정
create table if not exists public.tier_overrides (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  "customerId" uuid generated always as ((data->>'customerId')::uuid) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.tier_overrides is '등급 수동 지정';
create index if not exists tier_overrides_store_idx on public.tier_overrides ("storeId");
create index if not exists tier_overrides_customerid_idx on public.tier_overrides ("storeId", "customerId");

-- 메뉴
create table if not exists public.menus (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.menus is '메뉴';
create index if not exists menus_store_idx on public.menus ("storeId");

-- 주문
create table if not exists public.orders (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  "customerId" uuid generated always as ((data->>'customerId')::uuid) stored,
  status text generated always as ((data->>'status')) stored,
  "tableNumber" int generated always as ((data->>'tableNumber')::int) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.orders is '주문';
create index if not exists orders_store_idx on public.orders ("storeId");
create index if not exists orders_customerid_idx on public.orders ("storeId", "customerId");
create index if not exists orders_status_idx on public.orders ("storeId", status);

-- 예약
create table if not exists public.reservations (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  date text generated always as ((data->>'date')) stored,
  status text generated always as ((data->>'status')) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.reservations is '예약';
create index if not exists reservations_store_idx on public.reservations ("storeId");
create index if not exists reservations_date_idx on public.reservations ("storeId", date);
create index if not exists reservations_status_idx on public.reservations ("storeId", status);

-- 사진(메뉴·리뷰)
create table if not exists public.photos (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  type text generated always as ((data->>'type')) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.photos is '사진(메뉴·리뷰)';
create index if not exists photos_store_idx on public.photos ("storeId");
create index if not exists photos_type_idx on public.photos ("storeId", type);

-- 출퇴근 기록
create table if not exists public.shifts (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  "staffId" uuid generated always as ((data->>'staffId')::uuid) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.shifts is '출퇴근 기록';
create index if not exists shifts_store_idx on public.shifts ("storeId");
create index if not exists shifts_staffid_idx on public.shifts ("storeId", "staffId");

-- 재고
create table if not exists public.ingredients (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.ingredients is '재고';
create index if not exists ingredients_store_idx on public.ingredients ("storeId");

-- 지출
create table if not exists public.expenses (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  date text generated always as ((data->>'date')) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.expenses is '지출';
create index if not exists expenses_store_idx on public.expenses ("storeId");
create index if not exists expenses_date_idx on public.expenses ("storeId", date);

-- 마케팅 초안
create table if not exists public.marketing_drafts (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  status text generated always as ((data->>'status')) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.marketing_drafts is '마케팅 초안';
create index if not exists marketing_drafts_store_idx on public.marketing_drafts ("storeId");
create index if not exists marketing_drafts_status_idx on public.marketing_drafts ("storeId", status);

-- 영수증 인쇄 큐
create table if not exists public.print_jobs (
  id                uuid primary key,
  "storeId"         uuid generated always as ((data->>'storeId')::uuid) stored
                      references public.users(id) on delete cascade,
  status text generated always as ((data->>'status')) stored,
  data              jsonb not null default '{}'::jsonb,
  "createdAt"       timestamptz not null default now(),
  "updatedAt"       timestamptz not null default now()
);
comment on table public.print_jobs is '영수증 인쇄 큐';
create index if not exists print_jobs_store_idx on public.print_jobs ("storeId");
create index if not exists print_jobs_status_idx on public.print_jobs ("storeId", status);

-- ------------------------------------------------------------
-- 매장에 속하지 않는 것들
-- ------------------------------------------------------------
create table if not exists public.app_state (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  "updatedAt" timestamptz not null default now()
);
comment on table public.app_state is '앱 전역 설정(마스터 비밀번호 등).';

-- 서버 전용 3종 — RLS 는 켜되 정책을 하나도 만들지 않는다(= 클라이언트 접근 0).
create table if not exists public.store_secrets (
  "storeId"   uuid primary key references public.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  "updatedAt" timestamptz not null default now()
);
comment on table public.store_secrets is '토스 시크릿 키 등. service_role 만 접근.';

create table if not exists public.pairing_codes (
  code        text primary key,
  "storeId"   uuid not null references public.users(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  "expiresAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
comment on table public.pairing_codes is '영수증 브릿지 페어링 코드. service_role 만 접근.';

create table if not exists public.merchant_map (
  "merchantId" text primary key,
  "storeId"    uuid not null references public.users(id) on delete cascade,
  "createdAt"  timestamptz not null default now()
);
comment on table public.merchant_map is '토스플레이스 merchantId → storeId 역매핑. service_role 만 접근.';

-- ------------------------------------------------------------
-- updatedAt 자동 갱신
-- ------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new."updatedAt" = now();
  return new;
end;
$$;
revoke all on function public.touch_updated_at() from public, anon, authenticated;

drop trigger if exists users_touch on public.users;
create trigger users_touch before update on public.users
  for each row execute function public.touch_updated_at();
drop trigger if exists visits_touch on public.visits;
create trigger visits_touch before update on public.visits
  for each row execute function public.touch_updated_at();
drop trigger if exists coupons_touch on public.coupons;
create trigger coupons_touch before update on public.coupons
  for each row execute function public.touch_updated_at();
drop trigger if exists tables_touch on public.tables;
create trigger tables_touch before update on public.tables
  for each row execute function public.touch_updated_at();
drop trigger if exists sections_touch on public.sections;
create trigger sections_touch before update on public.sections
  for each row execute function public.touch_updated_at();
drop trigger if exists communications_touch on public.communications;
create trigger communications_touch before update on public.communications
  for each row execute function public.touch_updated_at();
drop trigger if exists tier_overrides_touch on public.tier_overrides;
create trigger tier_overrides_touch before update on public.tier_overrides
  for each row execute function public.touch_updated_at();
drop trigger if exists menus_touch on public.menus;
create trigger menus_touch before update on public.menus
  for each row execute function public.touch_updated_at();
drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();
drop trigger if exists reservations_touch on public.reservations;
create trigger reservations_touch before update on public.reservations
  for each row execute function public.touch_updated_at();
drop trigger if exists photos_touch on public.photos;
create trigger photos_touch before update on public.photos
  for each row execute function public.touch_updated_at();
drop trigger if exists shifts_touch on public.shifts;
create trigger shifts_touch before update on public.shifts
  for each row execute function public.touch_updated_at();
drop trigger if exists ingredients_touch on public.ingredients;
create trigger ingredients_touch before update on public.ingredients
  for each row execute function public.touch_updated_at();
drop trigger if exists expenses_touch on public.expenses;
create trigger expenses_touch before update on public.expenses
  for each row execute function public.touch_updated_at();
drop trigger if exists marketing_drafts_touch on public.marketing_drafts;
create trigger marketing_drafts_touch before update on public.marketing_drafts
  for each row execute function public.touch_updated_at();
drop trigger if exists print_jobs_touch on public.print_jobs;
create trigger print_jobs_touch before update on public.print_jobs
  for each row execute function public.touch_updated_at();
drop trigger if exists app_state_touch on public.app_state;
create trigger app_state_touch before update on public.app_state
  for each row execute function public.touch_updated_at();
drop trigger if exists store_secrets_touch on public.store_secrets;
create trigger store_secrets_touch before update on public.store_secrets
  for each row execute function public.touch_updated_at();
