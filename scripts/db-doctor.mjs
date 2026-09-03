#!/usr/bin/env node
/**
 * 결(Gyeol) DB 닥터 — 서버 가동 전 데이터베이스·인증 점검기
 *
 * 왜 필요한가:
 *   가입·로그인이 안 될 때 화면에 뜨는 말은 늘 하나다 — "실패했어요".
 *   그런데 끊길 수 있는 지점은 여럿이다: 프로젝트 주소가 틀렸거나, 키가
 *   만료됐거나, 마이그레이션이 안 올라갔거나, 전화 로그인이 꺼져 있거나,
 *   문자 발송 훅이 안 붙어 있거나. 이 스크립트는 앱이 실제로 밟는 순서대로
 *   찔러서 **어느 단계에서 끊겼는지** 짚어 준다.
 *
 * 공개 키만 쓴다. service_role 키는 필요 없고, 넣지도 말 것.
 *
 * 사용법:
 *   node scripts/db-doctor.mjs
 *   node scripts/db-doctor.mjs --url https://xxx.supabase.co --key sb_publishable_...
 *
 * 종료 코드: 0 = 정상, 1 = 문제 발견
 */

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const URL_ =
  arg("url") ||
  process.env.VITE_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  "https://pxvkbvojpxavrandrqkp.supabase.co";
const KEY =
  arg("key") ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable___a4MY-b5lk_VZHRLh8Mtg_8LxAqVcO";

let failed = 0;
const ok = (m, detail) => console.log(`  \x1b[32m✓\x1b[0m ${m}${detail ? ` — ${detail}` : ""}`);
const bad = (m, fix) => {
  failed++;
  console.log(`  \x1b[31m✗\x1b[0m ${m}`);
  if (fix) console.log(`     ↳ ${fix}`);
};
const info = (m) => console.log(`  \x1b[90m·\x1b[0m ${m}`);

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

/**
 * 프록시가 가로챈 응답인가.
 *
 * 이 저장소는 아웃바운드가 프록시를 거치는 환경에서도 돌아간다. 거기서 호스트가
 * 허용 목록에 없으면 **프록시가 403 을 돌려준다** — Supabase 가 아니라.
 * 그걸 서버의 대답으로 착각하면 "닫혀 있어서 403" 으로 읽혀 전부 ✓ 가 뜬다.
 * 확인을 못 한 것과 확인해서 괜찮은 것은 완전히 다른 결과다. 구분한다.
 */
const blocked = (r) =>
  typeof r.body === "string" &&
  /not in allowlist|egress|proxy|tunnel/i.test(r.body);

