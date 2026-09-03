import { newId, saveDoc } from "../../lib/db";
import type { StoreCore } from "../core";
import { useCallback, useMemo } from "react";
import { showToast } from "../../lib/toast";
import { t } from "../../lib/i18n";
import { sendOwnerPush } from "../../lib/pushTriggers";
import type { User, StaffLevel, Shift } from "../../lib/types";

export function useStaffActions(core: StoreCore) {
  const {
    currentUser, users, shifts, usersRef, currentUserRef, clockingRef, lang, setCurrentUser,
  } = core;


  const setStaffWage = useCallback(async (userId: string, hourlyWage: number) => {
    await saveDoc("users", userId, { hourlyWage });
  }, []);

  const setStaffLevel = useCallback(async (userId: string, level: StaffLevel) => {
    await saveDoc("users", userId, { staffLevel: level });
  }, []);
  const setStaffPerms = useCallback(async (userId: string, perms: string[]) => {
    await saveDoc("users", userId, { extraPerms: perms });
  }, []);


  // ============ STAFF MEMBERSHIP & SHIFTS ============
  const requestJoinStore = useCallback(
    async (storeId: string, position?: string) => {
      const cu = currentUserRef.current;
      if (!cu || cu.role !== "staff") return;
      const patch: Partial<User> = {
        employerStoreId: storeId,
        employerStatus: "pending",
        joinRequestedAt: new Date().toISOString(),
      };
      if (position !== undefined) patch.position = position;
      await saveDoc("users", cu.id, patch);
      setCurrentUser({ ...cu, ...patch });
      // 사장님 디바이스 푸시 — 새 직원 가입 요청
      const ownerLang = usersRef.current.find((u) => u.id === storeId)?.lang ?? "ko";
      const staffName = cu.name ?? t("gnotif.staffJoin.nameFallback", ownerLang);
      const positionStr = position ? ` (${position})` : "";
      sendOwnerPush({
        storeId,
        kind: "staff-join",
        title: t("gnotif.staffJoin.title", ownerLang),
        body: t("gnotif.staffJoin.body", ownerLang, { name: staffName, position: positionStr }),
        focusUrl: "/biz/owner/staff",
        tag: "gyeol-staff",
      });
      showToast(t("store.staff.joinRequested"), "success");
    },
    [setCurrentUser]
  );

  const cancelJoinRequest = useCallback(async () => {
    const cu = currentUserRef.current;
    if (!cu || cu.role !== "staff") return;
    // null로 저장해 필드를 명시적으로 비웁니다 (stripUndefined가 undefined를 제거하므로)
    await saveDoc("users", cu.id, {
      employerStoreId: null,
      employerStatus: null,
      joinRequestedAt: null,
    });
    setCurrentUser({
      ...cu,
      employerStoreId: undefined,
      employerStatus: undefined,
      joinRequestedAt: undefined,
    });
    showToast(t("store.staff.joinCancelled"), "info");
  }, [setCurrentUser]);

  const approveStaff = useCallback(async (staffId: string) => {
    await saveDoc("users", staffId, { employerStatus: "approved" });
    showToast(t("store.staff.approved"), "success");
  }, []);

  const rejectStaff = useCallback(async (staffId: string) => {
    await saveDoc("users", staffId, {
      employerStatus: "rejected",
    });
    showToast(t("store.staff.rejected"), "info");
  }, []);

  const removeStaffMembership = useCallback(async (staffId: string) => {
    await saveDoc("users", staffId, {
      employerStoreId: null,
      employerStatus: null,
      position: null,
    });
    showToast(t("store.staff.removed"), "info");
  }, []);

  const clockIn = useCallback(async () => {
    const cu = currentUserRef.current;
    if (!cu || cu.role !== "staff" || !cu.employerStoreId || cu.employerStatus !== "approved") {
      showToast(t("store.staff.cannotClockIn"), "error");
      return;
    }
    if (clockingRef.current) return; // 진행 중이면 무시 (연타 방어)
    // 이미 진행 중인 근무가 있으면 무시
    const open = shifts.find((s) => s.staffId === cu.id && !s.clockOutAt);
    if (open) {
      showToast(t("store.staff.alreadyOn"), "info");
      return;
    }
    clockingRef.current = true;
    try {
      const id = newId();
      const s: Shift = {
        id,
        staffId: cu.id,
        storeId: cu.employerStoreId,
        clockInAt: new Date().toISOString(),
        clockOutAt: null,
      };
      await saveDoc("shifts", id, s);
      showToast(t("store.staff.clockInOk"), "success");
    } finally {
      clockingRef.current = false;
    }
  }, [shifts]);

  const clockOut = useCallback(async () => {
    const cu = currentUserRef.current;
    if (!cu || cu.role !== "staff") return;
    if (clockingRef.current) return; // 진행 중이면 무시 (연타 방어)
    const open = shifts.find((s) => s.staffId === cu.id && !s.clockOutAt);
    if (!open) {
      showToast(t("store.staff.noShift"), "info");
      return;
    }
    clockingRef.current = true;
    try {
      await saveDoc("shifts", open.id, {
        clockOutAt: new Date().toISOString(),
      });
      showToast(t("store.staff.clockOutOk"), "success");
    } finally {
      clockingRef.current = false;
    }
  }, [shifts]);

  // 현재 사용자 기준 진행 중 근무
  const activeShift = useMemo(() => {
    if (!currentUser || currentUser.role !== "staff") return null;
    return shifts.find((s) => s.staffId === currentUser.id && !s.clockOutAt) ?? null;
  }, [shifts, currentUser]);

  return { setStaffWage, setStaffLevel, setStaffPerms, requestJoinStore, cancelJoinRequest, approveStaff, rejectStaff, removeStaffMembership, clockIn, clockOut, activeShift };
}
