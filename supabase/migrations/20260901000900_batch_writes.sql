-- ============================================================
-- 여러 문서를 한 트랜잭션으로 — Firestore writeBatch 자리.
--
-- 앱에는 "묶여야만 맞는" 쓰기가 있다. 대표적으로 테이블을 비울 때:
--   미결제 주문들을 cancelled 로 + 그 테이블을 dirty 로
-- 앞은 됐는데 뒤가 실패하면 손님이 앉아 있는 것처럼 보이고, 뒤만 되면 유령
-- pending 주문이 매출·재고 집계에 영원히 남는다. 코드 주석에도 그 버그를 고친
-- 흔적이 남아 있다 — 되살리면 안 된다.
--
-- 낱개 save_doc 을 여러 번 부르면 각각이 별도 트랜잭션이라 그 성질이 사라진다.
-- 함수 하나 안에서 도는 루프는 전체가 한 트랜잭션이므로 중간에 실패하면 전부
-- 되돌아간다. 병합 규칙(apply_patch)과 RLS(security invoker)도 그대로 간다.
--
-- 입력: [{"table":"orders","id":"o1","patch":{...}},
--        {"table":"tables","id":"s_5","delete":true}, ...]
-- ============================================================

create or replace function public.save_docs(p_writes jsonb)
returns void
language plpgsql security invoker set search_path = public as $$
declare
  w jsonb;
begin
  if jsonb_typeof(p_writes) <> 'array' then
    raise exception '쓰기 목록은 배열이어야 합니다' using errcode = '22023';
  end if;
  -- 한 번에 너무 많이 보내면 트랜잭션이 길어져 다른 쓰기를 막는다.
  if jsonb_array_length(p_writes) > 500 then
    raise exception '한 번에 500건까지입니다' using errcode = '22023';
  end if;

  for w in select * from jsonb_array_elements(p_writes) loop
    if coalesce((w ->> 'delete')::boolean, false) then
      perform public.delete_doc(w ->> 'table', w ->> 'id');
    else
      perform public.save_doc(w ->> 'table', w ->> 'id', coalesce(w -> 'patch', '{}'::jsonb));
    end if;
  end loop;
end;
$$;
comment on function public.save_docs is
  '여러 문서를 한 트랜잭션으로 저장/삭제. 하나라도 실패하면 전부 되돌아간다.';

revoke all on function public.save_docs(jsonb) from public, anon;
grant execute on function public.save_docs(jsonb) to authenticated;
