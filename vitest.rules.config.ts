import { defineConfig } from "vitest/config";

/**
 * Firestore 보안 규칙 테스트 — 에뮬레이터가 필요해서 일반 테스트와 분리한다.
 *
 *   npm run test:rules
 *
 * (일반 `npm test` 는 에뮬레이터 없이 도는 순수 로직 테스트만 포함한다.
 *  규칙 테스트를 거기 섞으면 에뮬레이터가 없는 환경에서 전부 실패한다.)
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["firestore*.rules.test.ts", "firestore.rules.test.ts"],
    // 에뮬레이터 왕복이 있어 기본 5초로는 부족하다.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    passWithNoTests: false,
    // 같은 에뮬레이터 인스턴스를 여러 워커가 동시에 두드리면 clearFirestore 가 서로를 지운다.
    fileParallelism: false,
  },
});
