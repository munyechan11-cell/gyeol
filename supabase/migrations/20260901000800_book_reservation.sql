-- ============================================================
-- 예약 확정 — 더블북 차단.
--
-- Firestore 판에서는 읽기·판정·쓰기를 runTransaction 으로 묶어 두 통화가 같은
-- 테이블을 동시에 잡는 걸 막았다. 어댑터에는 트랜잭션이 없다. 여기서 그냥
-- "읽고 → 판정하고 → 넣는다"로 옮기면 **조용히 더블북이 되살아난다** — 두 통화가
-- 같은 빈 테이블을 보고 둘 다 예약을 넣는다. 테스트로는 잘 안 잡히고, 손님 두 팀이
-- 같은 자리에 앉고 나서야 안다.
--
-- 판정 로직(영업시간·자리 고르기)은 TypeScript 에 남긴다. SQL 로 옮기면 규칙이
-- 두 벌이 되고 언젠가 갈라진다. 대신 **마지막 한 걸음만** DB 안에서 원자적으로 한다:
-- "이 테이블 이 시간대가 아직 비어 있으면 넣고, 아니면 넣지 마라."
--
-- 앱은 넣기에 실패하면 그 테이블을 빼고 다시 고른다. 결과적으로 판정은 밖에서,
-- 경합은 안에서 해결된다.
--
-- 매장·날짜 단위 advisory lock 을 먼저 잡는 이유: 잠그지 않으면 두 세션이
-- 각자 "겹치는 예약 없음"을 확인한 뒤 둘 다 insert 할 수 있다. 확인과 삽입
-- 사이를 막아야 한다. 트랜잭션이 끝나면 자동으로 풀린다.
-- ============================================================

create or replace function public.hm_to_min(hm text) returns int
language sql immutable as $$
  select case
           when hm ~ '^\d{1,2}:\d{2}$'
             then split_part(hm, ':', 1)::int * 60 + split_part(hm, ':', 2)::int
           else null
         end
$$;
comment on function public.hm_to_min is '"18:30" → 1110. 형식이 아니면 null(비교에서 자동 제외).';

create or replace function public.book_reservation(
  p_id           text,
  p_store        uuid,
  p_date         text,
  p_time         text,
  p_table_number int,
  p_duration_min int,
  p_data         jsonb
) returns boolean
language plpgsql security invoker set search_path = public as $$
declare
  taken boolean;
begin
  -- 같은 매장·같은 날에 대해 확인과 삽입을 직렬화한다.
  perform pg_advisory_xact_lock(hashtext(p_store::text || '|' || p_date));

  select exists (
    select 1
      from public.reservations r
     where r."storeId" = p_store
       and r.date      = p_date
       and r.status    = 'confirmed'
       and (r.data->>'tableNumber')::int = p_table_number
       and abs(public.hm_to_min(r.data->>'time') - public.hm_to_min(p_time)) < p_duration_min
  ) into taken;

  if taken then
    return false;
  end if;

  insert into public.reservations (id, data) values (p_id, p_data);
  return true;
end;
$$;
comment on function public.book_reservation is
  '빈 자리면 예약을 넣고 true, 이미 겹치면 아무것도 안 하고 false. 더블북 차단의 마지막 관문.';

revoke all on function public.book_reservation(text, uuid, text, text, int, int, jsonb) from public, anon;
grant execute on function public.book_reservation(text, uuid, text, text, int, int, jsonb) to authenticated;
