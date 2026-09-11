-- ============================================================
-- 실시간 구독 — Firestore onSnapshot 의 자리.
--
-- RLS 가 그대로 적용되므로, 남의 매장 행이 바뀌어도 그 이벤트는 구독자에게 가지 않는다.
-- 서버 전용 3종(store_secrets·pairing_codes·merchant_map)은 클라이언트가 구독할 이유가
-- 없으므로 넣지 않는다.
-- ============================================================
alter publication supabase_realtime add table public.users;
alter publication supabase_realtime add table public.visits;
alter publication supabase_realtime add table public.coupons;
alter publication supabase_realtime add table public.tables;
alter publication supabase_realtime add table public.sections;
alter publication supabase_realtime add table public.communications;
alter publication supabase_realtime add table public.tier_overrides;
alter publication supabase_realtime add table public.menus;
alter publication supabase_realtime add table public.orders;
alter publication supabase_realtime add table public.reservations;
alter publication supabase_realtime add table public.photos;
alter publication supabase_realtime add table public.shifts;
alter publication supabase_realtime add table public.ingredients;
alter publication supabase_realtime add table public.expenses;
alter publication supabase_realtime add table public.marketing_drafts;
alter publication supabase_realtime add table public.print_jobs;
alter publication supabase_realtime add table public.app_state;

-- ⚠️ DELETE 이벤트는 기본적으로 기본키만 담아 보낸다(REPLICA IDENTITY DEFAULT).
--    그런데 구독은 `storeId=eq.<내 매장>` 으로 필터를 거는데, 지워진 행의 storeId 를
--    모르면 그 필터에 걸러져 **삭제 이벤트가 아예 오지 않는다** — 화면에서 사라져야 할
--    항목이 그대로 남는다. FULL 로 두면 지워진 행 전체가 실려 필터가 정상 동작한다.
alter table public.visits           replica identity full;
alter table public.coupons          replica identity full;
alter table public.tables           replica identity full;
alter table public.sections         replica identity full;
alter table public.communications   replica identity full;
alter table public.tier_overrides   replica identity full;
alter table public.menus            replica identity full;
alter table public.orders           replica identity full;
alter table public.reservations     replica identity full;
alter table public.photos           replica identity full;
alter table public.shifts           replica identity full;
alter table public.ingredients      replica identity full;
alter table public.expenses         replica identity full;
alter table public.marketing_drafts replica identity full;
alter table public.print_jobs       replica identity full;
alter table public.users            replica identity full;
