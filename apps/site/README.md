# 결 공개 매장 사이트 (Next.js)

`/site/:storeId` — 로그인 없이 누구나 보는 매장 브랜드 사이트를 **서버 렌더**한다.

## 왜 따로 있나

SPA 로 렌더하면 크롤러가 받는 HTML 이 빈 `<div id="root">` 라 검색에 잡히지 않는다.
매장 입장에서 이건 기능 결손이라 `docs/ARCHITECTURE.md` 의 Phase 2 에서 가장 먼저 옮기기로 한
라우트다. 지금은 **운영 트래픽을 받지 않는다** — 동작하는 상태로 올려 두고, 전환은 별도 결정이다.

## 구조

```
app/(localized)/[lang]/site/[storeId]   서버 렌더 본체 (ko·en·vi·zh)
app/(legacy)/site/[storeId]             구 경로 → 브라우저 언어에 맞는 언어판으로 308
lib/i18n.ts                             서버용 t()/fmtKRW — 사전은 SPA 와 같은 파일을 참조
lib/siteData.ts                         Express /api/site/:storeId 호출 (5분 ISR)
components/StoreSite.tsx                화면 (SPA 의 src/pages/StoreSite.tsx 를 옮긴 것)
```

**사전은 복사하지 않는다.** `../../src/lib/i18n-dicts/*` 를 그대로 import 한다.
두 벌로 두면 반드시 어긋나고, 그 어긋남은 손님 화면에서야 발견된다.

## 환경변수

| 이름 | 뜻 | 기본값 |
|---|---|---|
| `SITE_API_BASE` | 매장 데이터를 받아올 Express API 오리진 | `http://localhost:3000` |
| `SITE_PUBLIC_ORIGIN` | 이 사이트의 공개 오리진 (canonical·hreflang 에 쓰임) | `http://localhost:3200` |
| `SITE_APP_ORIGIN` | 주문 화면(SPA)의 오리진. 비우면 상대경로 | (빈값) |

`SITE_PUBLIC_ORIGIN` 을 실제 도메인으로 두지 않으면 canonical 이 localhost 를 가리켜
검색 색인이 망가진다. 배포 시 반드시 설정할 것.

## 개발·검증

```bash
npm install
npm run dev        # http://localhost:3200/ko/site/<storeId>
npm run build
node scripts/verify-ssr.mjs   # 가짜 API 를 띄우고 SSR 결과를 실제로 검사 (24항목)
```

`verify-ssr.mjs` 는 "검색에 노출된다"는 주장이 성립하는지 직접 확인한다 —
매장명·메뉴·설명·리뷰가 HTML 에 박혀 나오는지, canonical·hreflang·OG·JSON-LD 가 맞는지,
언어별로 `<html lang>` 과 통화 표기가 달라지는지, 구 경로가 308 로 넘어가는지, 없는 매장이 404 인지.

## 전환하려면 (아직 하지 않았음)

1. 이 앱을 배포하고 `SITE_PUBLIC_ORIGIN`·`SITE_API_BASE`·`SITE_APP_ORIGIN` 설정
2. 도메인/프록시에서 `/site/*` 와 `/{ko,en,vi,zh}/site/*` 를 이 앱으로 라우팅
3. 실제 매장 id 로 `curl -s <origin>/ko/site/<id> | grep '<title>'` 확인
4. 확인 후 SPA 의 `src/pages/StoreSite.tsx` 와 `App.tsx` 의 `/site/:storeId` 라우트 제거

4번을 하기 전까지는 같은 화면이 두 벌 존재한다. 오래 방치하면 서로 어긋나므로,
전환하지 않기로 했다면 이 앱을 지우는 편이 낫다.
