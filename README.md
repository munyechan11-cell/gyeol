# 결 (Gyeol)

매장 운영 클라우드 — QR 로 손님을 식별하고, 방문·적립·주문·결제·직원·재고·마케팅을
한 앱에서 다룬다. 파일럿 매장 2곳에서 운영 중.

| | |
|---|---|
| 앱 | React 19 · Vite 7 (`src/`) — 사장님 / 직원 / 손님 세 화면 |
| API | Express 5 (`server.ts`, `server/`) |
| DB · 인증 · 실시간 | Supabase (`supabase/migrations`) — RLS 가 매장 격리를 강제한다 |
| 푸시 | Firebase Cloud Messaging (FCM 만 남았다) |
| 공개 매장 페이지 | Next.js (`apps/site`) |
| 영수증 브릿지 | Electron (`apps/print-agent`) |

## 로컬 실행

```bash
npm install
cp .env.example .env        # 값은 아래 참고
npm run dev                 # API (tsx server.ts)
npx vite                    # 앱
```

`.env` 에 최소한 이것이 있어야 한다:

| 키 | 용도 |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | 서버가 DB 에 닿는 키. 없으면 DB 라우트가 503 |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` | 앱이 쓰는 **공개** 키(번들에 들어가는 게 정상) |
| `MASTER_PASSWORD` | 마스터 화면 초기 비밀번호. 없으면 마스터 화면이 안 열린다 |

로그인은 **전화번호 + 비밀번호**다. 문자 발송이 없어도 동작하고 대시보드 설정도
필요 없다. 카카오·네이버·구글은 각각 `KAKAO_CLIENT_ID` / `NAVER_CLIENT_ID` +
`NAVER_CLIENT_SECRET` / Supabase 대시보드의 Google 공급자가 있어야 한다.

## 확인

```bash
npm run lint          # 타입 검사 (vite build 는 타입을 안 본다)
npm test              # 단위 테스트
npm run db:doctor     # Supabase 접속·스키마·RLS·문서 API·인증을 앱이 밟는 순서로 점검
npm run test:personas # 손님·직원·사장님·비로그인으로 기능을 하나씩 밟아 본다(일회용 로컬 DB)
```

`test:personas` 는 `supabase/tests/personas.sql` 을 돌린다 — 기능 × 페르소나 140건의
표를 돌려주고, `❌` 는 "그 페르소나가 그 기능을 못 쓴다"는 뜻이다. 운영 프로젝트에
그대로 붙여 넣어도 된다(전부 하나의 트랜잭션이고 끝에서 rollback 한다).

DB 정책은 `supabase/tests/rls.sql` 이 검증한다 — SQL 편집기에 붙여넣으면
매장 격리·권한 상승·손님 흐름·직원 온보딩을 사장/직원/손님 세션으로 하나씩 묻는다.

## 문서

- `docs/ARCHITECTURE.md` — 현재 구조, 이전(Firebase → Supabase) 기록, 남은 경계
- `supabase/README.md` — 마이그레이션 목록, 설계 메모, 어드바이저 대응
- `docs/사장님_운영_가이드.md` — 매장에서 쓰는 사람을 위한 안내
- `render.yaml` — 배포(Render) 서비스 2개와 필요한 환경변수 전부
