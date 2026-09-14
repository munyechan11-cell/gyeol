-- ============================================================
-- 페르소나 테스트 — 기능별 사용자 여정을 실제 DB 에 태워 본다.
--
-- rls.sql 과 무엇이 다른가:
--   · rls.sql 은 **정책**을 묻는다("사장 A 가 매장 B 를 보는가"). 하나라도 어긋나면 멈춘다.
--   · 이 파일은 **기능**을 묻는다("키오스크로 주문이 들어가는가"). 끝까지 다 돌고
--     기능 × 페르소나 표를 돌려준다. 한 기능이 죽어 있어도 나머지 판정을 잃지 않는다.
--
-- 페르소나
--   사장님A 김결   — 파일럿 매장 주인. 앱의 주 사용자.
--   사장님B 박결   — 옆 가게. "남의 매장에서 이게 보이는가"를 묻는 대조군.
--   직원   이알바 — 신청 → 승인 → 홀 운영(2등급).
--   신입   최신입 — 신청만 하고 승인 안 된 상태.
--   손님A  정단골 — QR 로 앉아 주문·결제·리뷰까지 가는 사람.
--   손님B  한번째 — 처음 온 손님. 등급 쿠폰·리뷰 없음 경로 확인용.
--
-- 실행:
--   supabase db execute --file supabase/tests/personas.sql   (또는 SQL 편집기에 붙여넣기)
--   전부 하나의 트랜잭션이고 끝에서 rollback 한다 — 운영 DB 에 흔적이 남지 않는다.
--
-- 읽는 법: 마지막 표의 ok = false 행이 "그 페르소나가 그 기능을 못 쓴다"는 뜻이다.
--   expect 'ok'   = 되어야 하는 일 (긍정 단언)
--   expect 'deny' = 42501 로 막혀야 하는 일
--   expect 'true' = 그 조건이 참이어야 함 (상태 확인)
-- ============================================================

begin;

-- ── 페르소나 id ──────────────────────────────────────────────
create temp table pid on commit drop as
select 'bbbb0000-0000-4000-8000-000000000001'::uuid as owner_a,
       'bbbb0000-0000-4000-8000-000000000002'::uuid as owner_b,
       'bbbb0000-0000-4000-8000-000000000003'::uuid as staff,
       'bbbb0000-0000-4000-8000-000000000004'::uuid as rookie,
       'bbbb0000-0000-4000-8000-000000000005'::uuid as cust_a,
       'bbbb0000-0000-4000-8000-000000000006'::uuid as cust_b;

-- 로그인 자체(Supabase Auth)는 이 파일의 대상이 아니다. 세션이 있다고 보고 시작한다.
insert into auth.users (id, instance_id, aud, role, email, created_at, updated_at)
select x, '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
       'persona-' || x || '@identity.gyeol.app', now(), now()
  from (select unnest(array[owner_a, owner_b, staff, rookie, cust_a, cust_b]) x from pid) s
on conflict (id) do nothing;

-- ── 결과 기록 ────────────────────────────────────────────────
create temp table persona_log(
  seq int, feature text, persona text, step text, expect text, ok boolean, detail text
) on commit drop;
create temp sequence persona_seq;
grant all on table persona_log to authenticated;
grant usage on sequence persona_seq to authenticated;
grant select on table pid to authenticated;

create or replace function pg_temp.note(f text, p text, s text, e text, ok boolean, d text)
returns void language sql security invoker as $fn$
  insert into persona_log values (nextval('persona_seq'), f, p, s, e, ok, nullif(d,''));
$fn$;

-- 요청자 교체 — 정책은 auth.uid() 를 보므로 claim 만 바꾼다.
create or replace function pg_temp.act_as(p uuid) returns void
language plpgsql security invoker as $fn$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p::text, 'role', 'authenticated')::text, true);
end $fn$;

-- 한 걸음 실행. expect: 'ok'(되어야 한다) | 'deny'(42501 로 막혀야 한다) | 'fail'(어떤 오류든 나야 한다)
-- 하위 트랜잭션으로 감싸 실패해도 나머지 여정이 계속된다.
create or replace function pg_temp.step(f text, p text, s text, q text, expect text default 'ok')
returns void language plpgsql security invoker as $fn$
declare v_msg text; v_code text;
begin
  begin
    execute q;
    if expect = 'ok' then
      perform pg_temp.note(f, p, s, expect, true, '');
    else
      perform pg_temp.note(f, p, s, expect, false, '막히지 않고 그대로 수행됐다');
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_code = returned_sqlstate;
    if expect = 'deny' then
      perform pg_temp.note(f, p, s, expect, v_code = '42501', v_code || ' ' || v_msg);
    elsif expect = 'fail' then
      perform pg_temp.note(f, p, s, expect, true, v_code || ' ' || v_msg);
    else
      perform pg_temp.note(f, p, s, expect, false, v_code || ' ' || v_msg);
    end if;
  end;
end $fn$;

-- 상태 확인. q 는 boolean 하나를 돌려주는 select.
create or replace function pg_temp.want(f text, p text, s text, q text)
returns void language plpgsql security invoker as $fn$
declare v_ok boolean; v_msg text; v_code text;
begin
  begin
    execute q into v_ok;
    perform pg_temp.note(f, p, s, 'true', coalesce(v_ok, false), case when coalesce(v_ok,false) then '' else '조건이 거짓' end);
  exception when others then
    get stacked diagnostics v_msg = message_text, v_code = returned_sqlstate;
    perform pg_temp.note(f, p, s, 'true', false, v_code || ' ' || v_msg);
  end;
end $fn$;


-- 여기부터는 로그인한 사용자와 같은 권한으로 돈다. (postgres 는 RLS 를 통과해 버린다)
set local role authenticated;

