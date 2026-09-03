-- ============================================================
-- RLS 검증 — 매장 격리와 권한 상승 차단.
--
-- Firestore 시절에는 firestore.rules.test.ts 46건이 이 역할을 했다. 규칙이
-- 사라졌으니 검사도 같이 사라지면 안전망만 줄어든다. 같은 질문을 여기서 다시 묻는다.
--
-- 실행:
--   supabase db execute --file supabase/tests/rls.sql   (또는 SQL 편집기에 붙여넣기)
-- 하나라도 어긋나면 예외로 멈춘다. 끝까지 가면 통과다.
--
-- 왜 SQL 인가 — 판정 주체가 Postgres 다. 앱을 거쳐 확인하면 앱의 실수까지 섞여
-- "정책이 막았는지 앱이 안 보냈는지"를 구분할 수 없다. 여기서는 정책만 본다.
-- ============================================================

begin;

-- ── 준비: 두 매장과 손님 하나 ──────────────────────────────
create temp table ids on commit drop as
select 'aaaaaaaa-0000-0000-0000-000000000001'::uuid as store_a,
       'aaaaaaaa-0000-0000-0000-000000000002'::uuid as store_b,
       'aaaaaaaa-0000-0000-0000-000000000003'::uuid as cust;

do $$
declare a uuid; b uuid; c uuid;
begin
  select store_a, store_b, cust into a, b, c from ids;

  insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
  select x, '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
         'rlstest-' || x || '@identity.gyeol.app', now(), now()
    from unnest(array[a,b,c]) x
  on conflict (id) do nothing;

  perform public.save_doc('users', a::text, jsonb_build_object('role','owner','name','가게A'));
  perform public.save_doc('users', b::text, jsonb_build_object('role','owner','name','가게B'));
  perform public.save_doc('users', c::text, jsonb_build_object('role','customer','name','손님'));

  -- ⚠️ 가릴 자료를 **실제로 넣어 둔다.** 빈 테이블에 "0건 보인다"는 정책이 꺼져
  --    있어도 통과한다 — 그런 단언은 통과해도 아무것도 증명하지 못한다.
  perform public.save_doc('menus',  'm_a', jsonb_build_object('storeId', a::text, 'name','A메뉴'));
  perform public.save_doc('menus',  'm_b', jsonb_build_object('storeId', b::text, 'name','B메뉴'));
  perform public.save_doc('visits', 'v_b', jsonb_build_object('storeId', b::text, 'customerId', c::text, 'date','2026-09-01'));
  perform public.save_doc('orders', 'o_b', jsonb_build_object('storeId', b::text, 'customerId', c::text, 'totalAmount', 5000));
  -- 손님과 무관한 주문. "자기 것 1건만"이 진짜 걸러진 결과임을 보이려면 걸러질 게 있어야 한다.
  perform public.save_doc('orders', 'o_a', jsonb_build_object('storeId', a::text, 'customerId', '', 'totalAmount', 9000));
  perform public.save_doc('coupons','k_c', jsonb_build_object('storeId', b::text, 'customerId', c::text, 'status','available'));
  -- store_secrets 는 save_doc 화이트리스트 밖이다(그게 목적). 직접 넣는다.
  insert into public.store_secrets ("storeId", data)
  values (a, jsonb_build_object('tossSecretKey','확인용'))
  on conflict ("storeId") do nothing;
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

-- ── 검증 ──────────────────────────────────────────────────
do $$
declare a uuid; b uuid; c uuid; n int;
begin
  select store_a, store_b, cust into a, b, c from ids;
  set local role authenticated;

  -- 1) 매장 자료는 자기 것만 보인다.
  --    단, menus 는 예외로 **일부러 공개 읽기**다(menus_read using(true)).
  --    손님이 앉은 가게의 메뉴를 봐야 하는데 "지금 어느 가게에 있는가"를
  --    나타내는 연결이 없어서다. 그래서 메뉴가 아니라 주문·방문으로 격리를 확인한다.
  perform pg_temp.act_as(a);
  select count(*) into n from public.visits;
  perform pg_temp.expect(n = 0, '사장 A 는 매장 B 의 방문 기록을 못 본다');

  -- 2) 남의 매장 자료를 만들 수 없다.
  begin
    perform public.save_doc('menus', 'm_x', jsonb_build_object('storeId', b::text, 'name','침입'));
    perform pg_temp.expect(false, '사장 A 가 매장 B 메뉴를 만들지 못한다');
  exception when insufficient_privilege then
    perform pg_temp.expect(true, '사장 A 가 매장 B 메뉴를 만들지 못한다');
  end;

  -- 3) 남의 매장 자료를 지울 수 없다.
  perform public.delete_doc('menus', 'm_b');
  perform pg_temp.act_as(b);
  select count(*) into n from public.menus where id = 'm_b';
  perform pg_temp.expect(n = 1, '사장 A 의 삭제 시도 뒤에도 매장 B 메뉴가 남아 있다');

  -- 4) 손님은 매장 운영 자료를 못 본다. (메뉴는 위 이유로 제외)
  perform pg_temp.act_as(c);
  select count(*) into n from public.visits;
  perform pg_temp.expect(n = 0, '손님은 방문 기록 테이블을 훑지 못한다');
  select count(*) into n from public.orders;
  perform pg_temp.expect(n = 1, '손님에게는 자기 주문 1건만 보인다 (전체 2건 중)');
  select count(*) into n from public.coupons;
  perform pg_temp.expect(n = 1, '손님에게는 자기 쿠폰 1건만 보인다');
  select count(*) into n from public.users;
  perform pg_temp.expect(n = 1, '손님에게는 자기 계정만 보인다');

  -- 5) 스스로 등급을 올릴 수 없다.
  begin
    perform public.save_doc('users', c::text,
      jsonb_build_object('employerStoreId', a::text, 'employerStatus','approved'));
    perform pg_temp.expect(false, '손님이 스스로 승인된 직원이 되지 못한다');
  exception when insufficient_privilege then
    perform pg_temp.expect(true, '손님이 스스로 승인된 직원이 되지 못한다');
  end;

  -- 5-1) 손님이 스스로 사장이 되려는 시도.
  --      save_doc 은 data 만 쓰므로 진짜 role 컬럼은 애초에 안 바뀐다 — 권한은 안 오른다.
  --      그런데 앱은 행을 {...data, id} 로 읽으므로 data.role 만 바뀌어도 **화면은
  --      사장이 된다.** 데이터는 안 새지만 사장님 UI 가 열린다. 그것도 막는다.
  begin
    perform public.save_doc('users', c::text, jsonb_build_object('role','owner'));
    perform pg_temp.expect(false, '손님이 스스로 사장이 되지 못한다 (data.role 포함)');
  exception when insufficient_privilege then
    perform pg_temp.expect(true, '손님이 스스로 사장이 되지 못한다 (data.role 포함)');
  end;

  -- 5-2) 반대로 정상 저장까지 막으면 안 된다.
  perform public.save_doc('users', c::text, jsonb_build_object('memo','메모'));
  perform pg_temp.expect(true, 'role 을 건드리지 않는 평범한 프로필 저장은 통과한다');

  -- 6) 서버 전용 테이블은 정책이 없다 = 아무것도 안 보인다.
  perform pg_temp.act_as(a);
  select count(*) into n from public.store_secrets;
  perform pg_temp.expect(n = 0, '사장도 store_secrets 를 읽지 못한다');

  raise notice '── RLS 검증 전부 통과 ──';
end $$;

rollback;
