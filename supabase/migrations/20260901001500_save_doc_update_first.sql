-- ============================================================
-- save_doc — "갱신 먼저, 없으면 삽입" 으로.
--
-- 1400 을 적용하고 실제로 찔러 보니 사장이 직원을 승인하는 갱신이 여전히 42501 이었다.
-- 이번엔 트리거가 아니라 **insert 정책**이 막고 있었다. save_doc 이
-- `insert ... on conflict do update` 라서, Postgres 는 갱신으로 끝날 요청에도
-- insert 정책의 with check 를 먼저 건다. users_self_insert 는 "자기 id 만" 이라
-- 남의 행(직원)을 고치는 사장이 거기서 걸린다. 손님이 테이블 점유를 바꾸거나
-- 결제를 요청할 때도 같다 — tables_insert/orders_insert 는 매장 전용이다.
--
-- 그래서 순서를 바꾼다: update 를 먼저 하고, 0건이면 insert 한다.
-- 갱신 권한만 있는 사람은 갱신만 하고, 만들 권한이 없는 행은 insert 에서 42501 로
-- 끝난다(조용히 0건으로 지나가지 않는다 — 앱이 "저장됐다"고 오해하지 않게).
-- 두 요청이 같은 id 를 동시에 만들면 한쪽은 unique 위반 → 다시 update 한다.
-- ============================================================

create or replace function public.save_doc(p_table text, p_id text, p_patch jsonb)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  v_id_uuid uuid;
  v_count   int;
begin
  if not public.is_doc_table(p_table) then
    raise exception '알 수 없는 테이블: %', p_table using errcode = '22023';
  end if;

  if p_table = 'users' then
    v_id_uuid := p_id::uuid;
    update public.users set data = public.apply_patch(data, p_patch) where id = v_id_uuid;
    if not found then
      begin
        -- role 은 insert 에서만 정해진다(000700).
        insert into public.users (id, role, data)
        values (v_id_uuid,
                coalesce(nullif(p_patch ->> 'role', ''), 'customer'),
                public.apply_patch('{}'::jsonb, p_patch));
      exception when unique_violation then
        update public.users set data = public.apply_patch(data, p_patch) where id = v_id_uuid;
      end;
    end if;
  else
    execute format('update public.%I set data = public.apply_patch(data, $2) where id = $1', p_table)
      using p_id, p_patch;
    -- EXECUTE 는 FOUND 를 갱신 건수로 채우지 않는다. ROW_COUNT 를 직접 읽어야 한다.
    -- (안 읽으면 항상 insert 로 떨어져, 손님의 테이블·주문 갱신이 insert 정책에서 42501 로 끝난다.)
    get diagnostics v_count = row_count;
    if v_count = 0 then
      begin
        execute format('insert into public.%I (id, data) values ($1, public.apply_patch(''{}''::jsonb, $2))', p_table)
          using p_id, p_patch;
      exception when unique_violation then
        execute format('update public.%I set data = public.apply_patch(data, $2) where id = $1', p_table)
          using p_id, p_patch;
      end;
    end if;
  end if;
end;
$$;

-- record_visit 가 켜는 gyeol.trusted 는 트랜잭션 끝까지 남는다. PostgREST 는 호출마다
-- 트랜잭션이라 실제로는 무해하지만, 한 트랜잭션에서 여러 문장을 돌리는 검증(rls.sql)에서
-- 뒤따르는 손님 쓰기까지 믿어 버린다. 함수가 끝날 때 끈다.
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

  perform set_config('gyeol.trusted', '1', true);

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

  perform set_config('gyeol.trusted', '', true);
  return jsonb_build_object('newVisit', v_new, 'rewardDelta', v_delta, 'couponIssued', v_issued);
end;
$$;
