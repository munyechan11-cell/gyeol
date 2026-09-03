import { useEffect } from "react";

import { flushOfflineQueue, saveDoc } from "../lib/db";
import { fetchDoc, subscribeTable } from "../lib/realtime";
import { isSupabaseConfigured, supabase } from "../lib/supabase";
import type {
  Communication, Coupon, Expense, Ingredient, MarketingDraft, Menu, Order, Photo,
  Reservation, Section, Shift, TableDoc, TierOverride, User, Visit,
} from "../lib/types";
import { LS_MASTER, LS_OFFLINE_STATE, LS_USER } from "./constants";
import type { StoreCore } from "./core";

/**
 * 실시간 구독 + 오프라인 캐시 미러링 + 부팅 복원.
 *
 * effect 등록 순서는 그대로 유지한다 (사장님 언어 동기화 → 오프라인 캐시 미러링 →
 * 부팅/계정 구독 → 로그인 스코프 구독 → 매장 컨텍스트 구독 → 직원 상태 재동기화).
 * 순서를 바꾸면 첫 데이터 도착 전에 ready 가 켜지는 부류의 회귀가 생긴다.
 */
export function useStoreSubscriptions(core: StoreCore) {
  const {
    isReady, setReady, dbStatus, setDbStatus, setDbError, currentUser,
    setCurrentUserState, setMasterPasswordState, setIsMaster, users, setUsers,
    visits, setVisits, coupons, setCoupons, tables, setTables, sections, setSections,
    communications, setCommunications, tierOverrides, setTierOverrides, menus, setMenus, orders,
    setOrders, reservations, setReservations, photos, setPhotos, setShifts, ingredients,
    setIngredients, expenses, setExpenses, setMarketingDrafts, scopedUnsubsRef,
    storeContextUnsubsRef, activeStoreId, currentUserRef, lang, setCurrentUser,
  } = core;

  useEffect(() => {
    const cu = currentUserRef.current;
    if (cu?.role === "owner" && cu.lang !== lang) {
      saveDoc("users", cu.id, { lang }).catch(() => {});
    }
  }, [lang, currentUser]);

  // 오프라인 폴백용 캐시 미러링
  useEffect(() => {
    if (!isReady) return;
    if (dbStatus !== "offline") return;
    // 로그아웃/미로그인 상태에서는 미러링하지 않는다. logout() 이 메모리 상태를 [] 로 비우는데,
    // 그 빈 배열로 캐시를 덮어쓰면 오프라인 데이터(매장·메뉴·주문)가 영구 소실된다.
    if (!currentUser) return;
    // 디바운스(1s) — 연달아 오는 델타마다 직렬화하지 않도록 마지막 1회만.
    const id = setTimeout(() => {
      localStorage.setItem(
        LS_OFFLINE_STATE,
        JSON.stringify({
          users, visits, coupons, tables, sections, communications, tierOverrides,
          menus, orders, reservations, photos, ingredients, expenses,
        })
      );
    }, 1000);
    return () => clearTimeout(id);
  }, [
    dbStatus, isReady, currentUser, users, visits, coupons, tables, sections,
    communications, tierOverrides, menus, orders, reservations, photos, ingredients, expenses,
  ]);

  // 부팅 — 저장된 세션 복원 + 계정 구독
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_USER);
      if (raw) setCurrentUserState(JSON.parse(raw));
      if (localStorage.getItem(LS_MASTER) === "1") setIsMaster(true);
    } catch {
      // 손상된 캐시 — 로그인 화면부터 다시.
    }

    if (!isSupabaseConfigured) {
      try {
        const raw = localStorage.getItem(LS_OFFLINE_STATE);
        if (raw) {
          const s = JSON.parse(raw);
          setUsers(s.users ?? []);
          setVisits(s.visits ?? []);
          setCoupons(s.coupons ?? []);
          setTables(s.tables ?? []);
          setSections(s.sections ?? []);
          setCommunications(s.communications ?? []);
          setTierOverrides(s.tierOverrides ?? []);
          setMenus(s.menus ?? []);
          setOrders(s.orders ?? []);
          setReservations(s.reservations ?? []);
          setPhotos(s.photos ?? []);
          setIngredients(s.ingredients ?? []);
          setExpenses(s.expenses ?? []);
        }
      } catch {
        // 캐시가 깨졌으면 빈 상태로 시작한다.
      }
      setDbStatus("offline");
      setReady(true);
      return;
    }

    setDbStatus("ok");
    flushOfflineQueue();

    let cancelled = false;
    let unsubUsers: (() => void) | null = null;
    let readyFallback: ReturnType<typeof setTimeout> | null = null;
    // 첫 조회·에러·타임아웃 중 무엇이든 하나만 ready 를 결정하도록 하는 래치.
    let settled = false;

    const settle = () => {
      if (settled) return;
      settled = true;
      if (readyFallback) clearTimeout(readyFallback);
      setReady(true);
    };

    /**
     * 계정 구독.
     *
     * ⚠️ RLS 때문에 예전과 범위가 다르다. 손님은 자기 행만, 사장·직원은 매장 사람들을 본다.
     *    Firestore 시절엔 로그인 매칭을 하려고 전 계정을 내려받았는데, 그게 바로
     *    "익명 로그인만 하면 전 매장 개인정보를 읽는" 구멍이었다. 이제 로그인은
     *    전화번호 OTP 로 하고, 목록을 뒤지지 않는다.
     */
    const start = () => {
      if (cancelled) return;
      unsubUsers?.();
      unsubUsers = subscribeTable<User>("users", setUsers, {
        onReady: settle,
        onError: (e) => {
          setDbError((e as Error)?.message ?? String(e));
          setDbStatus("error");
          // 에러여도 ready 는 켠다 — 안 켜면 로더에 영구히 갇혀 원인조차 볼 수 없다.
          settle();
        },
      });
    };

    supabase.auth.getSession().then(() => start());

    // 로그인·로그아웃·토큰 갱신 시 구독을 다시 건다. RLS 결과가 세션에 따라 달라지므로
    // 세션이 바뀌면 구독도 다시 걸어야 한다.
    const { data: authSub } = supabase.auth.onAuthStateChange(() => start());

    // 응답도 에러도 오지 않는 경우(네트워크 블랙홀·프록시 차단) 대비 안전망.
    // 로더에서 멈추는 것보다는 연결 실패 배너와 함께 앱을 띄우는 편이 낫다.
    // settled 를 반드시 봐야 한다 — 안 그러면 정상 세션도 8초 뒤 error 로 뒤집힌다.
    readyFallback = setTimeout(() => {
      if (settled) return;
      console.error("[users] 8초 내 응답 없음 — 연결 실패로 처리");
      setDbError("users 구독 응답 없음 (timeout)");
      setDbStatus("error");
      settle();
    }, 8000);

    // 마스터 비밀번호 — 한 번만 읽는다.
    fetchDoc<{ masterPassword?: string }>("app_state", "settings").then((s) => {
      if (!cancelled && s?.masterPassword) setMasterPasswordState(s.masterPassword);
    });

    return () => {
      cancelled = true;
      if (readyFallback) clearTimeout(readyFallback);
      unsubUsers?.();
      authSub.subscription.unsubscribe();
    };
  }, []);

  // 역할별 스코프 구독
  useEffect(() => {
    scopedUnsubsRef.current.forEach((u) => u());
    scopedUnsubsRef.current = [];
    if (!isSupabaseConfigured || !currentUser) return;

    const sub = <T,>(
      table: string,
      setter: (rows: T[]) => void,
      column: string,
      value: string
    ) => {
      scopedUnsubsRef.current.push(subscribeTable<T>(table, setter, { column, value }));
    };

    if (currentUser.role === "owner") {
      const sid = currentUser.id;
      sub<Visit>("visits", setVisits, "storeId", sid);
      sub<Coupon>("coupons", setCoupons, "storeId", sid);
      sub<TableDoc>("tables", setTables, "storeId", sid);
      sub<Section>("sections", setSections, "storeId", sid);
      sub<Communication>("communications", setCommunications, "storeId", sid);
      sub<TierOverride>("tier_overrides", setTierOverrides, "storeId", sid);
      sub<Menu>("menus", setMenus, "storeId", sid);
      sub<Order>("orders", setOrders, "storeId", sid);
      sub<Reservation>("reservations", setReservations, "storeId", sid);
      sub<Photo>("photos", setPhotos, "storeId", sid);
      sub<Shift>("shifts", setShifts, "storeId", sid);
      sub<Ingredient>("ingredients", setIngredients, "storeId", sid);
      sub<Expense>("expenses", setExpenses, "storeId", sid);
      sub<MarketingDraft>("marketing_drafts", setMarketingDrafts, "storeId", sid);
    } else if (currentUser.role === "staff") {
      const sid = currentUser.employerStoreId;
      // 본인 근무 기록은 승인 전에도 구독 (승인 전이면 RLS 가 걸러 빈 배열)
      sub<Shift>("shifts", setShifts, "staffId", currentUser.id);
      if (sid && currentUser.employerStatus === "approved") {
        sub<TableDoc>("tables", setTables, "storeId", sid);
        sub<Section>("sections", setSections, "storeId", sid);
        sub<Menu>("menus", setMenus, "storeId", sid);
        sub<Order>("orders", setOrders, "storeId", sid);
        sub<Reservation>("reservations", setReservations, "storeId", sid);
        sub<Photo>("photos", setPhotos, "storeId", sid);
        sub<Ingredient>("ingredients", setIngredients, "storeId", sid);
      } else {
        setTables([]);
        setSections([]);
        setMenus([]);
        setOrders([]);
        setReservations([]);
        setPhotos([]);
        setIngredients([]);
      }
    } else {
      // 손님 — 매장과 무관하게 본인 데이터만
      const cid = currentUser.id;
      sub<Visit>("visits", setVisits, "customerId", cid);
      sub<Coupon>("coupons", setCoupons, "customerId", cid);
      sub<Communication>("communications", setCommunications, "customerId", cid);
      sub<TierOverride>("tier_overrides", setTierOverrides, "customerId", cid);
    }

    return () => {
      scopedUnsubsRef.current.forEach((u) => u());
      scopedUnsubsRef.current = [];
    };
  }, [
    currentUser?.id, currentUser?.role,
    currentUser?.employerStoreId, currentUser?.employerStatus,
  ]);

  // 손님이 매장에 진입했을 때 그 매장의 tables/menus/orders/photos 구독
  useEffect(() => {
    storeContextUnsubsRef.current.forEach((u) => u());
    storeContextUnsubsRef.current = [];
    if (!isSupabaseConfigured || !currentUser || currentUser.role !== "customer" || !activeStoreId) {
      // 매장 컨텍스트를 벗어나면 메모리에서 비운다.
      if (currentUser?.role === "customer") {
        setTables([]);
        setMenus([]);
        setOrders([]);
        setPhotos([]);
      }
      return;
    }

    const sub = <T,>(
      table: string,
      setter: (rows: T[]) => void,
      column = "storeId",
      value: string = activeStoreId
    ) => {
      storeContextUnsubsRef.current.push(subscribeTable<T>(table, setter, { column, value }));
    };

    sub<TableDoc>("tables", setTables);
    sub<Menu>("menus", setMenus);
    // 손님 화면은 본인 주문만 쓴다. 매장 전체 주문을 받으면 읽기 낭비이자 남의 주문 노출이다.
    sub<Order>("orders", setOrders, "customerId", currentUser.id);
    sub<Photo>("photos", setPhotos);

    return () => {
      storeContextUnsubsRef.current.forEach((u) => u());
      storeContextUnsubsRef.current = [];
    };
  }, [activeStoreId, currentUser?.id, currentUser?.role]);

  // 사장이 원격으로 바꾼 직원의 등급·권한·승인 상태를 실행 중인 직원 세션에 반영한다.
  // users 배열만 갱신하고 currentUser 를 그대로 두면, 재로그인 전까지
  // (a) 강등돼도 옛 권한이 살아 있고 (b) 승인돼도 Pending 에 묶여 구독이 시작되지 않는다.
  useEffect(() => {
    if (currentUser?.role !== "staff") return; // 직원 세션만 — 사장/손님 낙관적 패치와 충돌 방지
    const fresh = users.find((u) => u.id === currentUser.id);
    if (!fresh) return;
    const changed =
      fresh.staffLevel !== currentUser.staffLevel ||
      fresh.employerStatus !== currentUser.employerStatus ||
      fresh.employerStoreId !== currentUser.employerStoreId ||
      fresh.position !== currentUser.position ||
      fresh.hourlyWage !== currentUser.hourlyWage ||
      fresh.status !== currentUser.status ||
      JSON.stringify(fresh.extraPerms ?? []) !== JSON.stringify(currentUser.extraPerms ?? []);
    if (!changed) return; // 실제 변경이 있을 때만 set — 무한 루프 방지
    setCurrentUser({
      ...currentUser,
      staffLevel: fresh.staffLevel,
      extraPerms: fresh.extraPerms,
      employerStatus: fresh.employerStatus,
      employerStoreId: fresh.employerStoreId,
      position: fresh.position,
      hourlyWage: fresh.hourlyWage,
      status: fresh.status,
    });
  }, [users, currentUser, setCurrentUser]);
}
