-- ============================================================
-- 페르소나 테스트(supabase/tests/personas.sql)가 운영에서 찾아낸 결함 셋.
-- 정책 테스트(rls.sql)는 전부 통과하는데 기능은 죽어 있던 자리들이다.
--
--   1. 키오스크·빠른주문·워크인 주문이 저장되지 않는다 (22P02)
--   2. 사장님이 직원 소속을 해제하지 못한다 (42501)
--   3. 손님이 자기 쿠폰의 금액과 사용 여부를 고칠 수 있다  ← 돈이 새는 자리
-- ============================================================


-- ── 1. 손님 없는 주문 — 키오스크·POS 빠른주문·워크인 ──────────────
--
-- orders."customerId" 는 `nullif(data->>'customerId','')::uuid` 생성 컬럼이라
-- 앱이 쓰는 게스트 id(kiosk_T3·pos_T5·walkin_W101)가 캐스팅에서 터진다.
-- 주문 자체가 저장되지 않으므로 키오스크·빠른주문·대기손님 주문이 전부 죽는다.
--
-- 왜 앱을 고치지 않고 컬럼을 고치는가: data->>'customerId' 는 앱이 "이 주문들이
-- 한 손님 것"임을 묶는 **그룹 키**다(approvePayment 가 이걸로 계산서를 모은다).
-- 게스트에게는 계정이 없으니 uuid 일 수가 없다. 반면 uuid 컬럼은 RLS 와 인덱스만
-- 쓴다 — 계정이 없는 주문에서는 null 이 맞는 값이다. 실제로 이 컬럼만 유일하게
-- users 외래키가 없다(visits·coupons·communications·tier_overrides 는 있다).
-- 설계는 이미 "주문의 손님은 계정이 아닐 수 있다"고 말하고 있었고, 캐스팅만
-- 그걸 몰랐다.
--
-- 안전한가: 게스트 주문은 customerId 가 null 이 되어 orders_insert 의
-- `"customerId" = auth.uid()` 를 만족하지 못한다. 매장 사람이 넣는 주문은
-- `"storeId" = my_store_id()` 로 통과하고, 손님이 남의 이름으로 밀어 넣으려 하면
-- 두 조건 모두 어긋나 거부된다 — 지금보다 좁아지지 넓어지지 않는다.

-- 캐스팅되면 uuid, 아니면 null. 생성 컬럼에 쓰려면 immutable 이어야 한다.
create or replace function public.try_uuid(p_text text) returns uuid
language plpgsql immutable strict parallel safe as $$
begin
  return p_text::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;
comment on function public.try_uuid(text) is
  'uuid 로 캐스팅되면 uuid, 아니면 null. 게스트 주문의 customerId 처럼 계정 id 가 아닐 수 있는 값에 쓴다.';

-- 생성 컬럼은 바꿔 끼울 수 없다. 물고 있는 정책을 내리고 컬럼을 다시 세운다.
drop policy if exists "orders_read"   on public.orders;
drop policy if exists "orders_insert" on public.orders;
drop policy if exists "orders_update" on public.orders;

alter table public.orders drop column if exists "customerId";
alter table public.orders
  add column "customerId" uuid
  generated always as (public.try_uuid(nullif(data ->> 'customerId', ''))) stored;

-- init_schema 가 세웠던 인덱스. 1000 이 컬럼을 내리면서 같이 사라졌고
-- (외래키가 없어 1000 의 FK 인덱스 복구 목록에도 들지 않았다) 이후 없는 채로 있었다.
create index if not exists orders_customerid_idx on public.orders ("storeId", "customerId");

create policy "orders_read" on public.orders for select to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));
create policy "orders_insert" on public.orders for insert to authenticated
  with check ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));
create policy "orders_update" on public.orders for update to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()))
  with check ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));


