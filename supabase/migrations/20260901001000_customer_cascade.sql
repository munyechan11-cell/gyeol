-- ============================================================
-- customerId 두 가지 — 빈 값에 터지던 것, 그리고 계정 삭제가 흘러가지 않던 것.
--
-- **1) 빈 문자열이 uuid 캐스팅을 터뜨린다.**
-- 생성 컬럼이 `(data->>'customerId')::uuid` 인데, 앱에는 손님 없는 주문이 있다.
-- 토스 POS 웹훅은 `customerId: ''` 로 넣는다 — 카운터 결제라 손님 계정이 없다.
-- 빈 문자열을 uuid 로 캐스팅하면 그 자리에서 실패하므로, POS 매출이 한 건도
-- 안 들어온다. nullif 로 감싸 빈 값은 null 이 되게 한다.
--
-- **2) 손님 계정을 지워도 그 손님의 기록이 남는다.**
-- storeId 쪽에는 전부 외래키가 걸려 있는데 customerId 쪽에는 하나도 없었다.
-- 예전 클라이언트 코드는 컬렉션을 직접 훑어 지웠지만, RLS 를 건 지금은 그
-- 조회 자체가 막힌다(막는 게 맞다 — 그러려면 남의 매장 문서를 읽을 수 있어야 했다).
-- 삭제는 DB 에 맡긴다.
--
-- **orders 만 예외로 둔다.** 손님이 탈퇴했다고 그 매장의 매출 기록까지 지우면
-- 안 된다. 외래키를 걸지 않는다(생성 컬럼이라 on delete set null 도 쓸 수 없다 —
-- 생성 컬럼은 외래키 동작으로 값을 바꿀 수 없다). 주문은 남고, 그 안의
-- customerId 는 이제 아무 계정도 가리키지 않는 값이 된다.
-- ============================================================

-- 생성 컬럼은 식을 바꿀 수 없어 다시 만든다. (테이블이 비어 있어 잃을 값이 없다.)
-- orders·coupons 정책이 이 열을 참조하므로 잠시 내렸다가 그대로 다시 세운다.
drop policy if exists "orders_read"   on public.orders;
drop policy if exists "orders_insert" on public.orders;
drop policy if exists "coupons_read"   on public.coupons;
drop policy if exists "coupons_update" on public.coupons;

alter table public.orders drop column if exists "customerId";
alter table public.orders
  add column "customerId" uuid
  generated always as (nullif(data->>'customerId', '')::uuid) stored;

alter table public.visits drop column if exists "customerId";
alter table public.visits
  add column "customerId" uuid
  generated always as (nullif(data->>'customerId', '')::uuid) stored
  references public.users(id) on delete cascade;

alter table public.coupons drop column if exists "customerId";
alter table public.coupons
  add column "customerId" uuid
  generated always as (nullif(data->>'customerId', '')::uuid) stored
  references public.users(id) on delete cascade;

alter table public.communications drop column if exists "customerId";
alter table public.communications
  add column "customerId" uuid
  generated always as (nullif(data->>'customerId', '')::uuid) stored
  references public.users(id) on delete cascade;

alter table public.tier_overrides drop column if exists "customerId";
alter table public.tier_overrides
  add column "customerId" uuid
  generated always as (nullif(data->>'customerId', '')::uuid) stored
  references public.users(id) on delete cascade;

alter table public.shifts drop column if exists "staffId";
alter table public.shifts
  add column "staffId" uuid
  generated always as (nullif(data->>'staffId', '')::uuid) stored
  references public.users(id) on delete cascade;

-- 내려 두었던 정책을 원래대로 복구한다.
create policy "orders_read" on public.orders for select to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = auth.uid());
create policy "orders_insert" on public.orders for insert to authenticated
  with check ("storeId" = public.my_store_id() or "customerId" = auth.uid());
create policy "coupons_read" on public.coupons for select to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = auth.uid());
create policy "coupons_update" on public.coupons for update to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = auth.uid())
  with check ("storeId" = public.my_store_id() or "customerId" = auth.uid());

-- 손님 화면은 "내 방문·내 쿠폰"을 이 열로 찾는다.
create index if not exists visits_customer_idx         on public.visits ("customerId");
create index if not exists coupons_customer_idx        on public.coupons ("customerId");
create index if not exists communications_customer_idx on public.communications ("customerId");
create index if not exists tier_overrides_customer_idx on public.tier_overrides ("customerId");
create index if not exists shifts_staff_idx            on public.shifts ("staffId");
