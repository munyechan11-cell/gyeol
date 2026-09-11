# 결 인쇄 브릿지 (Print Agent)

매장 PC 에 설치되어, 결 웹앱에서 발생한 주문의 영수증을 자동으로 영수증 프린터로 출력하는 Electron 트레이 앱.

## 동작 원리

```
[결 웹앱]  ──①──▶ Supabase: print_jobs/{id} (pending)
                          │
                   ②Realtime 구독 (INSERT 채널 + 초기 조회)
                          ▼
              [매장 PC 트레이 앱 (이 프로젝트)]
                          │
                   ③로컬 프린터에 ESC/POS 전송
                          ▼
                  [영수증 프린터 출력]
                          │
                   ④status: "printed" 업데이트
```

## 개발

```bash
cd apps/print-agent
npm install
npm run dev      # tsc 빌드 후 electron 실행
```

## 빌드 (인스톨러 만들기)

```bash
# Windows .exe (NSIS)
npm run dist:win
# Mac .dmg
npm run dist:mac
# 현재 OS 용
npm run dist
```

결과물: `release/` 폴더

## 사장님 사용 흐름

1. 인스톨러 다운로드 → 더블클릭 → 설치 (3분)
2. 트레이에 🟢 결 아이콘 생김
3. 결 웹앱 → 브랜드 설정 → "페어링 코드 발급" → 6자리 표시
4. 트레이 아이콘 우클릭 → "매장 연결" → 코드 입력
5. 프린터 선택 → "테스트 인쇄" → 영수증 나오면 끝

## 폴더 구조

```
print-agent/
├── package.json            ← electron-builder 설정 포함
├── tsconfig.json
├── src/
│   ├── main.ts            ← Electron 진입 (트레이·워커·IPC)
│   ├── preload.ts         ← contextBridge IPC 래퍼
│   ├── config.ts          ← electron-store (토큰·프린터 저장)
│   ├── supabase.ts        ← print_jobs 구독 + 기기 세션(refresh token) 로그인
│   ├── printer.ts         ← ESC/POS 영수증 인쇄
│   └── ui/
│       └── setup.html     ← 페어링 + 프린터 선택 화면
├── assets/
│   └── tray-icon.png      ← 트레이 아이콘 (16x16 or 32x32)
└── release/                ← 빌드 결과물 (gitignore)
```

## 보안

- 페어링 코드 → 서버가 기기 전용 Supabase 세션 발급 (app_metadata = {device:"printbridge", storeId})
- RLS(`my_device_store_id`)로 자기 매장의 `print_jobs` 만 읽고 갱신한다 — users 행은 만들지 않는다
- 토큰은 OS 사용자 디렉토리의 electron-store 에 저장 (`%APPDATA%/gyeol-print-agent/config.json`)
- 페어링 코드는 5분 TTL, 1회용

## 미래 개선

- [ ] node-thermal-printer 가 OS 프린터 큐 호환성 떨어질 경우 win-printer / pdf-to-printer 로 대체
- [ ] 인쇄 이력 창 (실패 재시도, 사장님 가시성)
- [ ] electron-updater 자동 업데이트
- [ ] 코드 사이닝 인증서 (Windows SmartScreen 경고 제거, 연 ~20만원)
- [ ] Mac notarization
