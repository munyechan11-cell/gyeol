import { arrayUnion, clearOfflineQueue, saveDoc } from "../../lib/db";
import { deleteMyAccount, masterDeleteUser, masterLogin, masterSetPassword } from "../../lib/masterApi";
import { currentAuthUserId, signOut as supabaseSignOut } from "../../lib/phoneVerify";
import { fetchDoc } from "../../lib/realtime";
import type { StoreCore } from "../core";
import type { LoginInput } from "../types";
import { LS_MASTER, makeDefaultTables } from "../constants";
import { useCallback } from "react";
import { calculateAgeGroup } from "../../lib/auth";
import { normalizePhone } from "../../lib/ids";
import { showToast } from "../../lib/toast";
import { t } from "../../lib/i18n";
import type { User, Role } from "../../lib/types";

export function useAuthActions(core: StoreCore) {
  const {
    dbStatus, currentUser, masterPassword, setMasterPasswordState, setIsMaster, users,
    visits, setVisits, coupons, setCoupons, tables, setTables, sections, setSections,
    setCommunications, tierOverrides, setTierOverrides, menus, setMenus, orders, setOrders,
    reservations, setReservations, photos, setPhotos, shifts, setShifts, setIngredients,
    setExpenses, setMarketingDrafts, currentUserRef, setCurrentUser,
  } = core;


  // ============ LOGIN ============
  /**
   * 로그인 마무리 — **OTP 검증이 끝난 뒤** 호출한다.
   *
   * 예전에는 이 함수가 users 목록을 뒤져 전화번호가 맞는 계정을 찾아 로그인시켰다.
   * 비밀번호가 없었으므로 남의 번호만 알면 그 사람으로 들어갈 수 있었고, 목록을
   * 받으려면 전 계정을 읽어야 해서 보안 규칙도 열어둘 수밖에 없었다.
   *
   * 이제 순서가 반대다. 먼저 문자로 본인임을 증명하고(confirmCode), 그때 만들어진
   * auth 사용자 id 를 여기로 가져온다. 이 함수는 그 id 로 프로필 행을 찾거나 만든다.
   * 목록을 뒤지지 않으므로 남의 계정은 애초에 보이지 않는다.
   */
  const login = useCallback(
    async (input: LoginInput): Promise<User> => {
      if (dbStatus === "error") {
        throw new Error(t("db.unavailable"));
      }

      // 신원은 호출자가 알려주는 값이 아니라 **세션**에서 읽는다.
      // 화면마다 login() 호출부가 여러 개라 하나만 빠뜨려도 예전의 무비밀번호
      // 로그인이 되살아난다. 세션을 원천으로 삼으면 그 실수가 불가능해진다.
      const authUserId = input.authUserId ?? (await currentAuthUserId());
      if (!authUserId) {
        throw new Error(t("auth.otpRequired"));
      }

      const phone = normalizePhone(input.phone);
      const { role, name, restaurantName, storeId, socialId, socialProvider } = input;

      // 이미 프로필이 있는가 — 목록이 아니라 내 id 로 직접 조회한다.
      const existing = await fetchDoc<User>("users", authUserId);

      if (existing) {
        const patch: Partial<User> = {
          status: "active",
          name: existing.name || name,
        };
        if (phone && !existing.phone) patch.phone = phone;
        if (socialId && socialProvider) {
          patch.socialIds = arrayUnion(socialId) as unknown as string[];
          patch.linkedProviders = arrayUnion(socialProvider) as unknown as ("google" | "kakao" | "naver")[];
          if (socialProvider === "google") patch.googleId = socialId;
          if (socialProvider === "kakao") patch.kakaoId = socialId;
          if (input.avatarUrl) patch.avatarUrl = input.avatarUrl;
        }
        if (input.position !== undefined) patch.position = input.position;
        if (input.birthYear) {
          patch.birthYear = input.birthYear;
          patch.ageGroup = calculateAgeGroup(input.birthYear);
        }
        if (input.birthday) patch.birthday = input.birthday;
        if (input.gender) patch.gender = input.gender;
        if (input.isPohangResident !== undefined) patch.isPohangResident = input.isPohangResident;
        if (input.privacyAgreedAt) patch.privacyAgreedAt = input.privacyAgreedAt;
        // 전화번호 인증은 **실제로 인증했을 때만** 찍는다. 비밀번호·소셜 경로는 번호를
        // 증명한 적이 없다 — 여기서 지금 시각을 찍으면 그 값을 믿는 코드가 조용히 틀린다.
        if (input.phoneVerifiedAt) patch.phoneVerifiedAt = input.phoneVerifiedAt;

        await saveDoc("users", authUserId, patch);
        const final = { ...existing, ...patch } as User;
        setCurrentUser(final);
        showToast(t("store.welcome", undefined, { name: final.name }), "success");
        return final;
      }

      // 기존 계정이 있어야만 들어올 수 있는 화면(사장님·직원 로그인)
      if (input.signInOnly) {
        throw new Error(t("auth.noAccount"));
      }

      // 새 프로필 — id 는 auth 가 정한 것을 그대로 쓴다.
      const user: User = {
        id: authUserId,
        role,
        name,
        phone,
        status: "active",
        authType: input.authType ?? (socialProvider ? socialProvider : "phone"),
      };
      if (input.phoneVerifiedAt) user.phoneVerifiedAt = input.phoneVerifiedAt;
      if (input.position) user.position = input.position;
      if (role === "owner") {
        user.restaurantName = restaurantName;
        if (input.posVendor) user.posVendor = input.posVendor;
        if (input.posApiKey) user.posApiKey = input.posApiKey;
      }
      // 손님은 storeId 없이 전역 계정이다. 방문 기록이 visits 에 storeId 와 함께 남는다.
      void storeId;
      if (socialId && socialProvider) {
        user.socialIds = [socialId];
        user.linkedProviders = [socialProvider];
        if (socialProvider === "google") user.googleId = socialId;
        if (socialProvider === "kakao") user.kakaoId = socialId;
      }
      if (input.avatarUrl) user.avatarUrl = input.avatarUrl;
      if (input.birthYear) {
        user.birthYear = input.birthYear;
        user.ageGroup = calculateAgeGroup(input.birthYear);
      }
      if (input.birthday) user.birthday = input.birthday;
      if (input.gender) user.gender = input.gender;
      if (input.isPohangResident !== undefined) user.isPohangResident = input.isPohangResident;
      if (input.privacyAgreedAt) user.privacyAgreedAt = input.privacyAgreedAt;

      await saveDoc("users", authUserId, user);

      // 사장님 계정은 기본 테이블 15개를 함께 만든다.
      // 하나가 실패해도 나머지는 만들어 두는 편이 낫다 — 빈 배치보다 부분 배치가 낫고,
      // 부족한 테이블은 화면에서 추가할 수 있다.
      if (role === "owner") {
        const results = await Promise.allSettled(
          makeDefaultTables(authUserId).map((tbl) => saveDoc("tables", tbl.id, tbl))
        );
        const failed = results.filter((r) => r.status === "rejected").length;
        if (failed) console.error(`[create tables] ${failed}/${results.length} 실패`);
      }

      setCurrentUser(user);
      showToast(t("store.welcome", undefined, { name }), "success");
      return user;
    },
    [setCurrentUser, dbStatus]
  );

  const logout = useCallback(() => {
    // 세션을 반드시 파기한다. 메모리 상태만 비우면 토큰이 살아 있어서
    // RLS 상으로는 여전히 이전 사용자이고, 다음 사람이 그 권한으로 읽게 된다.
    void supabaseSignOut();
    // 큐는 localStorage 에 있어 세션보다 오래 산다. 비우지 않으면 다음 사람 권한으로 재전송된다.
    clearOfflineQueue();
    setCurrentUser(null);
    // 계정 전환 시 이전 매장 데이터가 다음 유저 화면에 잠깐 노출되지 않도록 scoped 상태를 비움.
    // (scoped 리스너는 currentUser=null 이면 early-return 하므로 자동으로는 비워지지 않음)
    setVisits([]);
    setCoupons([]);
    setTables([]);
    setSections([]);
    setCommunications([]);
    setTierOverrides([]);
    setMenus([]);
    setOrders([]);
    setReservations([]);
    setPhotos([]);
    setShifts([]);
    setIngredients([]);
    setExpenses([]);
    setMarketingDrafts([]);
    showToast(t("store.loggedOut"), "info");
  }, [setCurrentUser]);

  /**
   * 탈퇴 — 서버가 auth 사용자를 지운다. users 행만 '삭제됨'으로 표시하던 예전 방식은
   * auth 사용자가 남아 재로그인하면 빈 계정으로 되살아났고, 같은 번호로 재가입도 막혔다.
   * 관련 자료는 DB 외래키(cascade)가 함께 정리한다.
   */
  const deleteAccount = useCallback(async () => {
    if (!currentUser) return;
    await deleteMyAccount();
    logout();
  }, [currentUser, logout]);

  const setMasterPassword = useCallback(async (pw: string) => {
    await masterSetPassword(masterPassword, pw);
    setMasterPasswordState(pw);
    showToast(t("store.master.pwChanged"), "success");
  }, [masterPassword]);

  /** SMS 인증 완료 후 users 문서에 phoneVerifiedAt 마킹 + 인증한 번호 동기화. */
  const markPhoneVerified = useCallback(async (userId: string, e164Phone?: string) => {
    const patch: Partial<User> = {
      phoneVerifiedAt: new Date().toISOString(),
    };
    // 저장은 국내 표기("01012345678")로 통일한다. 화면·검색·문자 발송이 전부 이
    // 모양을 쓰므로, E.164 를 그대로 넣으면 그 계정만 어디서도 안 잡힌다.
    if (e164Phone) patch.phone = normalizePhone(e164Phone);
    // 예전에는 여기서 익명 토큰을 되살려야 했다 — 전화인증이 메인 세션을 파괴해서
    // 곧바로 쓰면 permission-denied 가 났다. 지금은 OTP 검증이 곧 로그인이라
    // 이 시점에 이미 세션이 있다. 되살릴 것이 없다.
    await saveDoc("users", userId, patch);
    // 로컬 currentUser 도 즉시 반영 — 안 하면 새로고침 시 인증 게이트가 다시 떠 재인증(SMS 비용) 발생
    const cu = currentUserRef.current;
    if (cu?.id === userId) setCurrentUser({ ...cu, ...patch });
  }, [setCurrentUser]);

  /**
   * 마스터 로그인 — 서버가 대조한다. 비밀번호는 서버만 알고, 화면은 입력값을 보내 확인한
   * 뒤 메모리에만 들고 있다가 이후 요청(목록·삭제·재설정)에 붙인다. 새로고침하면 다시 묻는다.
   */
  const loginMaster = useCallback(async (pw: string) => {
    try {
      await masterLogin(pw);
      setMasterPasswordState(pw);
      setIsMaster(true);
      showToast(t("store.master.loginOk"), "success");
      return true;
    } catch (e: any) {
      showToast(e?.message ?? t("store.master.pwWrong"), "error");
      return false;
    }
  }, []);

  const logoutMaster = useCallback(() => {
    setIsMaster(false);
    setMasterPasswordState("");
    localStorage.removeItem(LS_MASTER);
  }, []);

  /**
   * 마스터 화면의 계정 삭제 — 서버가 auth 사용자를 지운다.
   *
   * 클라이언트가 users 행을 지우는 방식은 두 가지가 안 됐다: (a) RLS 상 사장님 계정으로도
   * 다른 사장님 행을 못 지운다(그래야 한다), (b) auth 사용자가 남아 재로그인하면 되살아난다.
   * 서버가 auth.users 를 지우면 users.id 외래키 cascade 로 매장·손님 자료까지 정리된다.
   */
  const deleteUser = useCallback(
    async (userId: string, role: Role) => {
      await masterDeleteUser(masterPassword, userId, role);
      showToast(t("store.master.deleted"), "success");
    },
    [masterPassword]
  );

  return { login, logout, deleteAccount, setMasterPassword, markPhoneVerified, loginMaster, logoutMaster, deleteUser };
}
