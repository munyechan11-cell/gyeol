-- ============================================================
-- 손님 흐름 복구 · 직원 승인 복구 · 사장님 간 격리 · 마스터 비밀번호 격리
--
-- 이전을 끝낸 뒤 실제 DB 에 손님·직원·사장 세션으로 하나씩 찔러 본 결과다.
-- (probe 는 supabase/tests/rls.sql 에 그대로 옮겨 두었다.)
--
--   1) 사장이 직원을 승인하면 42501.        ← 1200 이 self-only 게이트를 지웠다
--   2) 직원이 매장에 소속 신청하면 42501.     ← 같은 원인
--   3) 손님이 사장님 users 행을 못 읽는다.     ← QR 진입·매장 화면이 영원히 로딩
--   4) 손님 기기의 방문 기록·테이블 점유가 42501. ← visits/tables 정책이 매장 전용
--   5) 손님이 app_state 의 마스터 비밀번호를 읽는다. ← 그 값으로 아무 계정이나 재설정
--   6) 사장 A 가 사장 B 의 행을 덮어쓰고 지운다(→ 매장 전체 cascade 삭제).
--   7) 미승인 직원이 전 매장 손님·사장 행을 다 읽는다.
--
-- 고치는 원칙:
--   · 손님이 **써야 하는** 것은 정책을 여는 대신 **함수(record_visit)** 가 대신 쓴다.
--     정책을 열면 손님이 자기 쿠폰·적립금을 마음대로 만든다.
--   · 손님이 **바꿔야 하는** 것(테이블 점유·결제 요청)은 정책은 열되 **트리거로
--     바꿀 수 있는 필드를 못 박는다.** 테이블 위치나 결제 완료를 손님이 쓸 수 없다.
--   · 손님이 **읽어야 하는** 사장님 정보는 **뷰(stores)** 로 비밀 필드를 걷어내고 준다.
-- ============================================================


-- ── 1. 권한 필드 트리거 — self-only 복원 + 신청/철회 허용 ─────────────
--
-- 000200 의 원본은 "본인이 본인 행을 고칠 때만 검사"였다. 1200 이 data.role 검사를
-- 얹으면서 그 게이트를 통째로 지워, 사장이 직원 employerStatus 를 바꾸는 것까지
-- 막혔다. 게이트를 되살리되, 원본에도 없던 두 가지를 정한다:
--   · 직원 본인은 employerStoreId 를 정하며 **pending** 으로만 갈 수 있다(신청).
--     null 로 돌리는 것도 된다(철회). approved 는 사장만.
--   · 적립금(rewardBalance)은 본인이 못 바꾼다. 손님 화면이 자기 행을 자유롭게
--     고칠 수 있으니, 그대로 두면 적립금을 원하는 만큼 써 넣을 수 있다.
--     적립은 record_visit(아래) 이 한다. 그 함수는 gyeol.trusted 를 켜고 지나간다.
create or replace function public.guard_user_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_self boolean := auth.uid() is not null and auth.uid() = new.id;
begin
  -- data.role 은 진짜 role 을 따른다. 어긋나면 화면만 사장이 된다.
  if new.data ? 'role' and new.data ->> 'role' is distinct from new.role then
    if auth.uid() is null then
      new.data := jsonb_set(new.data, '{role}', to_jsonb(new.role), true);
    else
      raise exception '권한 필드는 본인이 바꿀 수 없습니다 (role)' using errcode = '42501';
    end if;
  end if;

  -- 서버(service_role)와 신뢰 함수는 지나간다.
  if auth.uid() is null or current_setting('gyeol.trusted', true) = '1' then
    return new;
  end if;

  -- 클라이언트는 누구의 role 컬럼도 못 바꾼다(save_doc 은 update 에 role 을 안 넣는다).
  if new.role is distinct from old.role then
    raise exception '권한 필드는 본인이 바꿀 수 없습니다 (role)' using errcode = '42501';
  end if;

  if v_self then
    if new.data ->> 'staffLevel'   is distinct from old.data ->> 'staffLevel'
       or new.data -> 'extraPerms'  is distinct from old.data -> 'extraPerms'
       or new.data -> 'rewardBalance' is distinct from old.data -> 'rewardBalance'
    then
      raise exception '권한 필드는 본인이 바꿀 수 없습니다 (staffLevel/extraPerms/rewardBalance)'
        using errcode = '42501';
    end if;
    if (new.data ->> 'employerStoreId' is distinct from old.data ->> 'employerStoreId'
        or new.data ->> 'employerStatus' is distinct from old.data ->> 'employerStatus')
       and coalesce(new.data ->> 'employerStatus', '') not in ('', 'pending')
    then
      raise exception '소속은 신청(pending)만 할 수 있습니다. 승인은 사장님이 합니다.'
        using errcode = '42501';
    end if;
  else
    -- 남의 행(사장이 자기 직원·손님을 고치는 경우). 어느 행을 고칠 수 있는지는
    -- users_owner_update 정책이 정한다. 여기서는 직원을 **다른 매장으로** 옮기지 못하게만.
    if new.data ->> 'employerStoreId' is distinct from old.data ->> 'employerStoreId'
       and new.data ->> 'employerStoreId' is not null
       and new.data ->> 'employerStoreId' <> auth.uid()::text
    then
      raise exception '직원을 다른 매장 소속으로 바꿀 수 없습니다' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;


