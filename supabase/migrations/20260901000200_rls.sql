-- ============================================================
-- RLS — 매장 격리와 권한 상승 차단.
--
-- Firestore 시절 규칙이 막지 못했던 것을 여기서 막는다. 근본 차이는 하나다:
-- 이제 auth.uid() 가 곧 users.id 라, "요청자가 누구이고 어느 매장 소속인가"를
-- 데이터베이스가 안다. (Firestore 에서는 앱이 만든 자체 ID 라 알 수 없었다.)
--
-- 정책 판정은 JWT claim 이 아니라 users 테이블을 본다. claim 방식은 등급을 바꿔도
-- 토큰을 새로 받기 전까지 옛 권한이 살아 있는데, 아래 방식은 즉시 반영된다.
-- ============================================================

-- 요청자의 소속 매장. 사장은 자기 자신, 승인된 직원은 소속 매장, 그 외는 null.
-- security definer 인 이유: users 자신에게도 RLS 가 걸려 있어서, 정책 안에서
-- users 를 평범하게 조회하면 무한 재귀가 난다.
create or replace function public.my_store_id() returns uuid
language sql stable security definer set search_path = public as $$
  select case
           when u.role = 'owner' then u.id
           when u.role = 'staff' and u."employerStatus" = 'approved' then u."employerStoreId"
           else null
         end
    from public.users u
   where u.id = auth.uid()
$$;
comment on function public.my_store_id is '요청자의 소속 매장 id. 손님·미승인 직원은 null 이라 어떤 매장에도 매칭되지 않는다.';

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select u.role from public.users u where u.id = auth.uid()), '')
$$;

-- anon(비로그인)은 호출조차 못 하게 한다. authenticated 는 RLS 정책이 이 함수를
-- 호출하므로 실행 권한이 필요하다 — 자기 자신에 대한 정보만 돌려주므로 노출돼도 무해하다.
revoke all on function public.my_store_id() from public, anon;
revoke all on function public.my_role() from public, anon;
grant execute on function public.my_store_id() to authenticated;
grant execute on function public.my_role() to authenticated;

alter table public.visits enable row level security;
alter table public.visits force row level security;
alter table public.coupons enable row level security;
alter table public.coupons force row level security;
alter table public.tables enable row level security;
alter table public.tables force row level security;
alter table public.sections enable row level security;
alter table public.sections force row level security;
alter table public.communications enable row level security;
alter table public.communications force row level security;
alter table public.tier_overrides enable row level security;
alter table public.tier_overrides force row level security;
alter table public.menus enable row level security;
alter table public.menus force row level security;
alter table public.orders enable row level security;
alter table public.orders force row level security;
alter table public.reservations enable row level security;
alter table public.reservations force row level security;
alter table public.photos enable row level security;
alter table public.photos force row level security;
alter table public.shifts enable row level security;
alter table public.shifts force row level security;
alter table public.ingredients enable row level security;
alter table public.ingredients force row level security;
alter table public.expenses enable row level security;
alter table public.expenses force row level security;
alter table public.marketing_drafts enable row level security;
alter table public.marketing_drafts force row level security;
alter table public.print_jobs enable row level security;
alter table public.print_jobs force row level security;
alter table public.users enable row level security;
alter table public.users force row level security;
alter table public.app_state enable row level security;
alter table public.app_state force row level security;
alter table public.store_secrets enable row level security;
alter table public.store_secrets force row level security;
alter table public.pairing_codes enable row level security;
alter table public.pairing_codes force row level security;
alter table public.merchant_map enable row level security;
alter table public.merchant_map force row level security;

-- visits
create policy "visits_read" on public.visits for select to authenticated
  using ("storeId" = public.my_store_id());
create policy "visits_insert" on public.visits for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "visits_update" on public.visits for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "visits_delete" on public.visits for delete to authenticated
  using ("storeId" = public.my_store_id());

-- coupons
create policy "coupons_read" on public.coupons for select to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = auth.uid());
create policy "coupons_insert" on public.coupons for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "coupons_update" on public.coupons for update to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = auth.uid())
  with check ("storeId" = public.my_store_id() or "customerId" = auth.uid());
create policy "coupons_delete" on public.coupons for delete to authenticated
  using ("storeId" = public.my_store_id());

