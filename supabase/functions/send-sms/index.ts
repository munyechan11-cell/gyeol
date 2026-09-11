// ============================================================
// Supabase Auth — Send SMS Hook (알리고)
//
// Supabase 는 전화번호 OTP 를 스스로 보내지 못한다. 통신사 계정이 필요하고,
// 그건 프로젝트마다 다르기 때문이다. 대신 "문자를 보낼 때가 됐다"는 순간에
// 이 함수를 부른다. 여기서 알리고로 실제 발송한다.
//
// 흐름:
//   앱 signInWithOtp(phone)
//     → Supabase 가 OTP 생성·저장
//     → 이 함수 호출 { user, sms: { otp } }
//     → 알리고 발송
//     → 앱 verifyOtp(phone, code) → 세션
//
// ⚠️ **실패를 성공으로 보고하면 안 된다.** 200 을 돌려주면 Supabase 는 문자가
//    갔다고 보고 아무 안내도 하지 않는다. 사용자는 오지 않는 문자를 기다린다.
//    알리고가 거절하면 그대로 5xx 를 돌려준다.
//
// 배포:
//   supabase functions deploy send-sms --no-verify-jwt --project-ref <ref>
//   supabase secrets set ALIGO_API_KEY=... ALIGO_USER_ID=... ALIGO_SENDER=... \
//                        SEND_SMS_HOOK_SECRETS=v1,whsec_...
//   그리고 대시보드 Authentication → Hooks → Send SMS 에서 이 함수를 지정한다.
//
//   --no-verify-jwt 를 쓰는 이유: 이 함수를 부르는 건 로그인한 사용자가 아니라
//   Auth 서버다. JWT 가 없다. 대신 아래 서명 검증이 인증을 대신한다.
// ============================================================

import { toDomestic, verifySignature } from './lib.ts';

const ALIGO_ENDPOINT = 'https://apis.aligo.in/send/';

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const rawBody = await req.text();

  // Supabase 문서가 쓰는 이름은 **복수형**(SEND_SMS_HOOK_SECRETS)이다.
  // 나중에 키 교체를 위해 여러 개를 담을 수 있게 하려고 그렇게 정해져 있다.
  // 문서를 보고 복수형으로 넣었는데 함수가 단수형만 읽으면, 시크릿을 제대로
  // 넣고도 "설정 안 됨"으로 죽는다 — 찾기 어려운 종류의 실패다. 둘 다 받는다.
  const hookSecret =
    Deno.env.get('SEND_SMS_HOOK_SECRETS') ?? Deno.env.get('SEND_SMS_HOOK_SECRET') ?? '';
  if (!hookSecret) {
    console.error('[send-sms] SEND_SMS_HOOK_SECRETS 미설정 — 검증 없이 발송하지 않는다');
    return new Response(JSON.stringify({ error: 'hook secret not configured' }), { status: 500 });
  }
  const signed = await verifySignature(
    {
      id: req.headers.get('webhook-id'),
      timestamp: req.headers.get('webhook-timestamp'),
      signature: req.headers.get('webhook-signature'),
    },
    rawBody,
    hookSecret
  );
  if (!signed) {
    return new Response(JSON.stringify({ error: 'bad signature' }), { status: 401 });
  }

  const key = Deno.env.get('ALIGO_API_KEY') ?? '';
  const userId = Deno.env.get('ALIGO_USER_ID') ?? '';
  const sender = Deno.env.get('ALIGO_SENDER') ?? '';
  if (!key || !userId || !sender) {
    console.error('[send-sms] 알리고 자격 증명 미설정');
    return new Response(JSON.stringify({ error: 'sms provider not configured' }), { status: 500 });
  }

  let payload: { user?: { phone?: string }; sms?: { otp?: string } };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'bad payload' }), { status: 400 });
  }

  const receiver = toDomestic(payload.user?.phone ?? '');
  const otp = payload.sms?.otp ?? '';
  if (!receiver || !otp) {
    return new Response(JSON.stringify({ error: 'missing phone or otp' }), { status: 400 });
  }

  const form = new FormData();
  form.append('key', key);
  form.append('user_id', userId);
  form.append('sender', sender);
  form.append('receiver', receiver);
  form.append('msg', `[결] 인증번호 ${otp} 를 입력해 주세요.`);
  form.append('msg_type', 'SMS');
  // 개발 중 실제 발송·과금 없이 경로를 확인할 수 있게 한다.
  if (Deno.env.get('ALIGO_TEST_MODE') === 'Y') form.append('testmode_yn', 'Y');

  let result: Record<string, unknown>;
  try {
    const res = await fetch(ALIGO_ENDPOINT, { method: 'POST', body: form });
    result = await res.json();
  } catch (e) {
    console.error('[send-sms] 알리고 호출 실패', e);
    return new Response(JSON.stringify({ error: 'sms provider unreachable' }), { status: 502 });
  }

  // 알리고는 HTTP 200 을 주면서 본문 result_code 로 실패를 알린다. 본문을 봐야 한다.
  if (String(result.result_code) !== '1') {
    console.error('[send-sms] 알리고 거절', result.result_code, result.message);
    return new Response(
      JSON.stringify({ error: `sms rejected: ${result.message ?? result.result_code}` }),
      { status: 502 }
    );
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
