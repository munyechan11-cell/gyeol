-- ============================================================
-- Supabase 어드바이저 지적 반영.
--
-- 세 가지는 고치고, 세 가지는 의도한 것이라 남긴다. 남기는 쪽도 여기 적어 둔다 —
-- 안 적어 두면 다음에 보는 사람이 "경고가 있네" 하고 되돌린다.
-- ============================================================

-- ── 1. 함수 search_path 고정 ─────────────────────────────────
-- search_path 가 열려 있으면 호출자가 그 값을 바꿔 같은 이름의 다른 함수·테이블을
-- 가리키게 만들 수 있다. 나머지 함수에는 이미 걸어 뒀는데 이 셋을 빠뜨렸다.
-- is_doc_table 은 특히 중요하다 — save_doc 의 테이블 화이트리스트가 이 함수다.

create or replace function public.is_doc_table(p_table text) returns boolean
language sql immutable set search_path = public as $$
  select p_table = any (array[
    'users','visits','coupons','tables','sections','communications','tier_overrides',
    'menus','orders','reservations','photos','shifts','ingredients','expenses',
    'marketing_drafts','print_jobs','app_state'
  ])
$$;

create or replace function public.hm_to_min(hm text) returns int
language sql immutable set search_path = public as $$
  select case
           when hm ~ '^\d{1,2}:\d{2}$'
             then split_part(hm, ':', 1)::int * 60 + split_part(hm, ':', 2)::int
           else null
         end
$$;

create or replace function public.my_device_store_id() returns uuid
language sql stable set search_path = public as $$
  select case
           when auth.jwt() -> 'app_metadata' ->> 'device' = 'printbridge'
             then nullif(auth.jwt() -> 'app_metadata' ->> 'storeId', '')::uuid
           else null
         end
$$;

-- ── 2. 정책 안의 auth.uid() 를 한 번만 평가하게 ───────────────
-- 정책 본문에 auth.uid() 를 그냥 쓰면 **행마다** 다시 부른다. 스칼라 서브쿼리로
-- 감싸면 Postgres 가 쿼리당 한 번만 계산한다(InitPlan). 판정 결과는 같다 —
-- auth.uid() 는 한 요청 안에서 변하지 않는다.
-- 손님 한 명의 주문·쿠폰을 훑을 때 차이가 난다.

drop policy if exists "users_read_self" on public.users;
create policy "users_read_self" on public.users for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "users_self_insert" on public.users;
create policy "users_self_insert" on public.users for insert to authenticated
  with check (id = (select auth.uid()));

drop policy if exists "users_self_update" on public.users;
create policy "users_self_update" on public.users for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "orders_read" on public.orders;
create policy "orders_read" on public.orders for select to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));

drop policy if exists "orders_insert" on public.orders;
create policy "orders_insert" on public.orders for insert to authenticated
  with check ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));

drop policy if exists "coupons_read" on public.coupons;
create policy "coupons_read" on public.coupons for select to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));

drop policy if exists "coupons_update" on public.coupons;
create policy "coupons_update" on public.coupons for update to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()))
  with check ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));

-- ── 3. 외래키 인덱스 ────────────────────────────────────────
-- 부모(users) 행을 지울 때 Postgres 가 자식 테이블에서 참조를 찾아야 하는데,
-- 인덱스가 없으면 전체를 훑는다. 계정 삭제가 느려지는 자리다.
create index if not exists merchant_map_store_idx  on public.merchant_map ("storeId");
create index if not exists pairing_codes_store_idx on public.pairing_codes ("storeId");

-- ============================================================
-- 고치지 않는 것 — 지적이 맞지 않거나, 고치는 쪽이 더 나쁘다.
--
-- · rls_enabled_no_policy (store_secrets·pairing_codes·merchant_map·tossplace_diag)
--   "RLS 는 켰는데 정책이 없다" — 그게 목적이다. 정책 0개 = 클라이언트 접근 0.
--   서버(service_role)만 닿아야 하는 자료다(정산 키·페어링 코드).
--
-- · authenticated_security_definer_function_executable (my_role·my_store_id)
--   정책이 이 함수들을 부르므로 authenticated 에게 EXECUTE 가 있어야 한다.
--   RPC 로 직접 불러도 인자가 없고 **자기 자신의** 역할·매장만 돌려준다 —
--   자기 users 행을 읽으면 어차피 아는 값이다.
--
-- · multiple_permissive_policies (users)
--   본인용 정책과 사장용 정책이 따로 있다. 하나로 합치면 빠르지만,
--   "내 것"과 "우리 매장 손님"은 서로 다른 판단이라 합치면 읽기 어려워진다.
--   users 는 작은 테이블이라 명확성을 택한다.
--
-- · unused_index (12건)
--   지금 DB 가 비어 있어서 **아무 인덱스도 안 쓰인 게 당연하다.** 이걸 근거로
--   storeId 인덱스를 지우면 매장별 조회가 전부 전체 훑기가 된다. 지우면 안 된다.
-- ============================================================
