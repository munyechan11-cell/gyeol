-- ============================================================
-- RLS 검증 — 매장 격리 · 권한 상승 차단 · 손님 흐름 · 직원 온보딩.
--
-- Firestore 시절에는 firestore.rules.test.ts 46건이 이 역할을 했다. 규칙이
-- 사라졌으니 검사도 같이 사라지면 안전망만 줄어든다. 같은 질문을 여기서 다시 묻는다.
--
-- 실행:
--   supabase db execute --file supabase/tests/rls.sql   (또는 SQL 편집기에 붙여넣기)
-- 하나라도 어긋나면 예외로 멈춘다. 끝까지 가면 통과다. 전부 rollback 이라 흔적이 없다.
--
-- 왜 SQL 인가 — 판정 주체가 Postgres 다. 앱을 거쳐 확인하면 앱의 실수까지 섞여
-- "정책이 막았는지 앱이 안 보냈는지"를 구분할 수 없다. 여기서는 정책만 본다.
--
-- ⚠️ 부정 단언("못 본다")만 있으면 정책을 다 꺼도 통과한다 — 빈 테이블에 0건은
--    언제나 참이다. 그래서 **가릴 자료를 실제로 넣고**, 되어야 하는 일(승인·방문·
--    결제 요청)은 **긍정 단언**으로 함께 묻는다. 1200 마이그레이션이 사장의 직원
--    승인을 막았을 때 이 파일이 통과했던 이유가 바로 긍정 단언의 부재였다.
-- ============================================================

begin;

-- ── 준비: 두 매장, 직원 하나, 손님 하나 ──────────────────────
create temp table ids on commit drop as
select 'aaaaaaaa-0000-0000-0000-000000000001'::uuid as store_a,
       'aaaaaaaa-0000-0000-0000-000000000002'::uuid as store_b,
       'aaaaaaaa-0000-0000-0000-000000000003'::uuid as cust,
       'aaaaaaaa-0000-0000-0000-000000000004'::uuid as staff;

do $$
declare a uuid; b uuid; c uuid; s uuid;
begin
  select store_a, store_b, cust, staff into a, b, c, s from ids;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x, '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
         'rlstest-' || x || '@identity.gyeol.app', now(), now()
    from unnest(array[a,b,c,s]) x
  on conflict (id) do nothing;

  perform public.save_doc('users', a::text, jsonb_build_object('role','owner','name','가게A','restaurantName','A',
    'posApiKey','비밀', 'storeConfig', jsonb_build_object('rewardType','stamp')));
  perform public.save_doc('users', b::text, jsonb_build_object('role','owner','name','가게B'));
  perform public.save_doc('users', c::text, jsonb_build_object('role','customer','name','손님'));
  perform public.save_doc('users', s::text, jsonb_build_object('role','staff','name','직원'));

  -- 가릴 자료를 실제로 넣어 둔다.
  perform public.save_doc('menus',  'm_a', jsonb_build_object('storeId', a::text, 'name','A메뉴'));
  perform public.save_doc('menus',  'm_b', jsonb_build_object('storeId', b::text, 'name','B메뉴'));
  perform public.save_doc('visits', 'v_b', jsonb_build_object('storeId', b::text, 'customerId', c::text, 'date','2026-09-01T00:00:00.000Z'));
  perform public.save_doc('visits', 'v_x', jsonb_build_object('storeId', b::text, 'customerId', '', 'date','2026-09-01T00:00:00.000Z'));
  perform public.save_doc('orders', 'o_b', jsonb_build_object('storeId', b::text, 'customerId', c::text, 'totalAmount', 5000, 'status','pending', 'paymentStatus','unpaid'));
  perform public.save_doc('orders', 'o_a', jsonb_build_object('storeId', a::text, 'customerId', '', 'totalAmount', 9000));
  perform public.save_doc('coupons','k_c', jsonb_build_object('storeId', b::text, 'customerId', c::text, 'status','available'));
  perform public.save_doc('coupons','k_x', jsonb_build_object('storeId', b::text, 'customerId', '', 'status','available'));
  perform public.save_doc('tables', a::text || '_1', jsonb_build_object('storeId', a::text, 'number', 1, 'status','available', 'x', 40));
  insert into public.store_secrets ("storeId", data) values (a, '{"tossSecretKey":"확인용"}') on conflict ("storeId") do nothing;
  insert into public.app_secrets (id, data) values ('master', '{"password":"확인용"}') on conflict (id) do nothing;
end $$;

