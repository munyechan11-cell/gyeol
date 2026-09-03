import ko from "../../../src/lib/i18n-dicts/ko";
import en from "../../../src/lib/i18n-dicts/en";
import vi from "../../../src/lib/i18n-dicts/vi";
import zh from "../../../src/lib/i18n-dicts/zh";

/**
 * 서버 렌더용 i18n.
 *
 * SPA 쪽 i18n(src/lib/i18n.ts)은 localStorage + useSyncExternalStore 기반이라
 * 서버에서 쓸 수 없다. 여기서는 언어를 URL 세그먼트로 받아 순수 함수로 처리한다.
 * **사전 자체는 SPA 와 같은 파일을 그대로 참조한다** — 두 벌로 두면 반드시 어긋나고,
 * 그 어긋남은 손님 화면에서야 발견된다(i18n.test.ts 가 지키는 불변식).
 */
export const LANGS = ["ko", "en", "vi", "zh"] as const;
export type Lang = (typeof LANGS)[number];

export const DEFAULT_LANG: Lang = "ko";

const DICT: Record<Lang, Record<string, string>> = { ko, en, vi, zh };

const LOCALE_MAP: Record<Lang, string> = {
  ko: "ko-KR",
  en: "en-US",
  vi: "vi-VN",
  zh: "zh-CN",
};

export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && (LANGS as readonly string[]).includes(v);
}

/** 키가 없으면 한국어로, 그것도 없으면 키 자체로 폴백 — SPA 의 t() 와 동일한 규칙. */
export function t(key: string, lang: Lang, vars?: Record<string, string | number>): string {
  const raw = DICT[lang]?.[key] ?? DICT.ko[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k: string) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

export const getLocale = (lang: Lang): string => LOCALE_MAP[lang];

/** 통화 표기 — 한국어만 ₩ 뒤에 공백. SPA 의 fmtKRW 와 동일. */
export function fmtKRW(n: number, lang: Lang): string {
  return lang === "ko"
    ? `₩ ${n.toLocaleString(LOCALE_MAP.ko)}`
    : `₩${n.toLocaleString(LOCALE_MAP[lang])}`;
}

/**
 * Accept-Language 헤더에서 지원 언어 하나를 고른다.
 * q 값 순으로 훑되, 지원하지 않는 언어뿐이면 한국어.
 */
export function pickLang(acceptLanguage: string | null | undefined): Lang {
  if (!acceptLanguage) return DEFAULT_LANG;
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.split("=")[1]) || 0 : 1 };
    })
    .filter((x) => x.tag)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const base = tag.split("-")[0];
    // zh-TW·zh-HK 도 중국어 사전으로 보낸다(번체 사전은 아직 없음).
    if (isLang(base)) return base;
  }
  return DEFAULT_LANG;
}
