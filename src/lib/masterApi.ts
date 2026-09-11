import { api, authHeaders } from "./api";
import { t } from "./i18n";
import type { Role, User } from "./types";

/**
 * 마스터 화면의 서버 API.
 *
 * 마스터 비밀번호는 서버만 안다(app_secrets 또는 MASTER_PASSWORD). 예전엔 클라이언트가
 * 그 값을 읽어 입력과 비교했는데, 그러면 로그인한 누구나 읽을 수 있었다. 이제 화면은
 * 입력받은 비밀번호를 **보내기만** 하고, 목록·삭제·재설정은 서버가 service_role 로 한다.
 */

const masterHeaders = (pw: string): Record<string, string> => ({
  "content-type": "application/json",
  "x-master-password": pw,
});

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(api(path), init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) throw new Error(t("store.master.pwWrong"));
    if (res.status === 503) throw new Error(t("store.master.notConfigured"));
    if (res.status === 429) throw new Error(body?.error ?? "too many attempts");
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

/** 비밀번호가 맞는가. 맞으면 그 값을 메모리에 들고 이후 요청에 붙인다. */
export async function masterLogin(pw: string): Promise<void> {
  await call("/api/master/login", { method: "POST", headers: masterHeaders(pw) });
}

export async function masterSetPassword(currentPw: string, newPw: string): Promise<void> {
  await call("/api/master/password", {
    method: "POST",
    headers: masterHeaders(currentPw),
    body: JSON.stringify({ newPassword: newPw }),
  });
}

export type MasterUser = Pick<
  User,
  "id" | "role" | "name" | "phone" | "restaurantName" | "status" | "authType" | "employerStoreId" | "employerStatus" | "position"
>;

export async function masterListUsers(pw: string): Promise<MasterUser[]> {
  const r = await call<{ users: MasterUser[] }>("/api/master/users", { method: "GET", headers: masterHeaders(pw) });
  return r.users ?? [];
}

export async function masterDeleteUser(pw: string, userId: string, _role: Role): Promise<void> {
  await call("/api/master/delete-user", {
    method: "POST",
    headers: masterHeaders(pw),
    body: JSON.stringify({ userId }),
  });
}

/** 본인 탈퇴 — auth 사용자까지 지운다(관련 자료는 DB 외래키가 함께 정리). */
export async function deleteMyAccount(): Promise<void> {
  const res = await fetch(api("/api/auth/delete-account"), {
    method: "POST",
    headers: await authHeaders({ "content-type": "application/json" }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? t("fs.saveError"));
  }
}