-- ════════════════════════════════════════════════════════════
-- F01 · 사장님 온보딩 — 가입 → 매장 설정 → 테이블 15개 → 메뉴 → 구역
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');

  perform pg_temp.step('F01 사장님 온보딩','사장님A','사장님으로 가입한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000001', '{
      "role":"owner","name":"김결","restaurantName":"결식당","phone":"01011112222",
      "posApiKey":"pos-비밀키","industry":"restaurant",
      "storeConfig":{"rewardType":"stamp","openTime":"10:00","closeTime":"22:00",
                     "reviewCoupon":{"enabled":true,"amount":3000}}}'::jsonb) $q$, 'ok');

  perform pg_temp.want('F01 사장님 온보딩','사장님A','내 계정이 owner 로 만들어졌다', $q$
    select exists(select 1 from public.users
                   where id='bbbb0000-0000-4000-8000-000000000001' and role='owner'
                     and data->>'restaurantName'='결식당') $q$);

  perform pg_temp.step('F01 사장님 온보딩','사장님A','기본 테이블 15개를 한 번에 만든다(save_docs)', $q$
    select public.save_docs((
      select jsonb_agg(jsonb_build_object(
        'table','tables',
        'id','bbbb0000-0000-4000-8000-000000000001_'||n,
        'patch', jsonb_build_object('storeId','bbbb0000-0000-4000-8000-000000000001',
                 'number',n,'status','available','seats',4,'x',(n%5)*120,'y',(n/5)*120)))
        from generate_series(1,15) n)) $q$, 'ok');

  perform pg_temp.want('F01 사장님 온보딩','사장님A','테이블 15개가 매장에 있다', $q$
    select count(*)=15 from public.tables
     where "storeId"='bbbb0000-0000-4000-8000-000000000001' $q$);

  perform pg_temp.step('F01 사장님 온보딩','사장님A','메뉴를 등록한다(레시피 포함)', $q$
    select public.save_docs('[
      {"table":"menus","id":"m_a1","patch":{"storeId":"bbbb0000-0000-4000-8000-000000000001",
        "name":"김치찌개","price":9000,"category":"식사","recipe":[{"ingredientId":"ing_a1","amount":2}]}},
      {"table":"menus","id":"m_a2","patch":{"storeId":"bbbb0000-0000-4000-8000-000000000001",
        "name":"계란말이","price":6000,"category":"안주"}}]'::jsonb) $q$, 'ok');

  perform pg_temp.step('F01 사장님 온보딩','사장님A','홀 구역(섹션)을 만든다', $q$
    select public.save_doc('sections','sec_a1', '{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "name":"창가","order":1}'::jsonb) $q$, 'ok');

  perform pg_temp.step('F01 사장님 온보딩','사장님A','브랜드 설정을 바꾼다(중첩 병합)', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000001',
      '{"storeConfig":{"theme":"warm"}}'::jsonb) $q$, 'ok');

  perform pg_temp.want('F01 사장님 온보딩','사장님A','기존 설정을 지우지 않고 병합됐다', $q$
    select data->'storeConfig'->>'rewardType'='stamp' and data->'storeConfig'->>'theme'='warm'
      from public.users where id='bbbb0000-0000-4000-8000-000000000001' $q$);

  -- 옆 가게(대조군)
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000002');
  perform pg_temp.step('F01 사장님 온보딩','사장님B','옆 가게도 가입한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000002', '{
      "role":"owner","name":"박결","restaurantName":"옆집","phone":"01033334444",
      "storeConfig":{"rewardType":"point","pointRate":0.05,"reviewCoupon":{"enabled":false}}}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F01 사장님 온보딩','사장님B','옆 가게 테이블·메뉴', $q$
    select public.save_docs('[
      {"table":"tables","id":"bbbb0000-0000-4000-8000-000000000002_1","patch":{"storeId":"bbbb0000-0000-4000-8000-000000000002","number":1,"status":"available"}},
      {"table":"menus","id":"m_b1","patch":{"storeId":"bbbb0000-0000-4000-8000-000000000002","name":"옆집메뉴","price":8000}}]'::jsonb) $q$, 'ok');
end $body$;

-- ════════════════════════════════════════════════════════════
-- F02 · 직원 온보딩 — 매장 검색 → 신청 → 승인 → 홀 운영
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000003');
  perform pg_temp.step('F02 직원 온보딩','직원','직원으로 가입한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000003',
      '{"role":"staff","name":"이알바","phone":"01055556666"}'::jsonb) $q$, 'ok');

  perform pg_temp.want('F02 직원 온보딩','직원','매장 검색 화면에 가게가 보인다(stores 뷰)', $q$
    select count(*) >= 2 from public.stores $q$);

  perform pg_temp.step('F02 직원 온보딩','직원','결식당에 소속을 신청한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000003',
      '{"employerStoreId":"bbbb0000-0000-4000-8000-000000000001","employerStatus":"pending"}'::jsonb) $q$, 'ok');

  perform pg_temp.want('F02 직원 온보딩','직원','승인 대기 상태가 됐다', $q$
    select data->>'employerStatus'='pending' from public.users
     where id='bbbb0000-0000-4000-8000-000000000003' $q$);

  perform pg_temp.step('F02 직원 온보딩','직원','스스로 승인하지 못한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000003',
      '{"employerStatus":"approved"}'::jsonb) $q$, 'deny');
  perform pg_temp.step('F02 직원 온보딩','직원','스스로 등급을 올리지 못한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000003',
      '{"staffLevel":3}'::jsonb) $q$, 'deny');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000002');
  perform pg_temp.step('F02 직원 온보딩','사장님B','남의 매장 지원자를 승인하지 못한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000003',
      '{"employerStatus":"approved"}'::jsonb) $q$, 'deny');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.step('F02 직원 온보딩','사장님A','직원을 승인하고 2등급을 준다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000003',
      '{"employerStatus":"approved","staffLevel":2,"hourlyWage":11000}'::jsonb) $q$, 'ok');
  perform pg_temp.want('F02 직원 온보딩','사장님A','승인·등급이 실제로 반영됐다', $q$
    select data->>'employerStatus'='approved' and data->>'staffLevel'='2'
      from public.users where id='bbbb0000-0000-4000-8000-000000000003' $q$);

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000003');
  perform pg_temp.want('F02 직원 온보딩','직원','승인 뒤 매장 메뉴가 보인다', $q$
    select count(*)=2 from public.menus
     where "storeId"='bbbb0000-0000-4000-8000-000000000001' $q$);
  perform pg_temp.want('F02 직원 온보딩','직원','승인 뒤 사장님 계정 행이 보인다(매장 설정 읽기)', $q$
    select exists(select 1 from public.users where id='bbbb0000-0000-4000-8000-000000000001') $q$);
  perform pg_temp.step('F02 직원 온보딩','직원','출근을 찍는다(shifts)', $q$
    select public.save_doc('shifts','sh_1', jsonb_build_object(
      'storeId','bbbb0000-0000-4000-8000-000000000001',
      'staffId','bbbb0000-0000-4000-8000-000000000003',
      'clockIn', to_char(now(),'YYYY-MM-DD"T"HH24:MI:SS"Z"'))) $q$, 'ok');
  perform pg_temp.step('F02 직원 온보딩','직원','사장님 계정을 고치지 못한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000001',
      '{"restaurantName":"내가게"}'::jsonb) $q$, 'deny');

  -- 미승인 신입
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000004');
  perform pg_temp.step('F02 직원 온보딩','신입','가입 후 신청만 한 상태', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000004',
      '{"role":"staff","name":"최신입","employerStoreId":"bbbb0000-0000-4000-8000-000000000001","employerStatus":"pending"}'::jsonb) $q$, 'ok');
  perform pg_temp.want('F02 직원 온보딩','신입','미승인 상태에서는 자기 행만 보인다', $q$
    select count(*)=1 from public.users $q$);
  perform pg_temp.want('F02 직원 온보딩','신입','미승인 상태에서는 매장 주문이 안 보인다', $q$
    select count(*)=0 from public.orders $q$);
