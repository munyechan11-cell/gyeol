# Supabase (Firestore 이전 대상)

## 프로젝트

| | |
|---|---|
| 이름 | `gyeol` |
| ref | `pxvkbvojpxavrandrqkp` |
| 리전 | `ap-northeast-2` (서울) |
| 요금 | 무료 |

### 왜 새 프로젝트를 만들었나

기존 `supabase-red-bell` 에는 **다른 앱의 스키마**가 이미 있었다
(`centers`·`profiles`·`user_roles`·`checkin_sessions`·`staff_codes` 등 9개 테이블).
전부 0행이라 안 쓰는 것으로 보였지만, 그 앱이 `auth.users` 에 걸어둔 트리거
(`on_auth_user_created` → `handle_new_user`)가 **결 회원가입 때도 실행된다.**
그 함수가 실패하면 가입 자체가 막히고, 성공해도 남의 앱 테이블에 행이 쌓인다.
두 앱이 한 DB·한 auth 를 공유하면 한쪽 변경이 다른 쪽을 조용히 깨뜨리므로 분리했다.
(잠깐 그 프로젝트에 결 테이블을 만들었다가 전부 거뒀다. 그쪽은 원래 9개 테이블 그대로다.)

## 마이그레이션

| 파일 | 내용 |
|---|---|
| `20260901000000_init_schema.sql` | 테이블 18개 + `updatedAt` 자동 갱신 트리거 |
| `20260901000100_rls.sql` | RLS 정책 + 권한 상승 차단 트리거 |

두 파일 모두 위 프로젝트에 적용 완료.

## 설계 메모

**문서 모양을 그대로 옮긴다.** 각 테이블은 `승격 컬럼 + data jsonb` 구조다.
앱은 지금 Firestore 문서를 통째로 다루고(`{ id, ...data }`) 부분 패치로 저장하는데,
이 모양을 유지해야 화면 수백 개를 안 건드리고 옮길 수 있다. 승격 대상은
"앱이 실제로 필터·정렬·권한 판정에 쓰는 필드"만 실측해서 골랐다.
나머지를 컬럼으로 펴는 정규화는 이전이 끝난 뒤 별도로 한다 — 이전과 재설계를
같이 하면 무엇이 깨졌는지 구분할 수 없다.

**컬럼명은 camelCase 를 따옴표로 쓴다.** snake_case 로 바꾸면 데이터 계층마다
이름을 번역해야 하고 그 번역이 곧 버그가 된다.

**권한은 JWT claim 이 아니라 `users` 테이블에서 읽는다** (`my_store_id()`,
`my_role()` — security definer). claim 방식은 등급을 바꿔도 토큰을 새로 받기
전까지 옛 권한이 살아 있다. Firebase Custom Token 설계의 약점이었고 여기서 없앴다.

## 어드바이저에 남는 항목 (의도된 것)

- `store_secrets`·`pairing_codes`·`merchant_map` — RLS 켜짐 + 정책 없음.
  **의도한 것이다.** 정책이 없으면 클라이언트는 아무것도 못 하고,
  `service_role`(서버)만 접근한다.
- `my_role()`·`my_store_id()` 가 `authenticated` 에게 실행 가능 —
  RLS 정책이 이 함수를 호출하므로 **필요하다.** 둘 다 호출자 자신에 대한 정보만
  돌려주므로 노출돼도 무해하다. `anon` 에게는 실행 권한을 회수했다.

## 상태

| 영역 | 상태 |
|---|---|
| 스키마·RLS·문서 API | 적용 완료 |
| 클라이언트 데이터 계층 | Supabase (`src/lib/db.ts`, `realtime.ts`) |
| 로그인 | 전화 OTP + 소셜(카카오·네이버·구글) — 셋 다 Supabase 세션을 만든다 |
| 문자 발송 | 알리고 Send SMS Hook (`supabase/functions/send-sms`) 배포됨 |
| 서버 라우트 | Firestore 호출부 28곳 전부 이전 완료 |
| 영수증 브릿지 | 기기 세션으로 이전 (`apps/print-agent`) |
| Firebase | **FCM 푸시만 남음** |
| 기존 데이터 이전 | 안 함 — "새로 시작" 으로 결정 |

### 남은 설정 (코드 아닌 대시보드 작업)

1. **문자 발송 자격 증명**
   ```
   supabase secrets set ALIGO_API_KEY=... ALIGO_USER_ID=... ALIGO_SENDER=...
   supabase secrets set SEND_SMS_HOOK_SECRETS=v1,whsec_...
   ```
   그리고 Authentication → Hooks → Send SMS 에 `send-sms` 함수 지정.
   시크릿을 넣기 전까지 이 함수는 500 을 돌려준다 — **일부러 그렇다.**
   문자가 안 갔는데 200 을 주면 사용자는 오지 않는 문자를 기다린다.

2. **전화 로그인 켜기** — Authentication → Sign In / Providers → Phone.