async function get(path, extra = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(`${URL_}${path}`, { ...extra, headers: { ...headers, ...(extra.headers ?? {}) }, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`\n결 DB 닥터 — ${URL_}\n`);

// ── 1. 주소·키 ────────────────────────────────────────────
console.log("1) 접속");
if (!URL_ || !KEY) {
  bad("URL 또는 키가 비었다", "VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY 설정");
} else {
  const r = await get("/rest/v1/").catch((e) => ({ status: 0, body: String(e?.message ?? e) }));
  if (blocked(r)) {
    bad("네트워크가 이 호스트를 막고 있어 아무것도 확인하지 못했다",
        "프록시 허용 목록에 " + new URL(URL_).host + " 추가 후 다시 실행. (아래 결과는 의미 없음)");
    console.log(
      `\n\x1b[31m확인 불가.\x1b[0m 서버에 닿지 못했으므로 '정상'도 '문제 있음'도 말할 수 없다.\n`
    );
    process.exit(1);
  }
  if (r.status === 0) bad(`REST 에 닿지 않는다 (${r.body})`, "URL 오타 또는 네트워크 확인");
  else if (r.status === 401) bad("키가 거부됐다 (401)", "publishable 키가 이 프로젝트 것인지 확인");
  else ok("REST 응답", `HTTP ${r.status}`);
}

// ── 2. 스키마 ─────────────────────────────────────────────
console.log("\n2) 스키마 (마이그레이션이 올라갔는가)");
const TABLES = ["users", "menus", "orders", "visits", "tables", "print_jobs"];
for (const t of TABLES) {
  const r = await get(`/rest/v1/${t}?select=id&limit=1`);
  if (r.status === 404 || (r.status === 400 && /does not exist|relation/i.test(JSON.stringify(r.body)))) {
    bad(`${t} 테이블이 없다`, "supabase/migrations 를 적용: supabase db push");
  } else if (r.status >= 500) {
    bad(`${t} 조회가 5xx (${r.status})`, JSON.stringify(r.body).slice(0, 120));
  } else {
    ok(`${t} 있음`, `HTTP ${r.status}`);
  }
}

// ── 3. RLS ────────────────────────────────────────────────
console.log("\n3) RLS (비로그인에게 열려 있지 않은가)");
{
  // 정책은 전부 `to authenticated` 라, 비로그인 키로는 아무 행도 안 나와야 한다.
  const r = await get("/rest/v1/users?select=id&limit=5");
  const rows = Array.isArray(r.body) ? r.body.length : null;
  if (rows === null) {
    ok("users 가 비로그인에게 닫혀 있다", `HTTP ${r.status}`);
  } else if (rows === 0) {
    ok("users 가 비로그인에게 0건", "정책이 걸려 있다");
  } else {
    bad(`users 가 비로그인에게 ${rows}건 노출된다`, "supabase/migrations 의 RLS 정책 확인 — 이건 전 계정 유출이다");
  }
}

// ── 4. 문서 API ───────────────────────────────────────────
console.log("\n4) 문서 API (save_doc 이 배포됐는가)");
{
  // 일부러 없는 테이블을 넣는다. 함수가 있으면 "알 수 없는 테이블" 로 거절하고,
  // 없으면 404 가 온다 — 이 차이로 배포 여부를 가른다.
  const r = await get("/rest/v1/rpc/save_doc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ p_table: "__nope__", p_id: "x", p_patch: {} }),
  });
  const msg = JSON.stringify(r.body);
  if (r.status === 404) bad("save_doc 함수가 없다", "supabase/migrations/20260901000100_doc_api.sql 적용");
  else if (/알 수 없는 테이블/.test(msg)) ok("save_doc 배포됨", "화이트리스트가 동작한다");
  else if (r.status === 401 || r.status === 403) ok("save_doc 배포됨", "비로그인은 실행 불가(정상)");
  else info(`save_doc 응답 HTTP ${r.status} ${msg.slice(0, 100)}`);
}

// ── 5. 인증 ───────────────────────────────────────────────
console.log("\n5) 인증 (전화 OTP 로 로그인할 수 있는가)");
{
  const r = await get("/auth/v1/settings");
  if (r.status !== 200 || typeof r.body !== "object") {
    bad(`auth 설정을 못 읽었다 (HTTP ${r.status})`);
  } else {
    const ext = r.body.external ?? {};
    if (r.body.external_phone_enabled || ext.phone) ok("전화 로그인 켜짐");
    else bad("전화 로그인이 꺼져 있다", "대시보드 → Authentication → Sign In / Providers → Phone 켜기");

    const providers = Object.entries(ext).filter(([, v]) => v === true).map(([k]) => k);
    info(`켜진 소셜 공급자: ${providers.length ? providers.join(", ") : "없음"}`);
    if (!ext.google) {
      info("구글 로그인은 대시보드에서 Google 공급자를 켜야 동작한다 (카카오·네이버는 서버 경로라 무관)");
    }
  }
}

// ── 6. 문자 발송 ──────────────────────────────────────────
console.log("\n6) 문자 발송 (OTP 가 실제로 도착하는가)");
{
  const r = await get("/functions/v1/send-sms", { method: "POST", body: "{}" });
  if (r.status === 404) {
    bad("send-sms 함수가 없다", "supabase functions deploy send-sms --no-verify-jwt");
  } else if (r.status === 401 && /signature/i.test(JSON.stringify(r.body))) {
    ok("send-sms 배포됨", "서명 검증이 동작한다(서명 없는 요청을 거절)");
  } else if (r.status === 500 && /hook secret/i.test(JSON.stringify(r.body))) {
    bad("send-sms 는 있지만 SEND_SMS_HOOK_SECRET 이 없다",
        "supabase secrets set SEND_SMS_HOOK_SECRET=v1,whsec_... (대시보드 Auth → Hooks 에서 발급)");
  } else {
    info(`send-sms 응답 HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    info("알리고 자격 증명(ALIGO_API_KEY/USER_ID/SENDER)도 secrets 에 있어야 실제 발송된다");
  }
}

console.log(
  failed === 0
    ? "\n\x1b[32m문제 없음.\x1b[0m\n"
    : `\n\x1b[31m${failed}건 확인 필요.\x1b[0m 위의 ↳ 를 따라가면 된다.\n`
);
process.exit(failed === 0 ? 0 : 1);