end $body$;

-- ════════════════════════════════════════════════════════════
-- F03 · 손님 QR 진입 — 가입 → 매장 확인 → 방문·적립 → 자리 점유
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000005');
  perform pg_temp.step('F03 QR 진입·적립','손님A','손님으로 가입한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000005',
      '{"role":"customer","name":"정단골","phone":"01077778888"}'::jsonb) $q$, 'ok');

  perform pg_temp.want('F03 QR 진입·적립','손님A','QR 의 매장 이름·보상 방식을 읽는다(stores 뷰)', $q$
    select data->>'restaurantName'='결식당' and data->'storeConfig'->>'rewardType'='stamp'
      from public.stores where id='bbbb0000-0000-4000-8000-000000000001' $q$);
  perform pg_temp.want('F03 QR 진입·적립','손님A','매장 비밀 필드(POS 키)는 안 보인다', $q$
    select count(*)=0 from public.stores where data ? 'posApiKey' $q$);

  perform pg_temp.step('F03 QR 진입·적립','손님A','3번 테이블 QR 로 입장한다(record_visit)', $q$
    select public.record_visit('bbbb0000-0000-4000-8000-000000000001', 3, null) $q$, 'ok');
  perform pg_temp.want('F03 QR 진입·적립','손님A','오늘 방문이 1건 기록됐다', $q$
    select count(*)=1 from public.visits
     where "customerId"='bbbb0000-0000-4000-8000-000000000005'
       and "storeId"='bbbb0000-0000-4000-8000-000000000001' $q$);
  perform pg_temp.want('F03 QR 진입·적립','손님A','스탬프가 1개 적립됐다', $q$
    select data->>'rewardBalance'='1' from public.users
     where id='bbbb0000-0000-4000-8000-000000000005' $q$);
  perform pg_temp.want('F03 QR 진입·적립','손님A','3번 테이블이 내 자리로 표시된다', $q$
    select data->>'currentCustomerId'='bbbb0000-0000-4000-8000-000000000005'
      from public.tables where id='bbbb0000-0000-4000-8000-000000000001_3' $q$);
  perform pg_temp.want('F03 QR 진입·적립','손님A','같은 날 재입장은 방문으로 중복 집계되지 않는다', $q$
    select not ((public.record_visit('bbbb0000-0000-4000-8000-000000000001', 3, null))->>'newVisit')::boolean $q$);

  perform pg_temp.step('F03 QR 진입·적립','손님A','적립금을 스스로 써 넣지 못한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000005',
      '{"rewardBalance":99999}'::jsonb) $q$, 'deny');
  perform pg_temp.step('F03 QR 진입·적립','손님A','테이블 위치를 옮기지 못한다', $q$
    select public.save_doc('tables','bbbb0000-0000-4000-8000-000000000001_3',
      '{"x":999}'::jsonb) $q$, 'deny');
  perform pg_temp.step('F03 QR 진입·적립','손님A','인원수는 스스로 입력할 수 있다', $q$
    select public.save_doc('tables','bbbb0000-0000-4000-8000-000000000001_3',
      '{"partySize":2}'::jsonb) $q$, 'ok');

  -- 처음 온 손님(대조군)
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000006');
  perform pg_temp.step('F03 QR 진입·적립','손님B','처음 온 손님도 가입한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000006',
      '{"role":"customer","name":"한번째"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F03 QR 진입·적립','손님B','옆집(포인트 적립)에 5번으로 입장한다', $q$
    select public.record_visit('bbbb0000-0000-4000-8000-000000000002', 5, 20000) $q$, 'ok');
  perform pg_temp.want('F03 QR 진입·적립','손님B','포인트 매장은 금액의 5퍼센트(1000P)를 적립한다', $q$
    select data->>'rewardBalance'='1000' from public.users
     where id='bbbb0000-0000-4000-8000-000000000006' $q$);
  perform pg_temp.want('F03 QR 진입·적립','손님B','QR 번호에 없던 테이블은 자동으로 만들어진다', $q$
    select exists(select 1 from public.tables where id='bbbb0000-0000-4000-8000-000000000002_5') $q$);