3. **구글 로그인** — Authentication → Providers → Google 에 클라이언트 ID/시크릿.
   카카오·네이버는 서버 경로(`/api/auth/*`)라 여기 설정과 무관하다.
   서버 쪽 환경변수만 있으면 된다: `KAKAO_CLIENT_ID`, `NAVER_CLIENT_ID`,
   `NAVER_CLIENT_SECRET`, 그리고 구글 토큰 검증용 `GOOGLE_CLIENT_ID`(선택이지만
   넣는 편이 좋다 — 다른 앱의 구글 토큰 재사용을 막는다).

4. **서버 환경변수** — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
   없으면 라우트가 503 을 돌려준다(조용히 실패하지 않는다).

점검은 `node scripts/db-doctor.mjs` 로 한다. 위 항목을 앱이 밟는 순서대로 찔러
어느 단계가 끊겼는지 짚어 준다.

## 어드바이저 (Supabase 린터)

`get_advisors` 를 돌려 지적된 것 중 **셋은 고쳤고, 셋은 남겼다.** 남긴 쪽도 이유를
적어 둔다 — 안 적으면 다음에 보는 사람이 "경고가 있네" 하고 되돌린다.

### 고친 것

| 지적 | 왜 진짜 문제였나 |
|---|---|
| `function_search_path_mutable` ×3 | `is_doc_table`·`hm_to_min`·`my_device_store_id` 에 search_path 를 안 걸었다. 열려 있으면 호출자가 그 값을 바꿔 같은 이름의 다른 함수·테이블을 가리키게 할 수 있다. `is_doc_table` 은 save_doc 의 테이블 화이트리스트라 특히 중요하다 |
| `auth_rls_initplan` ×7 | 정책 본문의 `auth.uid()` 가 **행마다** 다시 평가됐다. `(select auth.uid())` 로 감싸 쿼리당 한 번만 계산한다. 손님 한 명의 주문·쿠폰을 훑을 때 차이가 난다 |
| `unindexed_foreign_keys` ×2 | `merchant_map`·`pairing_codes` 의 storeId. 부모(users) 행을 지울 때 자식에서 참조를 찾느라 전체를 훑는다 — 계정 삭제가 느려지는 자리 |

고친 뒤 RLS 검증 13건을 다시 돌려 판정이 그대로임을 확인했다(정책을 다시 쓴 것이라
의미가 바뀌지 않았는지 봐야 한다).

### 남긴 것

| 지적 | 왜 그대로 두나 |
|---|---|
| `rls_enabled_no_policy` ×4 | **그게 목적이다.** 정책 0개 = 클라이언트 접근 0. 정산 키·페어링 코드는 service_role 만 닿아야 한다 |
| `authenticated_security_definer_function_executable` ×2 | 정책이 `my_role`·`my_store_id` 를 부르므로 authenticated 에게 EXECUTE 가 있어야 한다. RPC 로 직접 불러도 인자가 없고 **자기 자신의** 역할·매장만 돌려준다 — 자기 users 행을 읽으면 어차피 아는 값이다 |
| `multiple_permissive_policies` ×4 | 본인용과 사장용 정책이 따로 있다. 합치면 빠르지만 "내 것"과 "우리 매장 손님"은 다른 판단이라 합치면 읽기 어려워진다. users 는 작은 테이블이라 명확성을 택했다 |
| `unused_index` ×12 | **DB 가 비어 있어서 아무 것도 안 쓰인 게 당연하다.** 이걸 근거로 storeId 인덱스를 지우면 매장별 조회가 전부 전체 훑기가 된다. 지우면 안 된다 |

## 검증

- `supabase/tests/rls.sql` — 매장 격리·권한 상승 차단. Firestore 규칙 테스트
  46건이 하던 질문을 그대로 옮겼다. 판정 주체가 Postgres 이므로 앱을 거치지 않고
  정책만 본다.
- `server/lib/db.test.ts` — 어댑터 실동작. `SUPABASE_SERVICE_ROLE_KEY` 가
  없으면 통째로 건너뛴다.

### RLS 검증에서 실제로 걸린 것

`menus` 는 로그인한 누구나 읽을 수 있다(`using (true)`). 실수가 아니라
의도다 — 손님이 앉은 가게의 메뉴를 봐야 하는데 "지금 어느 가게에 있는가"를
나타내는 연결이 데이터에 없다. 닫으려면 그 연결부터 만들어야 한다.

그리고 하나를 고쳤다. 손님이 자기 행에 `{"role":"owner"}` 를 써도 권한은
오르지 않지만(판정은 진짜 `role` 컬럼만 본다), 앱은 행을 `{...data, id}` 로
읽으므로 **화면만 사장이 된다.** 데이터는 안 새지만 사장님 UI 가 열리고
눌러도 아무것도 안 되는 상태가 된다. 두 값이 갈라질 수 없게 막았다.