-- ── 2. users 정책 — 읽기 범위와 사장 쓰기 범위 ──────────────────────
drop policy if exists "users_read_by_store" on public.users;
drop policy if exists "users_owner_write"   on public.users;
drop policy if exists "users_owner_update"  on public.users;
drop policy if exists "users_owner_delete"  on public.users;

-- 매장 사람: 사장과 승인 직원은 **그 매장의** 사장 행과 직원 행을 본다.
create policy "users_read_store_members" on public.users for select to authenticated
  using (
    public.my_store_id() is not null
    and (id = public.my_store_id() or "employerStoreId" = public.my_store_id())
  );

-- 손님 행: 매장 사람은 손님 행을 본다. 손님에게 storeId 가 없어 매장으로 못 나눈다 —
-- 이건 알고 남기는 경계다(docs/ARCHITECTURE.md). 미승인 직원·손님은 여기 못 든다.
create policy "users_read_customers" on public.users for select to authenticated
  using (public.my_store_id() is not null and role = 'customer');

-- 사장은 **자기 매장 직원**과 **손님** 행만 고친다. 다른 사장 행은 못 건드린다.
-- with check 의 employerStoreId 가 null 인 경우: 직원 소속 해제(removeStaffMembership).
create policy "users_owner_update" on public.users for update to authenticated
  using (
    public.my_role() = 'owner'
    and id <> (select auth.uid())
    and role <> 'owner'
    and (role = 'customer' or data ->> 'employerStoreId' = (select auth.uid())::text)
  )
  with check (
    public.my_role() = 'owner'
    and id <> (select auth.uid())
    and role <> 'owner'
    and (role = 'customer'
         or data ->> 'employerStoreId' is null
         or data ->> 'employerStoreId' = (select auth.uid())::text)
  );

-- 삭제는 클라이언트에서 하지 않는다. 마스터 삭제·탈퇴 모두 서버가 auth.users 를
-- 지우고, users.id 의 외래키가 cascade 로 나머지를 정리한다. (클라이언트가 users 행만
-- 지우면 auth 사용자가 남아, 다시 로그인하면 빈 계정으로 되살아난다.)


-- ── 3. stores 뷰 — 손님·미승인 직원이 보는 매장 정보 ─────────────────
--
-- 손님 화면은 QR 의 storeId 로 사장님 행을 찾아 매장 이름·테마·보상 설정을 읽는다.
-- 그 행에는 POS 키·알림 토큰·문자 발송 키처럼 손님이 볼 이유가 없는 것도 있다.
-- 뷰가 그것들을 걷어내고 준다. 실시간 구독은 없다(뷰는 채널에 안 실린다) —
-- 매장 설정은 자주 안 바뀌고, 앱은 매장 진입 시 다시 읽는다.
create or replace view public.stores
with (security_invoker = off) as
select
  u.id,
  u.role,
  (u.data
     - 'posApiKey' - 'aligoKey' - 'aligoUserId' - 'aligoSender' - 'smsGatewayUrl'
     - 'fcmTokens' - 'pushPrefs' - 'memo' - 'socialIds' - 'googleId' - 'kakaoId'
     - 'linkedProviders' - 'hourlyWage' - 'tossPlace' - 'foodtechStoreCode'
     - 'printBridgeHeartbeatAt' - 'privacyAgreedAt' - 'birthYear' - 'birthday' - 'gender'
  ) #- '{storeConfig,publishing}' #- '{storeConfig,marketingAgent}' as data