end $body$;

-- ════════════════════════════════════════════════════════════
-- F04 · 주문 — 손님 주문 · 주방 진행 · 키오스크/빠른주문/워크인/POS
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000005');
  perform pg_temp.step('F04 주문','손님A','테이블에서 주문한다', $q$
    select public.save_doc('orders','o_ca1', '{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"bbbb0000-0000-4000-8000-000000000005","tableNumber":3,
      "items":[{"menuId":"m_a1","name":"김치찌개","quantity":2,"price":9000}],
      "totalAmount":18000,"status":"pending","paymentStatus":"unpaid"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F04 주문','손님A','주문 뒤 테이블이 식사중으로 바뀐다', $q$
    select public.save_doc('tables','bbbb0000-0000-4000-8000-000000000001_3',
      '{"status":"dining"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F04 주문','손님A','한 건 더 주문한다(취소 확인용)', $q$
    select public.save_doc('orders','o_ca2', '{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"bbbb0000-0000-4000-8000-000000000005","tableNumber":3,
      "items":[{"menuId":"m_a2","name":"계란말이","quantity":1,"price":6000}],
      "totalAmount":6000,"status":"pending","paymentStatus":"unpaid"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F04 주문','손님A','접수 전 주문을 스스로 취소한다', $q$
    select public.save_doc('orders','o_ca2','{"status":"cancelled"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F04 주문','손님A','주문을 조리중으로 바꾸지는 못한다', $q$
    select public.save_doc('orders','o_ca1','{"status":"cooking"}'::jsonb) $q$, 'deny');
  perform pg_temp.step('F04 주문','손님A','주문 금액을 스스로 깎지 못한다', $q$
    select public.save_doc('orders','o_ca1','{"totalAmount":100}'::jsonb) $q$, 'deny');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.want('F04 주문','사장님A','주문이 홀 화면에 뜬다', $q$
    select count(*)>=1 from public.orders
     where "storeId"='bbbb0000-0000-4000-8000-000000000001' and data->>'status'='pending' $q$);
  perform pg_temp.step('F04 주문','사장님A','주문을 접수한다(조리중)', $q$
    select public.save_doc('orders','o_ca1','{"status":"cooking"}'::jsonb) $q$, 'ok');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000003');
  perform pg_temp.step('F04 주문','직원','주방 화면에서 서빙 완료로 넘긴다', $q$
    select public.save_doc('orders','o_ca1','{"status":"served"}'::jsonb) $q$, 'ok');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000002');
  perform pg_temp.want('F04 주문','사장님B','남의 매장 주문은 안 보인다', $q$
    select count(*)=0 from public.orders
     where "storeId"='bbbb0000-0000-4000-8000-000000000001' $q$);
  perform pg_temp.step('F04 주문','사장님B','남의 매장 주문을 고치지 못한다', $q$
    select public.save_doc('orders','o_ca1','{"status":"cancelled"}'::jsonb) $q$, 'deny');

  -- 계정 없는 손님을 대신 받는 네 경로. 앱이 실제로 쓰는 customerId 모양 그대로.
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.step('F04 주문','사장님A','키오스크로 주문을 받는다(customerId=kiosk_T3)', $q$
    select public.save_doc('orders','o_kiosk', '{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"kiosk_T3","tableNumber":3,
      "items":[{"menuId":"m_a1","name":"김치찌개","quantity":1,"price":9000}],
      "totalAmount":9000,"status":"pending","paymentStatus":"unpaid"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F04 주문','사장님A','빠른주문(POS 입력)으로 받는다(customerId=pos_T5)', $q$
    select public.save_doc('orders','o_pos', '{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"pos_T5","tableNumber":5,
      "items":[{"menuId":"m_a2","name":"계란말이","quantity":1,"price":6000}],
      "totalAmount":6000,"status":"pending","paymentStatus":"unpaid"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F04 주문','사장님A','대기 손님(워크인) 주문을 받는다(customerId=walkin_W101)', $q$
    select public.save_doc('orders','o_walkin', '{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"walkin_W101","tableNumber":101,
      "items":[{"menuId":"m_a1","name":"김치찌개","quantity":1,"price":9000}],
      "totalAmount":9000,"status":"pending","paymentStatus":"unpaid"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F04 주문','사장님A','토스플레이스 카운터 매출을 받는다(customerId 빈 값)', $q$
    select public.save_doc('orders','o_toss', '{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"","tableNumber":0,
      "items":[{"menuId":"","name":"카운터","quantity":1,"price":12000}],
      "totalAmount":12000,"status":"served","paymentStatus":"paid"}'::jsonb) $q$, 'ok');
end $body$;

-- ════════════════════════════════════════════════════════════
-- F05 · 결제 — 손님 요청 → 사장 확정 / 금액 조작 차단
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000005');
  perform pg_temp.step('F05 결제','손님A','계산을 요청한다', $q$
    select public.save_doc('orders','o_ca1','{"paymentStatus":"requested"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F05 결제','손님A','스스로 결제 완료로 만들지 못한다', $q$
    select public.save_doc('orders','o_ca1','{"paymentStatus":"paid"}'::jsonb) $q$, 'deny');
  perform pg_temp.step('F05 결제','손님A','남의 주문 결제를 건드리지 못한다', $q$
    select public.save_doc('orders','o_kiosk','{"paymentStatus":"requested"}'::jsonb) $q$, 'deny');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.want('F05 결제','사장님A','계산 요청이 사장님 화면에 뜬다', $q$
    select exists(select 1 from public.orders where id='o_ca1' and data->>'paymentStatus'='requested') $q$);
  perform pg_temp.step('F05 결제','사장님A','현금 결제를 확정한다', $q$
    select public.save_doc('orders','o_ca1','{"paymentStatus":"paid","status":"served"}'::jsonb) $q$, 'ok');
  perform pg_temp.want('F05 결제','사장님A','결제 완료가 기록됐다', $q$
    select data->>'paymentStatus'='paid' from public.orders where id='o_ca1' $q$);
end $body$;

-- ════════════════════════════════════════════════════════════
-- F06 · 테이블 운영 — 배치 · 상태 전이 · 강제 퇴장(묶음 쓰기)
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.step('F06 테이블','사장님A','테이블을 옮기고 구역에 배정한다', $q$
    select public.save_doc('tables','bbbb0000-0000-4000-8000-000000000001_1',
      '{"x":320,"y":40,"sectionId":"sec_a1","seats":6}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F06 테이블','사장님A','테이블을 추가한다(16번)', $q$
    select public.save_doc('tables','bbbb0000-0000-4000-8000-000000000001_16',
      '{"storeId":"bbbb0000-0000-4000-8000-000000000001","number":16,"status":"available"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F06 테이블','사장님A','손님을 내보내며 미결제 주문을 함께 정리한다(한 묶음)', $q$
    select public.save_docs('[
      {"table":"orders","id":"o_ca2","patch":{"status":"cancelled"}},
      {"table":"tables","id":"bbbb0000-0000-4000-8000-000000000001_16","patch":{"status":"dirty","currentCustomerId":null,"occupantIds":[]}}]'::jsonb) $q$, 'ok');
  perform pg_temp.step('F06 테이블','사장님A','다 치운 테이블을 비움으로 되돌린다', $q$
    select public.save_doc('tables','bbbb0000-0000-4000-8000-000000000001_16',
      '{"status":"available"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F06 테이블','사장님A','테이블을 삭제한다', $q$
    select public.delete_doc('tables','bbbb0000-0000-4000-8000-000000000001_16') $q$, 'ok');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000003');
  perform pg_temp.step('F06 테이블','직원','직원도 홀 테이블 상태를 바꾼다', $q$
    select public.save_doc('tables','bbbb0000-0000-4000-8000-000000000001_1',
      '{"status":"setup"}'::jsonb) $q$, 'ok');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000002');
  perform pg_temp.step('F06 테이블','사장님B','남의 매장 테이블을 바꾸지 못한다', $q$
    select public.save_doc('tables','bbbb0000-0000-4000-8000-000000000001_1',
      '{"status":"available"}'::jsonb) $q$, 'deny');
end $body$;

-- ════════════════════════════════════════════════════════════
-- F07 · 예약 — 더블북 차단 · 매장 격리
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.want('F07 예약','사장님A','18:30 4번 테이블 예약이 잡힌다', $q$
    select public.book_reservation('r_1','bbbb0000-0000-4000-8000-000000000001','2026-09-20','18:30',4,90,
      '{"storeId":"bbbb0000-0000-4000-8000-000000000001","date":"2026-09-20","time":"18:30",
        "tableNumber":4,"status":"confirmed","name":"김손님","phone":"01012345678","partySize":4}'::jsonb) $q$);
  perform pg_temp.want('F07 예약','사장님A','같은 자리 19:00 은 더블북으로 거절된다', $q$
    select public.book_reservation('r_2','bbbb0000-0000-4000-8000-000000000001','2026-09-20','19:00',4,90,
      '{"storeId":"bbbb0000-0000-4000-8000-000000000001","date":"2026-09-20","time":"19:00",
        "tableNumber":4,"status":"confirmed","name":"이손님"}'::jsonb) = false $q$);
  perform pg_temp.want('F07 예약','사장님A','같은 자리 20:30 은 잡힌다(간격 밖)', $q$
    select public.book_reservation('r_3','bbbb0000-0000-4000-8000-000000000001','2026-09-20','20:30',4,90,
      '{"storeId":"bbbb0000-0000-4000-8000-000000000001","date":"2026-09-20","time":"20:30",
        "tableNumber":4,"status":"confirmed","name":"박손님"}'::jsonb) $q$);
  perform pg_temp.step('F07 예약','사장님A','예약을 노쇼로 바꾼다', $q$
    select public.save_doc('reservations','r_1','{"status":"noshow"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F07 예약','사장님A','예약 테이블을 미리 예약 상태로 표시한다', $q$
    select public.save_doc('tables','bbbb0000-0000-4000-8000-000000000001_4',
      '{"status":"reserved"}'::jsonb) $q$, 'ok');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000002');
  perform pg_temp.want('F07 예약','사장님B','남의 매장 예약은 안 보인다', $q$
    select count(*)=0 from public.reservations $q$);
  perform pg_temp.step('F07 예약','사장님B','남의 매장에 예약을 밀어 넣지 못한다', $q$
    select public.save_doc('reservations','r_x','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "date":"2026-09-21","time":"12:00","tableNumber":1,"status":"confirmed"}'::jsonb) $q$, 'deny');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000005');
  perform pg_temp.step('F07 예약','손님A','손님 기기는 예약을 직접 쓰지 못한다(서버 경유)', $q$
    select public.save_doc('reservations','r_y','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "date":"2026-09-22","time":"12:00","tableNumber":2,"status":"confirmed"}'::jsonb) $q$, 'deny');
end $body$;

-- ════════════════════════════════════════════════════════════
-- F08 · 쿠폰 — 발급 → 사용 요청 → 승인 / 자가 조작
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.step('F08 쿠폰','사장님A','단골에게 금액 쿠폰을 발급한다', $q$
    select public.save_doc('coupons','k_1','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"bbbb0000-0000-4000-8000-000000000005","type":"manual",
      "description":"3천원 할인","amount":3000,"status":"available"}'::jsonb) $q$, 'ok');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000005');
  perform pg_temp.want('F08 쿠폰','손님A','내 쿠폰함에 들어왔다', $q$
    select count(*)=1 from public.coupons
     where "customerId"='bbbb0000-0000-4000-8000-000000000005' $q$);
  perform pg_temp.step('F08 쿠폰','손님A','쿠폰을 스스로 만들지 못한다', $q$
    select public.save_doc('coupons','k_self','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"bbbb0000-0000-4000-8000-000000000005","amount":50000,"status":"available"}'::jsonb) $q$, 'deny');
  perform pg_temp.step('F08 쿠폰','손님A','쓰겠다고 요청한다(사장님 승인 대기)', $q$
    select public.save_doc('coupons','k_1','{"status":"pending","usedAtTable":3}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F08 쿠폰','손님A','요청을 취소한다', $q$
    select public.save_doc('coupons','k_1','{"status":"available","usedAtTable":null}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F08 쿠폰','손님A','쿠폰 금액을 스스로 올리지 못한다', $q$
    select public.save_doc('coupons','k_1','{"amount":999999}'::jsonb) $q$, 'deny');
  perform pg_temp.step('F08 쿠폰','손님A','스스로 사용 완료로 만들지 못한다', $q$
    select public.save_doc('coupons','k_1','{"status":"used"}'::jsonb) $q$, 'deny');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.step('F08 쿠폰','사장님A','쿠폰 사용을 승인하고 할인 라인을 넣는다', $q$
    select public.save_docs('[
      {"table":"orders","id":"COUPONDISC_k_1","patch":{"storeId":"bbbb0000-0000-4000-8000-000000000001",
        "customerId":"bbbb0000-0000-4000-8000-000000000005","tableNumber":3,
        "items":[{"menuId":"","name":"쿠폰 할인","quantity":1,"price":-3000}],
        "totalAmount":-3000,"status":"served","paymentStatus":"unpaid"}},
      {"table":"coupons","id":"k_1","patch":{"status":"used"}}]'::jsonb) $q$, 'ok');
  perform pg_temp.want('F08 쿠폰','사장님A','쿠폰이 사용 처리됐다', $q$
    select data->>'status'='used' from public.coupons where id='k_1' $q$);

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000002');
  perform pg_temp.want('F08 쿠폰','사장님B','남의 매장 쿠폰은 안 보인다', $q$
    select count(*)=0 from public.coupons $q$);
end $body$;

-- 등급 쿠폰은 "최근 30일 방문 일수"로 발급된다. 지난 방문을 서버 쪽에서 심어 둔다
-- (손님 기기는 방문을 직접 못 쓴다 — 그게 F03 에서 확인한 규칙이다).
reset role;
insert into public.visits (id, data)
select 'seed_v' || d,
       jsonb_build_object(
         'customerId','bbbb0000-0000-4000-8000-000000000006',
         'storeId','bbbb0000-0000-4000-8000-000000000001',
         'tableNumber', 7,
         'date', to_char((now() - (d || ' days')::interval) at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
         'day', to_char((now() - (d || ' days')::interval) at time zone 'Asia/Seoul','YYYY-MM-DD'))
  from generate_series(1,5) d;
grant all on table persona_log to anon;
grant usage on sequence persona_seq to anon;
set local role authenticated;

-- ════════════════════════════════════════════════════════════
-- F09 · 등급 보상 · 리뷰 · 리뷰 쿠폰
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000006');
  perform pg_temp.want('F09 등급·리뷰','손님B','6일째 방문에서 등급 쿠폰이 발급된다', $q$
    select (public.record_visit('bbbb0000-0000-4000-8000-000000000001', 7, null))->>'couponIssued' is not null $q$);
  perform pg_temp.want('F09 등급·리뷰','손님B','발급된 등급 쿠폰이 쿠폰함에 있다', $q$
    select count(*)>=1 from public.coupons
     where "customerId"='bbbb0000-0000-4000-8000-000000000006' $q$);

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000005');
  perform pg_temp.want('F09 등급·리뷰','손님A','리뷰 없이 요청하면 쿠폰이 안 나온다', $q$
    select (public.claim_review_coupon('bbbb0000-0000-4000-8000-000000000001', 3))->>'reason' = 'no-review' $q$);
  perform pg_temp.step('F09 등급·리뷰','손님A','별점과 후기를 남긴다', $q$
    select public.save_doc('photos','ph_rev1','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"bbbb0000-0000-4000-8000-000000000005","type":"review","rating":5,
      "reviewText":"김치찌개가 좋았어요"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F09 등급·리뷰','손님A','매장 홍보 사진을 올리지는 못한다', $q$
    select public.save_doc('photos','ph_menu1','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"bbbb0000-0000-4000-8000-000000000005","type":"menu"}'::jsonb) $q$, 'deny');
  perform pg_temp.want('F09 등급·리뷰','손님A','리뷰를 남기면 감사 쿠폰이 나온다', $q$
    select ((public.claim_review_coupon('bbbb0000-0000-4000-8000-000000000001', 3))->>'issued')::boolean $q$);
  perform pg_temp.want('F09 등급·리뷰','손님A','같은 자리에서 두 번은 안 나온다', $q$
    select (public.claim_review_coupon('bbbb0000-0000-4000-8000-000000000001', 3))->>'reason' = 'already' $q$);

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000006');
  perform pg_temp.step('F09 등급·리뷰','손님B','옆집에도 리뷰를 남긴다', $q$
    select public.save_doc('photos','ph_rev2','{"storeId":"bbbb0000-0000-4000-8000-000000000002",
      "customerId":"bbbb0000-0000-4000-8000-000000000006","type":"review","rating":4}'::jsonb) $q$, 'ok');
  perform pg_temp.want('F09 등급·리뷰','손님B','리뷰 쿠폰을 끈 매장은 발급하지 않는다', $q$
    select (public.claim_review_coupon('bbbb0000-0000-4000-8000-000000000002', 5))->>'reason' = 'disabled' $q$);

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.want('F09 등급·리뷰','사장님A','받은 리뷰가 매장 화면에 보인다', $q$
    select count(*)>=1 from public.photos
     where "storeId"='bbbb0000-0000-4000-8000-000000000001' and type='review' $q$);
end $body$;

-- "보이면 안 되는 것" 판정 — 42501 로 막히거나, 0건이면 통과.
reset role;
create or replace function pg_temp.blocked(f text, p text, s text, q text)
returns void language plpgsql security invoker as $fn$
declare n bigint; v_msg text; v_code text;
begin
  begin
    execute q into n;
    perform pg_temp.note(f, p, s, '0건 또는 차단', n = 0, '보인 행 수: ' || n);
  exception when others then
    get stacked diagnostics v_msg = message_text, v_code = returned_sqlstate;
    perform pg_temp.note(f, p, s, '0건 또는 차단', v_code = '42501', v_code || ' ' || v_msg);
  end;
end $fn$;
set local role authenticated;

-- ════════════════════════════════════════════════════════════
-- F10 · 재고 · 경비
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.step('F10 재고·경비','사장님A','재료를 등록한다', $q$
    select public.save_doc('ingredients','ing_a1','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "name":"김치","unit":"kg","stock":10,"minStock":2,"unitPrice":8000}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F10 재고·경비','사장님A','발주로 재고를 늘린다(increment)', $q$
    select public.save_doc('ingredients','ing_a1','{"stock":{"__op":"increment","by":5}}'::jsonb) $q$, 'ok');
  perform pg_temp.want('F10 재고·경비','사장님A','재고가 15 로 올랐다', $q$
    select (data->>'stock')::numeric = 15 from public.ingredients where id='ing_a1' $q$);
  perform pg_temp.step('F10 재고·경비','사장님A','지출을 기록한다', $q$
    select public.save_doc('expenses','ex_1','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "category":"식자재","amount":120000,"date":"2026-09-14","memo":"김치 발주"}'::jsonb) $q$, 'ok');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000003');
  perform pg_temp.step('F10 재고·경비','직원','주문이 나가며 재고가 자동 차감된다(레시피 2)', $q$
    select public.save_doc('ingredients','ing_a1','{"stock":{"__op":"increment","by":-2}}'::jsonb) $q$, 'ok');
  perform pg_temp.want('F10 재고·경비','직원','차감이 반영됐다(13)', $q$
    select (data->>'stock')::numeric = 13 from public.ingredients where id='ing_a1' $q$);

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000002');
  perform pg_temp.blocked('F10 재고·경비','사장님B','남의 매장 재고는 안 보인다', $q$
    select count(*) from public.ingredients $q$);
  perform pg_temp.blocked('F10 재고·경비','사장님B','남의 매장 지출은 안 보인다', $q$
    select count(*) from public.expenses $q$);
end $body$;

-- ════════════════════════════════════════════════════════════
-- F11 · 고객 관리 · 마케팅
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.step('F11 고객·마케팅','사장님A','단골에게 메모를 남긴다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000005',
      '{"memo":"맵기 약하게"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F11 고객·마케팅','사장님A','등급을 수동 지정한다', $q$
    select public.save_doc('tier_overrides','to_1','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"bbbb0000-0000-4000-8000-000000000005","tier":"VIP"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F11 고객·마케팅','사장님A','손님에게 메시지를 보낸다', $q$
    select public.save_doc('communications','cm_1','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"bbbb0000-0000-4000-8000-000000000005","senderRole":"owner",
      "type":"message","content":"오늘 신메뉴 나왔어요"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F11 고객·마케팅','사장님A','마케팅 초안을 저장한다', $q$
    select public.save_doc('marketing_drafts','md_1','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "channel":"instagram","status":"draft","caption":"오늘의 메뉴"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F11 고객·마케팅','사장님A','초안을 발행 예약으로 넘긴다', $q$
    select public.save_doc('marketing_drafts','md_1','{"status":"scheduled",
      "scheduledAt":"2026-09-15T02:00:00.000Z"}'::jsonb) $q$, 'ok');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000005');
  perform pg_temp.want('F11 고객·마케팅','손님A','매장이 보낸 메시지를 받는다', $q$
    select count(*)=1 from public.communications
     where "customerId"='bbbb0000-0000-4000-8000-000000000005' $q$);
  perform pg_temp.step('F11 고객·마케팅','손님A','사장님에게 문의를 보낸다', $q$
    select public.save_doc('communications','cm_2','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"bbbb0000-0000-4000-8000-000000000005","senderRole":"customer",
      "type":"message","content":"예약 되나요?"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F11 고객·마케팅','손님A','매장인 척 메시지를 보내지 못한다', $q$
    select public.save_doc('communications','cm_3','{"storeId":"bbbb0000-0000-4000-8000-000000000001",
      "customerId":"bbbb0000-0000-4000-8000-000000000005","senderRole":"owner",
      "type":"message","content":"위장"}'::jsonb) $q$, 'deny');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000002');
  perform pg_temp.blocked('F11 고객·마케팅','사장님B','남의 매장 마케팅 초안은 안 보인다', $q$
    select count(*) from public.marketing_drafts $q$);
  perform pg_temp.blocked('F11 고객·마케팅','사장님B','남의 매장 고객 메시지는 안 보인다', $q$
    select count(*) from public.communications $q$);
  perform pg_temp.step('F11 고객·마케팅','사장님B','남의 매장 손님 메모를 덮어쓰지 못한다', $q$
    select public.save_doc('tier_overrides','to_1','{"tier":"브론즈"}'::jsonb) $q$, 'deny');
end $body$;

-- ════════════════════════════════════════════════════════════
-- F12 · 통계 · 정산 — 집계가 매장 경계 안에서만 보인다
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.want('F12 통계·정산','사장님A','오늘 결제 매출이 집계된다', $q$
    select coalesce(sum((data->>'totalAmount')::numeric),0) > 0 from public.orders
     where "storeId"='bbbb0000-0000-4000-8000-000000000001' and data->>'paymentStatus'='paid' $q$);
  perform pg_temp.want('F12 통계·정산','사장님A','방문 손님 수가 집계된다', $q$
    select count(distinct "customerId") >= 1 from public.visits
     where "storeId"='bbbb0000-0000-4000-8000-000000000001' $q$);
  perform pg_temp.blocked('F12 통계·정산','사장님A','정산 키(store_secrets)는 사장님도 못 읽는다(서버 전용)', $q$
    select count(*) from public.store_secrets $q$);
  perform pg_temp.blocked('F12 통계·정산','사장님A','마스터 비밀번호는 못 읽는다', $q$
    select count(*) from public.app_secrets $q$);

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000003');
  perform pg_temp.want('F12 통계·정산','직원','직원도 매장 매출을 본다(등급 게이트는 화면이 건다)', $q$
    select count(*) >= 1 from public.orders
     where "storeId"='bbbb0000-0000-4000-8000-000000000001' $q$);

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000002');
  perform pg_temp.blocked('F12 통계·정산','사장님B','남의 매장 방문 기록은 안 보인다', $q$
    select count(*) from public.visits
     where "storeId"='bbbb0000-0000-4000-8000-000000000001' $q$);

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000005');
  perform pg_temp.blocked('F12 통계·정산','손님A','손님은 마스터 비밀번호를 못 읽는다', $q$
    select count(*) from public.app_secrets $q$);
  perform pg_temp.blocked('F12 통계·정산','손님A','손님은 남의 주문을 못 읽는다', $q$
    select count(*) from public.orders where id='o_kiosk' $q$);
end $body$;

-- ════════════════════════════════════════════════════════════
-- F13 · 푸시 알림 토큰 · 계정 삭제 경계
-- ════════════════════════════════════════════════════════════
do $body$
begin
  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000005');
  perform pg_temp.step('F13 푸시·탈퇴','손님A','알림 허용 — 기기 토큰을 등록한다', $q$
    select public.set_fcm_token('tok-customer-a','web') $q$, 'ok');
  perform pg_temp.want('F13 푸시·탈퇴','손님A','토큰이 내 계정에 저장됐다', $q$
    select data->'fcmTokens' @> '[{"token":"tok-customer-a"}]'::jsonb from public.users
     where id='bbbb0000-0000-4000-8000-000000000005' $q$);
  perform pg_temp.step('F13 푸시·탈퇴','손님A','알림 끄기 — 토큰을 지운다', $q$
    select public.remove_fcm_token('tok-customer-a') $q$, 'ok');
  perform pg_temp.step('F13 푸시·탈퇴','손님A','탈퇴를 앱에서 시도해 본다(서버가 해야 하는 일)', $q$
    select public.delete_doc('users','bbbb0000-0000-4000-8000-000000000005') $q$, 'ok');
  perform pg_temp.want('F13 푸시·탈퇴','손님A','앱의 삭제 시도로는 계정이 지워지지 않는다', $q$
    select exists(select 1 from public.users where id='bbbb0000-0000-4000-8000-000000000005') $q$);

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000001');
  perform pg_temp.step('F13 푸시·탈퇴','사장님A','사장님 기기도 토큰을 등록한다', $q$
    select public.set_fcm_token('tok-owner-a','web') $q$, 'ok');
  perform pg_temp.step('F13 푸시·탈퇴','사장님A','손님 계정 삭제를 시도해 본다', $q$
    select public.delete_doc('users','bbbb0000-0000-4000-8000-000000000005') $q$, 'ok');
  perform pg_temp.want('F13 푸시·탈퇴','사장님A','사장님은 손님 계정을 지우지 못한다', $q$
    select exists(select 1 from public.users where id='bbbb0000-0000-4000-8000-000000000005') $q$);
  perform pg_temp.step('F13 푸시·탈퇴','사장님A','지원을 거절한다(rejected)', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000004',
      '{"employerStatus":"rejected"}'::jsonb) $q$, 'ok');
  perform pg_temp.step('F13 푸시·탈퇴','사장님A','직원 소속을 해제한다(직원 관리 화면의 삭제)', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000004',
      '{"employerStoreId":null,"employerStatus":null,"position":null}'::jsonb) $q$, 'ok');

  perform pg_temp.act_as('bbbb0000-0000-4000-8000-000000000004');
  perform pg_temp.step('F13 푸시·탈퇴','신입','본인이 소속 신청을 철회한다', $q$
    select public.save_doc('users','bbbb0000-0000-4000-8000-000000000004',
      '{"employerStoreId":null,"employerStatus":null,"joinRequestedAt":null}'::jsonb) $q$, 'ok');
end $body$;

-- ════════════════════════════════════════════════════════════
-- F14 · 비로그인(anon) — QR 만 알고 아직 로그인 안 한 사람
-- ════════════════════════════════════════════════════════════
set local role anon;
do $body$
begin
  perform set_config('request.jwt.claims', null, true);
  perform pg_temp.blocked('F14 비로그인','비로그인','손님 개인정보를 읽지 못한다', $q$
    select count(*) from public.users $q$);
  perform pg_temp.blocked('F14 비로그인','비로그인','매장 주문을 읽지 못한다', $q$
    select count(*) from public.orders $q$);
  perform pg_temp.blocked('F14 비로그인','비로그인','매장 목록(stores 뷰)도 로그인 뒤에만 준다', $q$
    select count(*) from public.stores $q$);
  perform pg_temp.step('F14 비로그인','비로그인','문서를 저장하지 못한다', $q$
    select public.save_doc('menus','m_anon','{"storeId":"bbbb0000-0000-4000-8000-000000000001","name":"침입"}'::jsonb) $q$, 'fail');
  perform pg_temp.step('F14 비로그인','비로그인','방문을 기록하지 못한다', $q$
    select public.record_visit('bbbb0000-0000-4000-8000-000000000001', 1, null) $q$, 'fail');
end $body$;
reset role;

-- ── 결과 ────────────────────────────────────────────────────
select case when ok then '✅' else '❌' end as "판정",
       feature as "기능", persona as "페르소나", step as "여정",
       expect as "기대", coalesce(detail,'') as "상세"
  from persona_log order by seq;

rollback;
