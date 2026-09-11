-- ============================================================
-- data.role 이 진짜 role 과 어긋나는 것을 막는다.
--
-- role 은 진짜 컬럼이고 권한 판정(my_role, my_store_id)은 그 컬럼만 본다.
-- save_doc 은 data 만 쓰므로 손님이 { "role": "owner" } 를 보내도 **권한은
-- 오르지 않는다** — 거기까지는 설계대로다.
--
-- 문제는 그 다음이다. 앱은 행을 `{...data, id}` 모양으로 읽는다. 그러면
-- 화면에는 role: 'owner' 로 보인다. 데이터는 RLS 가 막으니 새어 나가지 않지만,
-- 사장님 화면이 열리고 메뉴가 뜨고 버튼이 보인다 — 눌러 봐야 아무것도 안 되는.
-- "권한은 없는데 권한이 있는 것처럼 보이는" 상태이고, 이건 버그 리포트로
-- 돌아오거나 client 쪽 role 검사에 기대는 코드를 조용히 틀리게 만든다.
--
-- 두 값이 갈라질 수 없게 한다. 지금 값을 그대로 다시 쓰는 건 통과시키고,
-- 다른 값을 주장하면 거절한다. (insert 는 guard_user_insert 가, 컬럼 변경은
-- guard_user_privileges 가 이미 막고 있다 — 여기는 그 사이의 틈이다.)
-- ============================================================

create or replace function public.guard_user_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role
     or new.data ->> 'staffLevel'      is distinct from old.data ->> 'staffLevel'
     or new.data ->> 'employerStatus'  is distinct from old.data ->> 'employerStatus'
     or new.data ->> 'employerStoreId' is distinct from old.data ->> 'employerStoreId'
     or new.data ->  'extraPerms'      is distinct from old.data ->  'extraPerms'
  then
    raise exception '권한 필드는 본인이 바꿀 수 없습니다 (role/staffLevel/employer*/extraPerms)'
      using errcode = '42501';
  end if;

  -- data 안의 role 은 진짜 role 을 따라야 한다. 어긋나면 화면만 사장이 된다.
  if new.data ? 'role' and new.data ->> 'role' is distinct from new.role then
    raise exception '권한 필드는 본인이 바꿀 수 없습니다 (role)'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- insert 쪽도 같은 성질을 지킨다. role 컬럼은 save_doc 이 patch 의 role 로
-- 채우므로 보통 일치하지만, 직접 insert 하는 경로에서 갈라질 수 있다.
create or replace function public.guard_user_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- 어떤 경로로 들어오든 두 값은 같아야 한다(서버 삽입 포함).
  if new.data ? 'role' and new.data ->> 'role' is distinct from new.role then
    new.data := jsonb_set(new.data, '{role}', to_jsonb(new.role), true);
  end if;

  -- 아래는 본인이 자기 행을 만드는 경우에만. 사장이 직원 행을 만드는 경우와
  -- 서버(service_role, auth.uid() 없음)는 지나간다.
  if auth.uid() is null or auth.uid() <> new.id then
    return new;
  end if;

  if new.data ? 'employerStoreId' then
    new.data := jsonb_set(new.data, '{employerStatus}', '"pending"'::jsonb, true);
  else
    new.data := new.data - 'employerStatus';
  end if;
  new.data := new.data - 'staffLevel' - 'extraPerms';

  return new;
end;
$$;