-- tables
create policy "tables_read" on public.tables for select to authenticated
  using (true);
create policy "tables_insert" on public.tables for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "tables_update" on public.tables for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "tables_delete" on public.tables for delete to authenticated
  using ("storeId" = public.my_store_id());

-- sections
create policy "sections_read" on public.sections for select to authenticated
  using (true);
create policy "sections_insert" on public.sections for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "sections_update" on public.sections for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "sections_delete" on public.sections for delete to authenticated
  using ("storeId" = public.my_store_id());

-- communications
create policy "communications_read" on public.communications for select to authenticated
  using ("storeId" = public.my_store_id());
create policy "communications_insert" on public.communications for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "communications_update" on public.communications for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "communications_delete" on public.communications for delete to authenticated
  using ("storeId" = public.my_store_id());

-- tier_overrides
create policy "tier_overrides_read" on public.tier_overrides for select to authenticated
  using ("storeId" = public.my_store_id());
create policy "tier_overrides_insert" on public.tier_overrides for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "tier_overrides_update" on public.tier_overrides for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "tier_overrides_delete" on public.tier_overrides for delete to authenticated
  using ("storeId" = public.my_store_id());

-- menus
create policy "menus_read" on public.menus for select to authenticated
  using (true);
create policy "menus_insert" on public.menus for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "menus_update" on public.menus for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "menus_delete" on public.menus for delete to authenticated
  using ("storeId" = public.my_store_id());

-- orders
create policy "orders_read" on public.orders for select to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = auth.uid());
create policy "orders_insert" on public.orders for insert to authenticated
  with check ("storeId" = public.my_store_id() or "customerId" = auth.uid());
create policy "orders_update" on public.orders for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "orders_delete" on public.orders for delete to authenticated
  using ("storeId" = public.my_store_id());

-- reservations
create policy "reservations_read" on public.reservations for select to authenticated
  using ("storeId" = public.my_store_id());
create policy "reservations_insert" on public.reservations for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "reservations_update" on public.reservations for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "reservations_delete" on public.reservations for delete to authenticated
  using ("storeId" = public.my_store_id());

-- photos
create policy "photos_read" on public.photos for select to authenticated
  using (true);
create policy "photos_insert" on public.photos for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "photos_update" on public.photos for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "photos_delete" on public.photos for delete to authenticated
  using ("storeId" = public.my_store_id());

-- shifts
create policy "shifts_read" on public.shifts for select to authenticated
  using ("storeId" = public.my_store_id());
create policy "shifts_insert" on public.shifts for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "shifts_update" on public.shifts for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "shifts_delete" on public.shifts for delete to authenticated
  using ("storeId" = public.my_store_id());

-- ingredients
create policy "ingredients_read" on public.ingredients for select to authenticated
  using ("storeId" = public.my_store_id());
create policy "ingredients_insert" on public.ingredients for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "ingredients_update" on public.ingredients for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "ingredients_delete" on public.ingredients for delete to authenticated
  using ("storeId" = public.my_store_id());

-- expenses
create policy "expenses_read" on public.expenses for select to authenticated
  using ("storeId" = public.my_store_id());
create policy "expenses_insert" on public.expenses for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "expenses_update" on public.expenses for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "expenses_delete" on public.expenses for delete to authenticated
  using ("storeId" = public.my_store_id());

-- marketing_drafts
create policy "marketing_drafts_read" on public.marketing_drafts for select to authenticated
  using ("storeId" = public.my_store_id());
create policy "marketing_drafts_insert" on public.marketing_drafts for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "marketing_drafts_update" on public.marketing_drafts for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "marketing_drafts_delete" on public.marketing_drafts for delete to authenticated
  using ("storeId" = public.my_store_id());

-- print_jobs
create policy "print_jobs_read" on public.print_jobs for select to authenticated
  using ("storeId" = public.my_store_id());
create policy "print_jobs_insert" on public.print_jobs for insert to authenticated
  with check ("storeId" = public.my_store_id());
create policy "print_jobs_update" on public.print_jobs for update to authenticated
  using ("storeId" = public.my_store_id())
  with check ("storeId" = public.my_store_id());
create policy "print_jobs_delete" on public.print_jobs for delete to authenticated
  using ("storeId" = public.my_store_id());

