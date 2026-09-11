-- ============================================================
-- 기기 세션 — 영수증 프린터 브릿지.
--
-- 문제: 프린터에 붙은 트레이 앱은 사람이 아니다. public.users 에 행이 없으니
-- my_store_id() 가 null 을 주고, 그러면 print_jobs 를 한 줄도 못 읽는다.
--
-- 안 되는 해결: 기기용 users 행을 만들어 직원으로 승인하는 것. 그 순간 프린터가
-- 매출·손님·예약까지 전부 읽게 된다. 프린터는 인쇄 큐만 보면 된다.
--
-- 하는 것: 기기 계정의 app_metadata 에 storeId 를 박고, **print_jobs 정책에서만**
-- 그 값을 인정한다. app_metadata 는 service_role 만 쓸 수 있어 위조가 불가능하다
-- (user_metadata 와 다르다 — 그쪽은 사용자가 스스로 바꿀 수 있어 신뢰하면 안 된다).
-- ============================================================

create or replace function public.my_device_store_id() returns uuid
language sql stable as $$
  select case
           when auth.jwt() -> 'app_metadata' ->> 'device' = 'printbridge'
             then nullif(auth.jwt() -> 'app_metadata' ->> 'storeId', '')::uuid
           else null
         end
$$;
comment on function public.my_device_store_id is
  '영수증 브릿지 기기의 매장 id. print_jobs 정책에서만 쓴다 — 다른 테이블에는 쓰지 말 것.';

revoke all on function public.my_device_store_id() from public, anon;
grant execute on function public.my_device_store_id() to authenticated;

-- print_jobs 만 기기를 인정한다. 읽기와 갱신(인쇄 완료 표시)까지만 —
-- 기기가 인쇄 작업을 새로 만들거나 지울 이유는 없다.
drop policy if exists "print_jobs_read" on public.print_jobs;
create policy "print_jobs_read" on public.print_jobs for select to authenticated
  using ("storeId" = public.my_store_id() or "storeId" = public.my_device_store_id());

drop policy if exists "print_jobs_update" on public.print_jobs;
create policy "print_jobs_update" on public.print_jobs for update to authenticated
  using ("storeId" = public.my_store_id() or "storeId" = public.my_device_store_id())
  with check ("storeId" = public.my_store_id() or "storeId" = public.my_device_store_id());
