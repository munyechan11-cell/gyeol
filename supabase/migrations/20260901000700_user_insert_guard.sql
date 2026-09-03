-- ============================================================
-- 계정 생성 두 가지 — 되게 하는 것 하나, 못 하게 하는 것 하나.
--
-- 1) 되게: save_doc 이 users.role 을 채우지 않아 **가입이 통째로 실패**했다.
--    role 은 data 안이 아니라 진짜 컬럼(not null)이다 — 그래야 data 를 고쳐
--    스스로 등급을 올리지 못한다. 그런데 save_doc 은 data 만 쓴다. 그 결과
--    "null value in column role violates not-null constraint" 로 회원가입이
--    끝난다. 이게 옮기기 전 원래 증상("회원가입이 안 된다")과 같은 자리다.
--
--    insert 때만 role 을 채운다. 기존 행에는 손대지 않는다 — 손대면 그게 바로
--    자기 등급 올리기가 된다(update 는 guard_user_privileges 가 막는다).
--
-- 2) 못 하게: 권한 상승 차단이 update 에만 걸려 있었다. insert 는 비어 있었다.
--    users_self_insert 정책은 "자기 id 면 통과"라, 새 계정을 만들면서
--      { employerStoreId: <남의 매장>, employerStatus: 'approved' }
--    를 넣으면 그 순간 그 매장의 승인된 직원이 된다. my_store_id() 가 그 매장을
--    돌려주므로 매출·손님·주문이 전부 열린다. 가입 한 번으로 남의 가게에
--    들어가는 길이다.
--
--    본인이 자기 행을 만드는 경우에만 고용 관련 필드를 무력화한다. 사장이
--    직원 행을 만드는 경우(auth.uid() ≠ 행 주인)는 그대로 둔다 — 승인은
--    사장의 권한이다. 서버(service_role)도 그대로 둔다(auth.uid() 가 없다).
--
--    role 자체는 막지 않는다. 'owner' 로 가입하는 건 정상적인 자가 가입이고,
--    사장 권한은 **자기 매장**(my_store_id() = 자기 id)에만 미친다.
--    위험한 건 'staff' 뿐인데, 직원 권한은 role 이 아니라 employerStatus 에서
--    나오므로 위에서 막힌다.
-- ============================================================

create or replace function public.save_doc(p_table text, p_id text, p_patch jsonb)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_doc_table(p_table) then
    raise exception '알 수 없는 테이블: %', p_table using errcode = '22023';
  end if;

  if p_table = 'users' then
    -- role 은 insert 에서만 정해진다. on conflict 절에 role 이 없는 게 핵심이다.
    insert into public.users (id, role, data)
    values (
      p_id::uuid,
      coalesce(nullif(p_patch ->> 'role', ''), 'customer'),
      public.apply_patch('{}'::jsonb, p_patch)
    )
    on conflict (id) do update set data = public.apply_patch(public.users.data, p_patch);
  else
    execute format(
      'insert into public.%I (id, data) values ($1, public.apply_patch(''{}''::jsonb, $2))
         on conflict (id) do update set data = public.apply_patch(public.%I.data, $2)',
      p_table, p_table) using p_id, p_patch;
  end if;
end;
$$;

create or replace function public.guard_user_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- 본인이 자기 행을 만드는 경우에만 적용. 사장이 직원 행을 만드는 경우와
  -- 서버(service_role, auth.uid() 없음)는 지나간다.
  if auth.uid() is null or auth.uid() <> new.id then
    return new;
  end if;

  -- 스스로 줄 수 없는 것들. 소속 신청은 남기되 '승인됨'은 사장만 줄 수 있다.
  if new.data ? 'employerStoreId' then
    new.data := jsonb_set(new.data, '{employerStatus}', '"pending"'::jsonb, true);
  else
    new.data := new.data - 'employerStatus';
  end if;
  new.data := new.data - 'staffLevel' - 'extraPerms';

  return new;
end;
$$;
revoke all on function public.guard_user_insert() from public, anon, authenticated;

drop trigger if exists users_guard_insert on public.users;
create trigger users_guard_insert before insert on public.users
  for each row execute function public.guard_user_insert();
