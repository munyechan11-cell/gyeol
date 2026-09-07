-- ============================================================
-- 리뷰 감사 쿠폰 — 손님 기기가 직접 만들던 마지막 쿠폰 경로.
--
-- 1400 이 coupons insert 를 매장 전용으로 두면서(손님이 자기 쿠폰을 마음대로
-- 만들지 못하게), 손님 화면이 결제 때 리뷰를 남기고 스스로 발급하던 "리뷰 쿠폰"도
-- 함께 막혔다. 규칙은 클라이언트에 있던 그대로 서버로 옮긴다:
--   · 매장이 켰을 때만(storeConfig.reviewCoupon.enabled).
--   · 이번 자리 세션에 실제 리뷰(별점 또는 글)를 남겼을 때만.
--   · 세션당 한 번 — 쿠폰을 used 로 만든 뒤 모달을 다시 열어 누적 발급하는 악용 차단.
-- ============================================================
create or replace function public.claim_review_coupon(p_store_id uuid, p_table_number int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_customer uuid := auth.uid();
  v_owner    public.users%rowtype;
  v_rc       jsonb;
  v_session  timestamptz;
  v_custom   text;
  v_amount   numeric;
begin
  if v_customer is null then
    raise exception '로그인이 필요합니다' using errcode = '42501';
  end if;
  if (select role from public.users where id = v_customer) is distinct from 'customer' then
    raise exception '손님 계정만' using errcode = '42501';
  end if;
  select * into v_owner from public.users where id = p_store_id and role = 'owner';
  if not found then
    raise exception '매장을 찾을 수 없습니다' using errcode = 'P0002';
  end if;

  v_rc := v_owner.data -> 'storeConfig' -> 'reviewCoupon';
  if coalesce((v_rc ->> 'enabled')::boolean, false) is not true then
    return jsonb_build_object('issued', false, 'reason', 'disabled');
  end if;

  -- 이번 자리 세션의 시작 시각. 없으면 최근 1 시간을 세션으로 본다.
  select nullif(data ->> 'sessionStartTime', '')::timestamptz into v_session
    from public.tables where id = p_store_id::text || '_' || p_table_number;
  v_session := coalesce(v_session, now() - interval '1 hour');

  -- 실제 리뷰(별점 또는 글)가 이 세션에 있어야 한다.
  if not exists (
    select 1 from public.photos
     where "storeId" = p_store_id and type = 'review'
       and data ->> 'customerId' = v_customer::text
       and (coalesce(data ->> 'rating', '') <> '' or coalesce(trim(data ->> 'reviewText'), '') <> '')
       and "createdAt" >= v_session
  ) then
    return jsonb_build_object('issued', false, 'reason', 'no-review');
  end if;

  -- 세션당 한 번.
  if exists (
    select 1 from public.coupons
     where "storeId" = p_store_id and "customerId" = v_customer and data ->> 'type' = 'review'
       and (data ->> 'issuedAt')::timestamptz >= v_session
  ) then
    return jsonb_build_object('issued', false, 'reason', 'already');
  end if;

  v_custom := nullif(trim(coalesce(v_rc ->> 'description', '')), '');
  v_amount := greatest(0, coalesce((v_rc ->> 'amount')::numeric, 0));

  insert into public.coupons (id, data) values (
    gen_random_uuid()::text,
    jsonb_strip_nulls(jsonb_build_object(
      'customerId', v_customer::text, 'storeId', p_store_id::text,
      'type', 'review',
      'description', coalesce(v_custom, '리뷰 감사 쿠폰'),
      'descKey', case when v_custom is null then 'review.rewardDefault' else null end,
      'amount', case when v_amount > 0 then v_amount else null end,
      'status', 'available',
      'issuedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ))
  );
  return jsonb_build_object('issued', true);
end;
$$;
revoke all on function public.claim_review_coupon(uuid, int) from public, anon;
grant execute on function public.claim_review_coupon(uuid, int) to authenticated;
comment on function public.claim_review_coupon is '결제 때 리뷰를 남긴 손님에게 매장 설정대로 감사 쿠폰을 준다. 세션당 1회, 서버가 판정.';