-- ── 2. 직원 소속 해제 — 사장님만 42501 이던 자리 ────────────────────
--
-- 증상: 거절(rejected)과 직원 본인의 신청 철회는 되는데, 사장님의 해제만 막힌다.
-- 원인은 쓰기 정책이 아니라 **읽기 정책**이다. users_owner_update 의 with check 는
-- employerStoreId 가 null 인 경우를 이미 허용한다(실측으로 참을 확인했다).
-- 그런데 employerStoreId 를 비우면 그 행이 users_read_store_members 밖으로 나가고,
-- 갱신된 행이 갱신자에게 보이지 않으면 Postgres 가 42501 로 되돌린다.
-- 트리거를 꺼도 실패하고, 새 행이 보이는 select 정책을 하나 더하면 성공한다 —
-- 그렇게 갈라서 확인했다.
--
-- 그래서 읽기를 넓히지 않는다. 읽기를 넓히면 "해제된 옛 직원"이 그 매장에
-- 영원히 보이거나, 남의 매장 직원까지 보이게 된다. 대신 규칙을 아는 함수에
-- 맡긴다 — record_visit·claim_review_coupon 과 같은 방식이다.

create or replace function public.release_staff(p_staff_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.my_store_id();
begin
  if public.my_role() <> 'owner' or v_store is null then
    raise exception '사장님만 직원 소속을 해제할 수 있습니다' using errcode = '42501';
  end if;

  -- 우리 매장 직원만. 남의 매장 직원도, 사장 행도, 손님 행도 건드리지 못한다.
  update public.users
     set data = public.apply_patch(data,
           '{"employerStoreId":null,"employerStatus":null,"position":null}'::jsonb)
   where id = p_staff_id
     and role = 'staff'
     and data ->> 'employerStoreId' = v_store::text;

  if not found then
    raise exception '우리 매장 직원이 아닙니다' using errcode = '42501';
  end if;
end;
$$;
comment on function public.release_staff(uuid) is
  '사장님이 우리 매장 직원의 소속을 해제한다. 해제된 행은 매장 읽기 범위 밖으로 나가므로 함수가 대신 쓴다.';
revoke all on function public.release_staff(uuid) from public, anon;
grant execute on function public.release_staff(uuid) to authenticated;


-- ── 3. 쿠폰 — 손님이 자기 쿠폰을 고치던 자리 ────────────────────────
--
-- coupons_update 는 `customerId = auth.uid()` 를 열어 두고 **어떤 필드를** 고칠 수
-- 있는지는 못 박지 않았다. 그래서 지금 손님은 자기 쿠폰의 amount 를 999999 로
-- 올리고, 다 쓴 쿠폰의 status 를 used → available 로 되돌려 다시 쓸 수 있다.
-- 주문(guard_order_customer_update)과 테이블에는 있는 트리거가 쿠폰에는 없었다.
--
-- 손님에게 허락된 것은 두 가지뿐이다: 사용 요청(available → pending)과
-- 그 취소(pending → available). 나머지 필드는 손도 못 댄다.
-- 승인(→ used)·발급·금액은 매장과 서버 함수의 몫이다.

create or replace function public.guard_coupon_customer_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or current_setting('gyeol.trusted', true) = '1' then return new; end if;
  -- 매장 사람(사장·승인 직원). 어느 쿠폰까지 닿는지는 coupons_update 정책이 정한다.
  --
  -- storeId 는 생성 컬럼이라 BEFORE 트리거에서는 아직 null 이다 — data 에서 직접 읽는다.
  -- old 를 보는 이유: "이 쿠폰이 우리 매장 것인가"가 판정 기준이고, 손님이 patch 로
  -- storeId 를 바꿔 매장인 척하는 경로를 애초에 만들지 않는다.
  if old.data ->> 'storeId' = public.my_store_id()::text then return new; end if;

  -- 여기부터는 손님이 자기 쿠폰을 고치는 경우.
  if (new.data - 'status' - 'usedAtTable') is distinct from (old.data - 'status' - 'usedAtTable') then
    raise exception '손님은 쿠폰의 사용 요청·취소만 할 수 있습니다' using errcode = '42501';
  end if;
  if new.data ->> 'status' is distinct from old.data ->> 'status'
     and not ((old.data ->> 'status' = 'available' and new.data ->> 'status' = 'pending')
           or (old.data ->> 'status' = 'pending'   and new.data ->> 'status' = 'available'))
  then
    raise exception '쿠폰 사용 승인은 사장님이 합니다' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_coupon_customer_update() from public, anon, authenticated;
drop trigger if exists coupons_guard_customer on public.coupons;
create trigger coupons_guard_customer before update on public.coupons
  for each row execute function public.guard_coupon_customer_update();