-- 요청자를 바꿔 끼우는 도구. 정책은 auth.uid() 를 보므로 claim 만 바꾸면 된다.
create or replace function pg_temp.act_as(p uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p::text, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.expect(p_ok boolean, p_what text) returns void
language plpgsql as $$
begin
  if not p_ok then
    raise exception 'RLS 검증 실패: %', p_what;
  end if;
  raise notice 'ok — %', p_what;
end $$;

-- "이 저장은 42501 로 끝나야 한다"
create or replace function pg_temp.expect_denied(p_table text, p_id text, p_patch jsonb, p_what text) returns void
language plpgsql as $$
begin
  begin
    perform public.save_doc(p_table, p_id, p_patch);
  exception when insufficient_privilege then
    perform pg_temp.expect(true, p_what);
    return;
  end;
  perform pg_temp.expect(false, p_what);
end $$;

-- ── 검증 ──────────────────────────────────────────────────
do $$
declare a uuid; b uuid; c uuid; s uuid; n int; d text; r jsonb;
begin
  select store_a, store_b, cust, staff into a, b, c, s from ids;
  set local role authenticated;

  -- ═══ 1. 매장 격리 ═══
  perform pg_temp.act_as(a);
  select count(*) into n from public.visits;
  perform pg_temp.expect(n = 0, '사장 A 는 매장 B 의 방문 기록을 못 본다');
  select count(*) into n from public.users where id = b;
  perform pg_temp.expect(n = 0, '사장 A 는 사장 B 의 계정 행을 못 본다');
  perform pg_temp.expect_denied('menus', 'm_x', jsonb_build_object('storeId', b::text, 'name','침입'),
    '사장 A 가 매장 B 메뉴를 만들지 못한다');
  perform pg_temp.expect_denied('users', b::text, jsonb_build_object('name','침입자가 바꿈'),
    '사장 A 가 사장 B 의 계정을 덮어쓰지 못한다');
  perform public.delete_doc('menus', 'm_b');
  perform pg_temp.act_as(b);
  select count(*) into n from public.menus where id = 'm_b';
  perform pg_temp.expect(n = 1, '사장 A 의 삭제 시도 뒤에도 매장 B 메뉴가 남아 있다');

  -- ═══ 2. 직원 온보딩 — 신청은 본인이, 승인은 사장이 ═══
  perform pg_temp.act_as(s);
  select count(*) into n from public.users;
  perform pg_temp.expect(n = 1, '미승인 직원에게는 자기 계정만 보인다');
  select count(*) into n from public.stores;
  perform pg_temp.expect(n = 2, '미승인 직원도 매장 목록(stores 뷰)은 본다 — 소속 신청에 필요하다');
  perform public.save_doc('users', s::text, jsonb_build_object('employerStoreId', a::text, 'employerStatus','pending'));
  perform pg_temp.expect(true, '직원이 매장 A 에 소속을 신청한다(pending)');
  perform pg_temp.expect_denied('users', s::text, jsonb_build_object('employerStatus','approved'),
    '직원이 스스로 승인되지 못한다');

  perform pg_temp.act_as(b);
  perform pg_temp.expect_denied('users', s::text, jsonb_build_object('employerStatus','approved'),
    '사장 B 는 매장 A 에 신청한 직원을 승인하지 못한다');

  perform pg_temp.act_as(a);
  perform public.save_doc('users', s::text, jsonb_build_object('employerStatus','approved', 'staffLevel', 2));
  select count(*) into n from public.users where id = s and "employerStatus" = 'approved' and "staffLevel" = 2;
  perform pg_temp.expect(n = 1, '사장 A 가 자기 직원을 승인하고 등급을 준다');

  perform pg_temp.act_as(b);
  perform pg_temp.expect_denied('users', s::text, jsonb_build_object('employerStoreId', b::text),
    '사장 B 가 매장 A 직원을 빼앗지 못한다');

  perform pg_temp.act_as(s);
  select count(*) into n from public.users where id = a;
  perform pg_temp.expect(n = 1, '승인된 직원은 소속 매장 사장의 계정 행을 본다');
  select count(*) into n from public.menus where id = 'm_a';
  perform pg_temp.expect(n = 1, '승인된 직원은 소속 매장 메뉴를 본다');

  -- ═══ 3. 손님 — 읽기 범위 ═══
  perform pg_temp.act_as(c);
  select count(*) into n from public.users;
  perform pg_temp.expect(n = 1, '손님에게는 자기 계정만 보인다');
  select count(*) into n from public.stores where id = a and data ->> 'restaurantName' = 'A';
  perform pg_temp.expect(n = 1, '손님은 stores 뷰로 매장 이름·설정을 읽는다 (QR 진입에 필요)');
  select count(*) into n from public.stores where data ? 'posApiKey';
  perform pg_temp.expect(n = 0, 'stores 뷰에는 POS 키 같은 비밀 필드가 없다');
  select count(*) into n from public.visits;
  perform pg_temp.expect(n = 1, '손님에게는 자기 방문 1건만 보인다 (전체 2건 중)');
  select count(*) into n from public.orders;
  perform pg_temp.expect(n = 1, '손님에게는 자기 주문 1건만 보인다 (전체 2건 중)');
  select count(*) into n from public.coupons;
  perform pg_temp.expect(n = 1, '손님에게는 자기 쿠폰 1건만 보인다 (전체 2건 중)');
  begin
    select count(*) into n from public.app_secrets;
    perform pg_temp.expect(false, '손님은 app_secrets(마스터 비밀번호)를 읽지 못한다');
  exception when insufficient_privilege then
    perform pg_temp.expect(true, '손님은 app_secrets(마스터 비밀번호)를 읽지 못한다');
  end;

  -- ═══ 4. 손님 — 권한 상승 차단 ═══
  perform pg_temp.expect_denied('users', c::text, jsonb_build_object('employerStoreId', a::text, 'employerStatus','approved'),
    '손님이 스스로 승인된 직원이 되지 못한다');
  perform pg_temp.expect_denied('users', c::text, jsonb_build_object('role','owner'),
    '손님이 스스로 사장이 되지 못한다 (data.role 포함)');
  perform pg_temp.expect_denied('users', c::text, jsonb_build_object('rewardBalance', 99999),
    '손님이 자기 적립금을 써 넣지 못한다');
  perform pg_temp.expect_denied('coupons', 'k_new', jsonb_build_object('storeId', a::text, 'customerId', c::text, 'status','available', 'amount', 50000),
    '손님이 자기 쿠폰을 만들지 못한다');
  perform public.save_doc('users', c::text, jsonb_build_object('memo','메모'));
  perform pg_temp.expect(true, '권한 필드를 건드리지 않는 평범한 프로필 저장은 통과한다');

  -- ═══ 5. 손님 — 되어야 하는 일 ═══
  r := public.record_visit(a, 1, null);
  perform pg_temp.expect((r ->> 'newVisit')::boolean and (r ->> 'rewardDelta')::int = 1,
    '손님 QR 진입(record_visit) — 방문 기록 + 스탬프 1 적립');
  select data ->> 'rewardBalance' into d from public.users where id = c;
  perform pg_temp.expect(d = '1', '적립금이 서버 규칙으로 올라갔다');
  select count(*) into n from public.tables where id = a::text || '_1' and data ->> 'currentCustomerId' = c::text;
  perform pg_temp.expect(n = 1, '테이블 1 이 손님 점유로 표시됐다');
  r := public.record_visit(a, 1, null);
  perform pg_temp.expect(not (r ->> 'newVisit')::boolean, '같은 날 두 번째 진입은 방문으로 세지 않는다');

  perform public.save_doc('tables', a::text || '_1', jsonb_build_object('status','dirty', 'currentCustomerId', null));
  perform pg_temp.expect(true, '손님이 자리를 비운다 (점유 필드만 바꾼다)');
  perform pg_temp.expect_denied('tables', a::text || '_1', jsonb_build_object('x', 999),
    '손님이 테이블 위치를 옮기지 못한다');

  perform public.save_doc('orders', 'o_b', jsonb_build_object('paymentStatus','requested'));
  perform pg_temp.expect(true, '손님이 자기 주문의 결제를 요청한다');
  perform pg_temp.expect_denied('orders', 'o_b', jsonb_build_object('paymentStatus','paid'),
    '손님이 결제 완료를 스스로 쓰지 못한다');
  perform pg_temp.expect_denied('orders', 'o_a', jsonb_build_object('paymentStatus','requested'),
    '손님이 남의 주문을 건드리지 못한다');

  perform public.save_doc('photos', 'p_review', jsonb_build_object('storeId', a::text, 'customerId', c::text, 'type','review', 'rating', 5));
  perform pg_temp.expect(true, '손님이 리뷰를 남긴다');
  perform pg_temp.expect_denied('photos', 'p_menu', jsonb_build_object('storeId', a::text, 'customerId', c::text, 'type','menu'),
    '손님이 매장 메뉴 사진을 올리지 못한다');

  -- ═══ 6. 서버 전용 테이블 ═══
  perform pg_temp.act_as(a);
  select count(*) into n from public.store_secrets;
  perform pg_temp.expect(n = 0, '사장도 store_secrets 를 읽지 못한다');

  raise notice '── RLS 검증 전부 통과 ──';
end $$;

rollback;
