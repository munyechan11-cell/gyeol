import admin from 'firebase-admin';


// Lazy initialize Firebase Admin
let adminApp: admin.app.App | null = null;

export function getFirebaseAdmin() {
  if (!adminApp) {
    if (admin.apps.length > 0) {
      adminApp = admin.app();
      return adminApp;
    }

    // 우선순위 1: FIREBASE_SERVICE_ACCOUNT_BASE64 (전체 JSON 을 base64 로 인코딩한 단일 값)
    // Render UI 가 PEM 멀티라인을 자동 줄바꿈으로 망가뜨리는 사고를 100% 회피.
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();
    if (b64) {
      try {
        const decoded = Buffer.from(b64, 'base64').toString('utf-8');
        const sa = JSON.parse(decoded);
        adminApp = admin.initializeApp({
          credential: admin.credential.cert({
            projectId: sa.project_id,
            clientEmail: sa.client_email,
            privateKey: sa.private_key,
          }),
        });
        console.log('[Firebase Admin] initialized via FIREBASE_SERVICE_ACCOUNT_BASE64');
        return adminApp;
      } catch (e: any) {
        console.error('[Firebase Admin] base64 decode failed —', e?.message ?? e);
        // fallthrough → 개별 환경변수 시도
      }
    }

    // 우선순위 2: 개별 환경변수 (기존 호환)
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim();
    // PRIVATE_KEY 입력 사고 전수 정상화:
    //  · 양끝 따옴표·쉼표·공백
    //  · '\n' 리터럴 / 실제 줄바꿈 / CRLF 혼재
    //  · UI 에서 자동 줄바꿈된 PEM
    // → BEGIN/END 사이의 모든 공백을 제거 후 64자 라인으로 표준 PEM 재조립
    let privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (privateKey) {
      privateKey = privateKey.trim();
      // 양끝 따옴표·쉼표 strip
      if (/^["'].*["']\s*,?\s*$/s.test(privateKey)) {
        privateKey = privateKey.replace(/^["']/, '').replace(/["']\s*,?\s*$/, '');
      }
      // '\n' 리터럴 → 실제 줄바꿈, CRLF 통일
      privateKey = privateKey.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');

      // PEM 표준 재조립 — 어떤 형태로 들어왔든 BEGIN/END 사이를 정규화
      const m = privateKey.match(/-----BEGIN[^-]*PRIVATE KEY-----([\s\S]*?)-----END[^-]*PRIVATE KEY-----/);
      if (m) {
        const header = privateKey.match(/-----BEGIN[^-]*PRIVATE KEY-----/)?.[0] ?? '-----BEGIN PRIVATE KEY-----';
        const footer = privateKey.match(/-----END[^-]*PRIVATE KEY-----/)?.[0] ?? '-----END PRIVATE KEY-----';
        const body = m[1].replace(/[\s\\]+/g, '');           // 공백·백슬래시 전부 제거
        const lines = body.match(/.{1,64}/g) ?? [];          // 64자 라인으로 분할
        privateKey = `${header}\n${lines.join('\n')}\n${footer}\n`;
      }
    }
    
    if (projectId && clientEmail && privateKey) {
      adminApp = admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey })
      });
    } else {
      console.warn('Firebase Admin SDK credentials missing. Custom token generation will fail.');
    }
  }
  return adminApp;
}