from public.users u
where u.role = 'owner' and coalesce(u.data ->> 'status', 'active') <> 'deleted';

revoke all on public.stores from public, anon;
grant select on public.stores to authenticated;
comment on view public.stores is '손님·미승인 직원용 매장 목록. 사장님 행에서 비밀·개인 필드를 걷어낸 것. security_invoker=off 가 의도다 — 손님은 users 를 직접 못 읽는다.';


-- ── 4. 손님이 읽는 것 — 자기 방문·메시지·등급 지정 ─────────────────
drop policy if exists "visits_read" on public.visits;
create policy "visits_read" on public.visits for select to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));

drop policy if exists "communications_read" on public.communications;
create policy "communications_read" on public.communications for select to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));
-- 손님이 사장님에게 보내는 메시지. 발신자 표시를 손님으로 못 박는다.
create policy "communications_customer_insert" on public.communications for insert to authenticated
  with check ("customerId" = (select auth.uid()) and data ->> 'senderRole' = 'customer');

drop policy if exists "tier_overrides_read" on public.tier_overrides;
create policy "tier_overrides_read" on public.tier_overrides for select to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));

-- 리뷰: 손님이 결제 때 남긴다. 자기 이름으로, review 종류만.
create policy "photos_customer_review" on public.photos for insert to authenticated
  with check (data ->> 'customerId' = (select auth.uid())::text and data ->> 'type' = 'review');


-- ── 5. 손님이 바꾸는 것 — 테이블 점유, 결제 요청 ────────────────────
--
-- 정책은 열되 트리거가 필드를 못 박는다. 정책의 with check 는 OLD 를 볼 수 없어
-- "무엇이 바뀌었는가"를 말할 수 없다. 트리거는 볼 수 있다.

-- 테이블: 점유 관련 필드만. 위치·좌석·구역·번호는 매장이 정한다.
create or replace function public.guard_table_customer_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  k text[] := array['status','currentCustomerId','occupantIds','currentCustomerName','partySize','sessionStartTime'];
begin
  if auth.uid() is null or current_setting('gyeol.trusted', true) = '1' then return new; end if;
  if public.my_role() <> 'customer' then return new; end if;
  if (new.data - k) is distinct from (old.data - k) then
    raise exception '손님은 테이블 점유 상태만 바꿀 수 있습니다' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_table_customer_update() from public, anon, authenticated;
drop trigger if exists tables_guard_customer on public.tables;
create trigger tables_guard_customer before update on public.tables
  for each row execute function public.guard_table_customer_update();

drop policy if exists "tables_update" on public.tables;
create policy "tables_update" on public.tables for update to authenticated
  using ("storeId" = public.my_store_id() or public.my_role() = 'customer')
  with check ("storeId" = public.my_store_id() or public.my_role() = 'customer');

-- 주문: 손님은 자기 주문의 "결제 요청"과 "취소"만. 결제 완료는 서버(카드)나 사장(현금)이 쓴다.
create or replace function public.guard_order_customer_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or current_setting('gyeol.trusted', true) = '1' then return new; end if;
  if public.my_role() <> 'customer' then return new; end if;

  if (new.data - 'paymentStatus' - 'status') is distinct from (old.data - 'paymentStatus' - 'status') then
    raise exception '손님은 주문의 결제 요청·취소만 할 수 있습니다' using errcode = '42501';
  end if;
  if new.data ->> 'paymentStatus' is distinct from old.data ->> 'paymentStatus'
     and not (coalesce(old.data ->> 'paymentStatus', 'unpaid') = 'unpaid'
              and new.data ->> 'paymentStatus' = 'requested')
  then
    raise exception '손님은 결제 요청만 할 수 있습니다' using errcode = '42501';
  end if;
  if new.data ->> 'status' is distinct from old.data ->> 'status'
     and not (old.data ->> 'status' = 'pending' and new.data ->> 'status' = 'cancelled')
  then
    raise exception '손님은 접수 전 주문만 취소할 수 있습니다' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_order_customer_update() from public, anon, authenticated;
drop trigger if exists orders_guard_customer on public.orders;
create trigger orders_guard_customer before update on public.orders
  for each row execute function public.guard_order_customer_update();

drop policy if exists "orders_update" on public.orders;
create policy "orders_update" on public.orders for update to authenticated
  using ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()))
  with check ("storeId" = public.my_store_id() or "customerId" = (select auth.uid()));


