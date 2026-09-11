-- ============================================================
-- 서버 전용 테이블 정리 — 어댑터와 스키마가 어긋나 있던 곳.
--
-- 다른 테이블은 전부 "data jsonb 하나만 쓰고, 조회에 쓰는 필드는 생성 컬럼으로
-- 뽑아 쓴다"는 규칙을 따른다. 그런데 pairing_codes 와 merchant_map 만
-- storeId 가 진짜 컬럼(not null)이었다. 어댑터는 규칙대로 data 에만 쓰므로
-- 이 두 테이블에 대한 저장은 **항상 실패한다**(not-null 위반).
-- merchant_map 은 data 컬럼조차 없어서 컬럼 부재로도 실패한다.
--
-- 규칙에 맞춘다. 생성 컬럼으로 바꿔도 users 로 가는 외래키는 그대로 유지된다.
-- (테이블이 비어 있어 drop/add 로 바꿔도 잃을 데이터가 없다.)
--
-- pairing_codes.expiresAt 은 컬럼을 없앤다. 5분짜리 값을 조회 조건으로 쓰는 곳이
-- 없고, 라우트는 epoch 밀리초(숫자)로 넣는데 timestamptz 로는 캐스팅되지 않는다.
-- data 안의 숫자로 두고 라우트가 직접 비교한다.
-- ============================================================

alter table public.pairing_codes drop column if exists "expiresAt";
alter table public.pairing_codes drop column if exists "storeId";
alter table public.pairing_codes
  add column if not exists "storeId" uuid
  generated always as ((data->>'storeId')::uuid) stored
  references public.users(id) on delete cascade;

alter table public.merchant_map add column if not exists data jsonb not null default '{}'::jsonb;
alter table public.merchant_map drop column if exists "storeId";
alter table public.merchant_map
  add column if not exists "storeId" uuid
  generated always as ((data->>'storeId')::uuid) stored
  references public.users(id) on delete cascade;

-- ------------------------------------------------------------
-- 토스플레이스 웹훅 진단.
--
-- 라우트가 tossplace_diag/last 에 "마지막 웹훅이 언제 어떤 모양으로 왔는가"를
-- 남긴다. "결제했는데 매출이 안 늘어난다"는 문의를 가를 때 쓰는 유일한 단서다
-- (웹훅이 아예 안 온 것인지, 와서 매핑에 실패한 것인지).
--
-- merchantId 가 들어가므로 클라이언트에 열지 않는다 — 다른 서버 전용 테이블과
-- 같이 정책을 하나도 만들지 않는다(= 접근 0). 조회는 서버 엔드포인트를 거친다.
-- ------------------------------------------------------------
create table if not exists public.tossplace_diag (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  "updatedAt" timestamptz not null default now()
);
comment on table public.tossplace_diag is '토스플레이스 웹훅 마지막 수신 기록. service_role 만 접근.';

alter table public.tossplace_diag enable row level security;
alter table public.tossplace_diag force row level security;

drop trigger if exists tossplace_diag_touch on public.tossplace_diag;
create trigger tossplace_diag_touch before update on public.tossplace_diag
  for each row execute function public.touch_updated_at();
