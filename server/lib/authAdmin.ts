import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseAdmin } from './db.js';

/**
 * 서버가 Supabase 세션을 발급하는 통로.
 *
 * Firebase 때는 `auth().createCustomToken(uid)` 한 줄이면 됐다. Supabase 에는
 * 그에 정확히 대응하는 API 가 없다 — 대신 admin 이 매직링크를 "발송하지 않고
 * 생성"할 수 있고, 그때 나오는 `hashed_token` 을 클라이언트가
 * `verifyOtp({ token_hash, type: 'magiclink' })` 로 교환하면 세션이 된다.
 * 커스텀 토큰과 성질이 같다: 서버만 만들 수 있고, 1회용이고, 짧게 산다.
 *
 * **왜 이게 필요한가** — 로그인 경로가 전화번호 OTP 하나뿐이면 카카오·네이버
 * 버튼이 죽는다. 그렇다고 소셜 로그인을 세션 없이 통과시키면 예전 구멍
 * (전화번호만 알면 남의 계정으로 들어가던 그 구멍)이 다른 문으로 되살아난다.
 * 서버가 공급자에게 직접 확인한 뒤에만 세션을 만들어 준다.
 *
 * ⚠️ **합성 이메일을 쓴다.** 카카오가 알려준 진짜 이메일을 auth 계정 키로 쓰면,
 *    남의 이메일로 소셜 계정을 만들어 그 사람 계정을 가져갈 수 있다. 공급자와
 *    공급자측 id 를 합쳐 만든 주소만 키로 쓰고, 진짜 이메일은 메타데이터에만 둔다.
 */

export type SocialProvider = 'kakao' | 'naver' | 'google';

export interface SocialIdentity {
  provider: SocialProvider;
  /** 공급자가 부여한 id. 서버가 공급자에게 직접 물어서 얻은 값이어야 한다. */
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

/** 기기 계정(영수증 브릿지 등)까지 포함한 계정 키. auth.users.email 로 들어간다. */
export function identityEmail(kind: string, id: string): string {
  // 로컬 파트에 들어갈 수 없는 문자를 제거한다 — 공급자 id 는 보통 숫자지만
  // 가정하지 않는다. 잘린 값이 서로 충돌하지 않도록 길이도 넉넉히 남긴다.
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  if (!safe) throw new Error('bad identity id');
  return `${kind}_${safe}@identity.gyeol.app`;
}

async function ensureUser(
  sb: SupabaseClient,
  email: string,
  metadata: Record<string, unknown>,
  appMetadata?: Record<string, unknown>
): Promise<void> {
  const { error } = await sb.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: metadata,
    ...(appMetadata ? { app_metadata: appMetadata } : {}),
  });
  if (!error) return;
  // 이미 있는 계정이면 그대로 쓴다. 문구가 버전마다 달라 코드도 같이 본다.
  const msg = `${(error as any)?.code ?? ''} ${error.message ?? ''}`.toLowerCase();
  if (msg.includes('already') || msg.includes('registered') || msg.includes('exists')) return;
  throw error;
}

export interface MintedSession {
  /** 클라이언트가 verifyOtp({ token_hash, type: 'magiclink' }) 로 교환한다. */
  tokenHash: string;
  /** 만들어진(또는 찾은) auth 사용자 id. public.users 행의 id 와 같은 값이 된다. */
  userId: string;
}

/** 소셜 신원 → 1회용 세션 토큰. 공급자 검증이 **끝난 뒤에만** 부른다. */
export async function mintSocialSession(identity: SocialIdentity): Promise<MintedSession> {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error('DB_NOT_CONFIGURED');

  const email = identityEmail(identity.provider, identity.id);
  await ensureUser(sb, email, {
    provider: identity.provider,
    providerId: identity.id,
    name: identity.name ?? null,
    // 진짜 이메일은 참고용으로만 둔다 — 계정 키가 아니다.
    providerEmail: identity.email ?? null,
    avatarUrl: identity.avatarUrl ?? null,
  });

  return generateTokenHash(sb, email);
}

/**
 * 기기 계정용 세션. 사람이 아니라 장비(영수증 프린터 브릿지)가 쓴다.
 *
 * `app_metadata` 는 service_role 만 쓸 수 있어 위조가 불가능하다. 그래서
 * 여기에 박은 storeId 를 RLS 가 신뢰할 수 있다(my_device_store_id 참고).
 * 사람 계정과 달리 public.users 행을 만들지 않는다 — 만들면 그 순간 매장의
 * 모든 테이블에 접근하게 된다. 기기는 print_jobs 만 보면 된다.
 */
export async function mintDeviceSession(
  kind: 'printbridge',
  deviceKey: string,
  storeId: string
): Promise<MintedSession> {
  const sb = getSupabaseAdmin();
  if (!sb) throw new Error('DB_NOT_CONFIGURED');

  const email = identityEmail(kind, deviceKey);
  await ensureUser(
    sb,
    email,
    { device: kind },
    { device: kind, storeId }
  );
  const minted = await generateTokenHash(sb, email);
  // 이미 있던 기기 계정이면 storeId 가 옛것일 수 있다 — 페어링할 때마다 맞춘다.
  // (매장을 옮겨 단 프린터가 옛 매장 주문을 계속 받는 일을 막는다.)
  await sb.auth.admin.updateUserById(minted.userId, {
    app_metadata: { device: kind, storeId },
  });
  return minted;
}

async function generateTokenHash(sb: SupabaseClient, email: string): Promise<MintedSession> {
  const { data, error } = await sb.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const tokenHash = data?.properties?.hashed_token;
  const userId = data?.user?.id;
  if (!tokenHash || !userId) throw new Error('세션 토큰 발급 실패');
  return { tokenHash, userId };
}
