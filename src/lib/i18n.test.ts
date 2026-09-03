import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import ko from "./i18n-dicts/ko";
import en from "./i18n-dicts/en";
import vi from "./i18n-dicts/vi";
import zh from "./i18n-dicts/zh";

/**
 * 사전 정합성.
 *
 * t(key) 는 키가 없으면 조용히 한국어로 폴백한다. 그래서 번역 누락은 버그가 아니라
 * "왜 여기만 한국어지?" 로 나타나고, 베트남·중국 손님 화면에서야 발견된다.
 * ko 를 기준으로 나머지 세 사전의 키 집합이 정확히 일치하는지 여기서 막는다.
 */
const DICTS = { en, vi, zh } as const;

/**
 * 의도적으로 비워 둔 키.
 *
 * 한국어 수량 단위(회·장·곳·명·건·개)와 호칭 접미사("고객님")는 숫자/이름 뒤에 붙이는
 * 조각이라 다른 언어에는 대응어가 없다. 빈 문자열이 정답이며, 여기 없는 키가 비면
 * 그건 번역 누락이다.
 */
const INTENTIONALLY_BLANK = new Set([
  "home.unit.visit", "home.unit.coupon", "chome.unit.store",
  "odash.unit.people", "odash.unit.orders",
  "ostat.unit.count", "ostat.unit.people", "ostat.unit.item",
  "owd.hero.guestSuffix",
]);

describe("i18n 사전", () => {
  const koKeys = Object.keys(ko);

  it("한국어 사전이 비어 있지 않다", () => {
    expect(koKeys.length).toBeGreaterThan(1000);
  });

  // 객체 리터럴은 중복 키를 허용하고 마지막 값만 남긴다. 런타임 객체로는 절대 알 수 없으니
  // 소스 텍스트를 직접 읽어서 센다.
  it("사전 소스에 중복 키가 없다 — 뒤에 온 값이 앞을 조용히 덮어쓰는 사고 방지", () => {
    for (const lang of ["ko", "en", "vi", "zh"]) {
      const src = readFileSync(join(process.cwd(), `src/lib/i18n-dicts/${lang}.ts`), "utf8");
      const keys = [...src.matchAll(/^\s{2}"([^"]+)":/gm)].map((m) => m[1]);
      const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
      expect({ lang, dupes: [...new Set(dupes)] }).toEqual({ lang, dupes: [] });
    }
  });

  for (const [lang, dict] of Object.entries(DICTS)) {
    it(`${lang}: 한국어와 키 집합이 정확히 일치한다`, () => {
      const keys = Object.keys(dict);
      const missing = koKeys.filter((k) => !(k in dict));
      const extra = keys.filter((k) => !(k in ko));
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    });

    it(`${lang}: 의도치 않은 빈 번역이 없다`, () => {
      const blanks = Object.entries(dict).filter(([, v]) => !v.trim()).map(([k]) => k);
      expect(blanks.filter((k) => !INTENTIONALLY_BLANK.has(k))).toEqual([]);
    });

    it(`${lang}: 치환 토큰({name} 등)이 한국어와 동일하다`, () => {
      const tokensOf = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const mismatched = koKeys
        .filter((k) => k in dict)
        .filter((k) => tokensOf(ko[k]).join() !== tokensOf(dict[k]).join());
      expect(mismatched).toEqual([]);
    });
  }
});
