-- ============================================================
-- 문서 id 를 text 로 — 앱이 만드는 결정적 id 를 받아들이기 위해.
--
-- 앱은 여러 곳에서 **id 를 스스로 정한다.** 무작위가 아니라 의미가 있다:
--
--   tables/{storeId}_{번호}            같은 번호 테이블을 두 번 만들지 않는다
--   orders/COUPONDISC_{쿠폰id}          더블클릭·다중 기기 승인에도 할인 줄이 하나
--   orders/RECEIPT_{매장}_{테이블}_{시각}  같은 영수증이 두 장 생기지 않는다
--   tier_overrides/{손님}_{매장}         손님·매장 조합당 한 줄
--   reservations/res_{시각}_{난수}       (서버 AI 예약)
--
-- 이건 멱등키다. "같은 일을 두 번 요청해도 한 줄"을 id 로 보장한다. Firestore
-- 문서 이름이 임의 문자열이라 쓸 수 있던 방식이고, 옮기면서 잃으면 안 되는 성질이다.
--
-- 그런데 스키마는 id 를 uuid 로 잡았고 save_doc 은 p_id::uuid 로 캐스팅했다.
-- 즉 위 다섯 경로는 **전부 실패**한다. 사장님 가입 시 기본 테이블 15개 생성부터
-- 안 된다. 앱을 uuid 로 바꾸는 건 멱등성을 버리는 것이므로, 스키마를 맞춘다.
--
-- users 만 uuid 로 남는다 — auth.users(id) 를 참조하므로 타입이 고정이다.
-- ============================================================

alter table public.visits           alter column id type text;
alter table public.coupons          alter column id type text;
alter table public.tables           alter column id type text;
alter table public.sections         alter column id type text;
alter table public.communications   alter column id type text;
alter table public.tier_overrides   alter column id type text;
alter table public.menus            alter column id type text;
alter table public.orders           alter column id type text;
alter table public.reservations     alter column id type text;
alter table public.photos           alter column id type text;
alter table public.shifts           alter column id type text;
alter table public.ingredients      alter column id type text;
alter table public.expenses         alter column id type text;
alter table public.marketing_drafts alter column id type text;
alter table public.print_jobs       alter column id type text;

-- users 만 uuid 캐스팅. app_state 를 특별 취급하던 분기는 이제 필요 없다 —
-- 나머지가 전부 text 라 같은 경로를 탄다.
create or replace function public.save_doc(p_table text, p_id text, p_patch jsonb)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_doc_table(p_table) then
    raise exception '알 수 없는 테이블: %', p_table using errcode = '22023';
  end if;

  if p_table = 'users' then
    execute format(
      'insert into public.%I (id, data) values ($1::uuid, public.apply_patch(''{}''::jsonb, $2))
         on conflict (id) do update set data = public.apply_patch(public.%I.data, $2)',
      p_table, p_table) using p_id, p_patch;
  else
    execute format(
      'insert into public.%I (id, data) values ($1, public.apply_patch(''{}''::jsonb, $2))
         on conflict (id) do update set data = public.apply_patch(public.%I.data, $2)',
      p_table, p_table) using p_id, p_patch;
  end if;
end;
$$;

create or replace function public.delete_doc(p_table text, p_id text)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_doc_table(p_table) then
    raise exception '알 수 없는 테이블: %', p_table using errcode = '22023';
  end if;
  if p_table = 'users' then
    execute format('delete from public.%I where id = $1::uuid', p_table) using p_id;
  else
    execute format('delete from public.%I where id = $1', p_table) using p_id;
  end if;
end;
$$;