-- ------------------------------------------------------------
-- users — 손님 계정에는 storeId 가 없어 매장으로 나눌 수 없다.
--   여기서 막는 것: 비로그인 접근, 그리고 권한 상승(자기 등급·역할·소속 바꾸기).
--   남는 것: 사장님은 다른 매장 손님 문서도 읽을 수 있다. 닫으려면 "이 손님이 방문한
--   매장" 링크가 필요하고 그건 데이터 모델 변경이라 별도 결정이다.
-- ------------------------------------------------------------
create policy "users_read_self" on public.users for select to authenticated
  using (id = auth.uid());
create policy "users_read_by_store" on public.users for select to authenticated
  using (public.my_role() in ('owner','staff'));

-- 사장은 직원 등급·손님 정보를 관리한다.
create policy "users_owner_write" on public.users for insert to authenticated
  with check (public.my_role() = 'owner');
create policy "users_owner_update" on public.users for update to authenticated
  using (public.my_role() = 'owner')
  with check (public.my_role() = 'owner');
create policy "users_owner_delete" on public.users for delete to authenticated
  using (public.my_role() = 'owner');

-- 본인 문서 — 프로필은 자유롭게 고칠 수 있다.
-- "역할·등급·소속은 못 바꾼다"는 정책이 아니라 **트리거**로 막는다.
-- 정책의 with check 안에서 users 를 다시 조회하면 users 자신의 RLS 를 재진입하게 되고,
-- 그건 재귀·미묘한 스냅샷 문제를 부른다. 트리거는 OLD/NEW 를 직접 비교할 수 있어
-- 의도가 그대로 드러나고 재진입도 없다.
-- 가입 직후 본인 프로필 행 생성 (auth.users 가 먼저 생기고 public.users 가 따라온다).
-- role 은 여기서 본인이 정한다 — 가입 화면에서 손님/사장님/직원을 고르는 구조라 어쩔 수 없다.
-- 다만 한 번 정해진 뒤에는 위 트리거가 변경을 막는다.
create policy "users_self_insert" on public.users for insert to authenticated
  with check (id = auth.uid());
create policy "users_self_update" on public.users for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

create or replace function public.guard_user_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- 본인이 본인 문서를 고치는 경우에만 검사한다.
  -- (사장이 직원 등급을 올리는 것과 서버(service_role, auth.uid() = null)는 통과)
  if auth.uid() is null or auth.uid() <> new.id then
    return new;
  end if;

  -- ⚠️ 생성 컬럼(new."staffLevel" 등)을 보면 안 된다. 생성 컬럼은 BEFORE 트리거가
  --    끝난 **뒤에** 계산되므로 여기서는 아직 옛 값이거나 비어 있다.
  --    원본인 data 를 직접 비교해야 실제로 막힌다.
  if new.role is distinct from old.role
     or new.data ->> 'staffLevel'      is distinct from old.data ->> 'staffLevel'
     or new.data ->> 'employerStatus'  is distinct from old.data ->> 'employerStatus'
     or new.data ->> 'employerStoreId' is distinct from old.data ->> 'employerStoreId'
     or new.data ->  'extraPerms'      is distinct from old.data ->  'extraPerms'
  then
    raise exception '권한 필드는 본인이 바꿀 수 없습니다 (role/staffLevel/employer*/extraPerms)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_user_privileges() from public, anon, authenticated;

drop trigger if exists users_guard_privileges on public.users;
create trigger users_guard_privileges before update on public.users
  for each row execute function public.guard_user_privileges();

-- app_state — 읽기는 로그인 사용자, 쓰기는 사장만.
create policy "app_state_read" on public.app_state for select to authenticated using (true);
create policy "app_state_write" on public.app_state for all to authenticated
  using (public.my_role() = 'owner') with check (public.my_role() = 'owner');

-- ------------------------------------------------------------
-- 서버 전용 3종 — 정책을 하나도 만들지 않는다.
--   RLS 가 켜져 있고 정책이 없으면 authenticated 는 아무것도 못 한다.
--   service_role 은 RLS 를 우회하므로 서버만 접근한다. (force row level security 를
--   걸었지만 service_role 의 BYPASSRLS 속성은 그대로 유효하다.)
-- ------------------------------------------------------------
-- store_secrets / pairing_codes / merchant_map : 정책 없음 = 클라이언트 접근 0