-- ── 6. record_visit — 손님 방문 기록·적립·등급 쿠폰·테이블 점유를 한 번에 ──
--
-- 예전엔 손님 기기가 이 넷을 각각 썼다. 정책으로 열면 손님이 자기 쿠폰과 적립금을
-- 만들 수 있으므로, 함수가 대신 쓴다. 규칙은 클라이언트에 있던 것 그대로다:
--   · 방문은 하루(서울) 한 번.
--   · 적립: stamp 면 1, point 면 floor(금액 × pointRate), 금액 없으면 10,000 원 기준.
--   · 최근 30 일 방문 일수로 등급 쿠폰 — 12 VIP · 8 다이아 · 6 골드 · 4 실버 · 2 브론즈.
--     같은 종류를 이미 받았으면 안 준다. 가장 높은 하나만.
--   · 테이블: 있으면 점유 표시, 없으면(사장이 인쇄한 QR 번호) 만든다.
create or replace function public.record_visit(
  p_store_id uuid,
  p_table_number int,
  p_amount numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_customer uuid := auth.uid();
  v_owner    public.users%rowtype;
  v_cfg      jsonb;
  v_today    text := to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD');
  v_new      boolean := false;
  v_delta    int := 0;
  v_days     int := 0;
  v_tier     text := null;
  v_key      text := null;
  v_default  text := null;
  v_custom   text := null;
  v_issued   text := null;
  v_table_id text;
  v_table    public.tables%rowtype;
  v_status   text;
  v_num      int := p_table_number;
  v_col      int; v_row int;
begin
  if v_customer is null then
    raise exception '로그인이 필요합니다' using errcode = '42501';
  end if;
  if (select role from public.users where id = v_customer) is distinct from 'customer' then
    raise exception '손님 계정만 방문을 기록합니다' using errcode = '42501';
  end if;
  if v_num is null or v_num <= 0 then
    raise exception '테이블 번호가 잘못됐습니다' using errcode = '22023';
  end if;
  select * into v_owner from public.users where id = p_store_id and role = 'owner';
  if not found then
    raise exception '매장을 찾을 수 없습니다' using errcode = 'P0002';
  end if;
  v_cfg := coalesce(v_owner.data -> 'storeConfig', '{}'::jsonb);

  -- 이 함수 안의 users/tables 갱신은 트리거가 믿고 지나가게 한다(트랜잭션 한정).
  perform set_config('gyeol.trusted', '1', true);

  -- 1) 방문 — 오늘 것이 없을 때만
  if not exists (
    select 1 from public.visits
     where "customerId" = v_customer and "storeId" = p_store_id
       and coalesce(data ->> 'day', to_char((data ->> 'date')::timestamptz at time zone 'Asia/Seoul', 'YYYY-MM-DD')) = v_today
  ) then
    v_new := true;
    insert into public.visits (id, data) values (
      gen_random_uuid()::text,
      jsonb_strip_nulls(jsonb_build_object(
        'customerId', v_customer::text, 'storeId', p_store_id::text,
        'tableNumber', v_num, 'date', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'day', v_today, 'totalAmount', p_amount
      ))
    );

    -- 2) 적립
    if v_cfg ->> 'rewardType' = 'stamp' then
      v_delta := 1;
    elsif v_cfg ->> 'rewardType' = 'point' then
      v_delta := floor(coalesce(p_amount, 10000) * coalesce((v_cfg ->> 'pointRate')::numeric, 0.05));
    end if;
    if v_delta > 0 then
      update public.users
         set data = jsonb_set(data, '{rewardBalance}',
                      to_jsonb(coalesce((data ->> 'rewardBalance')::numeric, 0) + v_delta), true)
       where id = v_customer;
    end if;

    -- 3) 등급 쿠폰 — 최근 30 일 방문 일수
    select count(distinct coalesce(data ->> 'day', left(data ->> 'date', 10))) into v_days
      from public.visits
     where "customerId" = v_customer and "storeId" = p_store_id
       and (data ->> 'date')::timestamptz >= now() - interval '30 days';

    if    v_days >= 12 then v_tier := 'VIP';   v_key := 'coupon.reward.vip';     v_default := '사장님 특별 서비스';
    elsif v_days >= 8  then v_tier := '다이아'; v_key := 'coupon.reward.diamond'; v_default := '메인 메뉴 할인 쿠폰';
    elsif v_days >= 6  then v_tier := '골드';   v_key := 'coupon.reward.gold';    v_default := '사이드 메뉴 무료권';
    elsif v_days >= 4  then v_tier := '실버';   v_key := 'coupon.reward.silver';  v_default := '음료 무료 쿠폰';
    elsif v_days >= 2  then v_tier := '브론즈'; v_key := 'coupon.reward.bronze';  v_default := '재방문 스탬프 추가 적립';
    end if;

    if v_tier is not null and not exists (
      select 1 from public.coupons
       where "customerId" = v_customer and "storeId" = p_store_id and data ->> 'type' = v_tier
    ) then
      v_custom := v_owner.data -> 'tierRewards' ->> v_tier;
      insert into public.coupons (id, data) values (
        gen_random_uuid()::text,
        jsonb_strip_nulls(jsonb_build_object(
          'customerId', v_customer::text, 'storeId', p_store_id::text,
          'type', v_tier,
          'description', coalesce(v_custom, v_default),
          'descKey', case when v_custom is null then v_key else null end,
          'status', 'available',
          'issuedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        ))
      );
      v_issued := v_tier;
    end if;
  end if;

  -- 4) 테이블 점유
  v_table_id := p_store_id::text || '_' || v_num;
  select * into v_table from public.tables where id = v_table_id;
  if found then
    v_status := v_table.data ->> 'status';
    if v_status not in ('dining', 'paid', 'cleaning', 'dirty') or v_status is null then
      v_status := 'occupied';
    end if;
    update public.tables
       set data = data || jsonb_build_object(
             'status', v_status,
             'currentCustomerId', coalesce(nullif(data ->> 'currentCustomerId', ''), v_customer::text),
             'currentCustomerName', coalesce(nullif(data ->> 'currentCustomerName', ''), (select u.data ->> 'name' from public.users u where u.id = v_customer)),
             'occupantIds', (
               select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                 from jsonb_array_elements_text(coalesce(data -> 'occupantIds', '[]'::jsonb) || to_jsonb(array[v_customer::text])) x
             ),
             'sessionStartTime', coalesce(data ->> 'sessionStartTime', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
           )
     where id = v_table_id;
  else
    v_col := ((v_num - 1) % 5 + 5) % 5;
    v_row := greatest(0, (v_num - 1) / 5);
    insert into public.tables (id, data) values (
      v_table_id,
      jsonb_build_object(
        'id', v_table_id, 'number', v_num, 'storeId', p_store_id::text,
        'type', 'table', 'shape', 'square', 'seats', 4, 'width', 90, 'height', 90,
        'x', v_col * 120 + 40, 'y', v_row * 120 + 40,
        'status', 'occupied',
        'currentCustomerId', v_customer::text,
        'currentCustomerName', (select data ->> 'name' from public.users where id = v_customer),
        'occupantIds', to_jsonb(array[v_customer::text]),
        'sessionStartTime', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    );
  end if;

  return jsonb_build_object('newVisit', v_new, 'rewardDelta', v_delta, 'couponIssued', v_issued);
end;
$$;
revoke all on function public.record_visit(uuid, int, numeric) from public, anon;
grant execute on function public.record_visit(uuid, int, numeric) to authenticated;
comment on function public.record_visit is '손님 QR 진입 — 방문(하루 1회)·적립·등급 쿠폰·테이블 점유를 서버 규칙으로 한 번에. 손님 기기가 직접 쓰지 않는다.';


-- ── 7. 마스터 비밀번호 — 클라이언트가 못 읽는 곳으로 ─────────────────
--
-- app_state 는 로그인한 누구나 읽는다(테마 같은 공용 설정). 마스터 비밀번호가
-- 거기 있으면 손님도 읽고, 그 값으로 서버 재설정 API 를 불러 아무 계정이나 연다.
-- 서버 전용 테이블로 옮긴다. 정책 없음 = service_role 만.
create table if not exists public.app_secrets (
  id          text primary key,
  data        jsonb not null default '{}'::jsonb,
  "updatedAt" timestamptz not null default now()
);
alter table public.app_secrets enable row level security;
alter table public.app_secrets force row level security;
revoke all on public.app_secrets from public, anon, authenticated;

insert into public.app_secrets (id, data)
select 'master', jsonb_build_object('password', data ->> 'masterPassword')
  from public.app_state
 where id = 'settings' and coalesce(data ->> 'masterPassword', '') <> ''
on conflict (id) do nothing;

update public.app_state set data = data - 'masterPassword'
 where id = 'settings' and data ? 'masterPassword';
