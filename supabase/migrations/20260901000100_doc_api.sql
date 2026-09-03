-- ============================================================
-- 문서 저장 API — Firestore 의 setDoc(merge:true) 를 Postgres 로 옮긴 것.
--
-- 앱은 문서 전체가 아니라 **부분 패치**를 보낸다(`updateFirestoreDoc(coll, id, {일부})`).
-- 그리고 일부 필드는 원자적 연산을 쓴다 — 적립금 increment, 재고 차감, 소셜 ID arrayUnion.
-- 클라이언트에서 읽고-합쳐-쓰면 두 직원이 동시에 작업할 때 한쪽이 사라진다.
-- 그래서 병합을 DB 안에서 한 번에 처리한다.
--
-- 쓰기 가능한 컬럼이 `data` 하나뿐이라(생성 컬럼 설계) 이 함수 하나가 모든 테이블에 통한다.
-- security invoker 다 — RLS 를 우회하지 않는다.
-- ============================================================

-- 원자적 연산 표식. 앱은 이 모양의 객체를 패치에 섞어 보낸다.
--   {"__op":"increment","by":-3}
--   {"__op":"arrayUnion","values":["a","b"]}
--   {"__op":"arrayRemove","values":["a"]}
--   {"__op":"delete"}
create or replace function public.apply_patch(current jsonb, patch jsonb)
returns jsonb
language plpgsql immutable set search_path = public as $$
declare
  k    text;
  v    jsonb;
  cur  jsonb;
  out  jsonb := coalesce(current, '{}'::jsonb);
begin
  if patch is null or jsonb_typeof(patch) <> 'object' then
    return out;
  end if;

  for k, v in select * from jsonb_each(patch) loop
    cur := out -> k;

    if jsonb_typeof(v) = 'object' and v ? '__op' then
      case v ->> '__op'
        when 'delete' then
          out := out - k;
        when 'increment' then
          out := jsonb_set(out, array[k], to_jsonb(
            coalesce((cur #>> '{}')::numeric, 0) + coalesce((v ->> 'by')::numeric, 0)
          ));
        when 'arrayUnion' then
          -- 중복 없이 덧붙인다. 기존 순서를 유지하고 새 값을 뒤에 붙인다.
          -- (UNION 은 순서를 보장하지 않아 ordinality 로 명시적으로 정렬한다 —
          --  순서가 흔들리면 화면에 뜨는 목록 순서가 저장할 때마다 바뀐다.)
          out := jsonb_set(out, array[k], (
            select coalesce(jsonb_agg(value order by ord), '[]'::jsonb)
              from (
                select distinct on (value) value, ord
                  from (
                    select value, ordinality as ord
                      from jsonb_array_elements(
                        case when jsonb_typeof(cur) = 'array' then cur else '[]'::jsonb end)
                        with ordinality as t(value, ordinality)
                    union all
                    select value, 1000000 + ordinality
                      from jsonb_array_elements(coalesce(v -> 'values', '[]'::jsonb))
                        with ordinality as t(value, ordinality)
                  ) all_vals
                 order by value, ord
              ) uniq
          ));
        when 'arrayRemove' then
          out := jsonb_set(out, array[k], (
            select coalesce(jsonb_agg(value), '[]'::jsonb)
              from jsonb_array_elements(
                case when jsonb_typeof(cur) = 'array' then cur else '[]'::jsonb end)
             where value not in (
               select value from jsonb_array_elements(coalesce(v -> 'values', '[]'::jsonb)))
          ));
        else
          raise exception '알 수 없는 연산: %', v ->> '__op' using errcode = '22023';
      end case;

    elsif jsonb_typeof(v) = 'object' and jsonb_typeof(cur) = 'object' then
      -- 중첩 객체는 재귀 병합 (Firestore merge 와 같은 동작).
      out := jsonb_set(out, array[k], public.apply_patch(cur, v));

    else
      -- 배열·스칼라·null 은 통째로 교체 (Firestore 도 배열은 교체한다).
      out := jsonb_set(out, array[k], v, true);
    end if;
  end loop;

  return out;
end;
$$;
comment on function public.apply_patch is 'Firestore setDoc(merge:true) 와 같은 병합 + increment/arrayUnion/arrayRemove/delete 원자 연산.';

-- 앱이 쓰는 테이블 화이트리스트. 동적 SQL 이므로 반드시 여기서 막는다.
create or replace function public.is_doc_table(p_table text) returns boolean
language sql immutable as $$
  select p_table = any (array[
    'users','visits','coupons','tables','sections','communications','tier_overrides',
    'menus','orders','reservations','photos','shifts','ingredients','expenses',
    'marketing_drafts','print_jobs','app_state'
  ])
$$;

-- 문서 하나를 만들거나 병합 저장한다. 없으면 insert, 있으면 data 병합.
-- RLS 는 그대로 적용된다(security invoker) — 남의 매장 문서는 여기서도 못 건드린다.
create or replace function public.save_doc(p_table text, p_id text, p_patch jsonb)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_doc_table(p_table) then
    raise exception '알 수 없는 테이블: %', p_table using errcode = '22023';
  end if;

  -- app_state 만 id 가 text 다(문서 이름이 키). 나머지는 uuid.
  if p_table = 'app_state' then
    execute format(
      'insert into public.%I (id, data) values ($1, public.apply_patch(''{}''::jsonb, $2))
         on conflict (id) do update set data = public.apply_patch(public.%I.data, $2)',
      p_table, p_table) using p_id, p_patch;
  else
    execute format(
      'insert into public.%I (id, data) values ($1::uuid, public.apply_patch(''{}''::jsonb, $2))
         on conflict (id) do update set data = public.apply_patch(public.%I.data, $2)',
      p_table, p_table) using p_id, p_patch;
  end if;
end;
$$;
comment on function public.save_doc is '부분 패치 병합 저장. 테이블 화이트리스트 + RLS 적용(security invoker).';

create or replace function public.delete_doc(p_table text, p_id text)
returns void
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_doc_table(p_table) then
    raise exception '알 수 없는 테이블: %', p_table using errcode = '22023';
  end if;
  if p_table = 'app_state' then
    execute format('delete from public.%I where id = $1', p_table) using p_id;
  else
    execute format('delete from public.%I where id = $1::uuid', p_table) using p_id;
  end if;
end;
$$;

revoke all on function public.apply_patch(jsonb, jsonb) from public, anon;
revoke all on function public.is_doc_table(text) from public, anon;
revoke all on function public.save_doc(text, text, jsonb) from public, anon;
revoke all on function public.delete_doc(text, text) from public, anon;
grant execute on function public.save_doc(text, text, jsonb) to authenticated;
grant execute on function public.delete_doc(text, text) to authenticated;
