import { defineConfig } from "vitest/config";

/**
 * 테스트 설정 — 도메인 로직 안전망.
 *
 * 이 저장소는 오랫동안 테스트가 0건이었다. 점진적 재작성(모놀리식 분해 → 스택 이전)을
 * 하려면 "무엇이 깨졌는지" 알려주는 그물이 먼저 있어야 한다. 순수 도메인 규칙
 * (등급·권한·영업시간·테이블 상태 전이)부터 덮고, 모듈을 분해할 때마다 여기에 추가한다.
 *
 * environment: node — 대상이 순수 함수라 DOM 이 필요 없다. 브라우저 API 를 만지는
 * 모듈을 테스트하게 되면 그 파일 상단에 `// @vitest-environment jsdom` 을 달아 개별 지정한다.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "server/**/*.test.ts",
      // 엣지 함수는 Deno 위에서 돌지만, 판단이 들어가는 부분은 순수 모듈로 떼어
      // 두었다(예: send-sms/lib.ts 의 훅 서명 검증). 그 부분은 여기서 지킨다.
      "supabase/functions/**/*.test.ts",
    ],
    passWithNoTests: false,
  },
});
