import { useSyncExternalStore } from "react";
import ko from "./i18n-dicts/ko";

// ============================================================
// 가벼운 자체 i18n — 외부 라이브러리 없이 localStorage 기반.
// 새 라벨은 dict 에 추가하고, 각 화면에서 t(key) 로 호출.
// 누락된 키는 한국어 fallback → key 그대로.
// ============================================================

export type Lang = "ko" | "en" | "vi" | "zh";
export const LANGS: { code: Lang; label: string; native: string }[] = [
  { code: "ko", label: "Korean", native: "한국어" },
  { code: "en", label: "English", native: "English" },
  { code: "vi", label: "Vietnamese", native: "Tiếng Việt" },
  { code: "zh", label: "Chinese", native: "中文" },
];

const STORAGE_KEY = "gyeol-lang";
const DEFAULT_LANG: Lang = "ko";

function getInitialLang(): Lang {
  if (typeof window === "undefined") return DEFAULT_LANG;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (saved && LANGS.some((l) => l.code === saved)) return saved;
  } catch {
    // localStorage 차단 환경 — 기본값
  }
  return DEFAULT_LANG;
}

let currentLang: Lang = getInitialLang();
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function setLanguage(lang: Lang) {
  if (currentLang === lang) return;
  // 사전이 아직 로드 안 됐어도 즉시 전환 — ko 폴백으로 깜빡임 없게.
  // 로드 완료되면 자동으로 한 번 더 리렌더해 새 언어 텍스트로 갱신.
  currentLang = lang;
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // 저장 실패해도 메모리 상태는 유지
  }
  document.documentElement.lang = lang;
  listeners.forEach((cb) => cb());
  if (lang !== "ko" && typeof window !== "undefined") {
    // 모듈 호이스팅으로 loadDict 는 파일 하단에서도 참조 가능
    void loadDictIfNeeded(lang);
  }
}

// 부팅 시 외부에서 호출 — setLanguage 의 사이드이펙트 분리용 forward declaration
let loadDictIfNeeded: (lang: Lang) => Promise<void> = async () => {};

export function getLanguage(): Lang {
  return currentLang;
}

// 동기화 — useSyncExternalStore 로 컴포넌트에서 안전하게 구독.
// getServerSnapshot 도 currentLang 으로 통일 (SSR 도입 시 hydration mismatch 차단).
export function useLanguage(): Lang {
  return useSyncExternalStore(
    subscribe,
    () => currentLang,
    () => currentLang
  );
}

// ============================================================
// 사전
// ============================================================
type Dict = Record<string, string>;

// ============================================================
// 사전 로딩 — ko 만 인라인. en/vi/zh 는 다이나믹 임포트로 분리해
// 메인 번들 크기를 줄임. setLanguage(lang) 호출 시 자동 로드.
// ============================================================
const DICT: Record<Lang, Dict | undefined> = { ko, en: undefined, vi: undefined, zh: undefined };
const loading: Record<Lang, Promise<Dict> | null> = { ko: null, en: null, vi: null, zh: null };

async function loadDict(lang: Lang): Promise<Dict> {
  if (DICT[lang]) return DICT[lang]!;
  if (loading[lang]) return loading[lang]!;
  // Vite 가 정적 분석할 수 있게 명시적 분기 — 동적 변수 임포트는 prefetch 힌트가 약함
  const p: Promise<Dict> =
    lang === "en" ? import("./i18n-dicts/en").then((m) => m.default) :
    lang === "vi" ? import("./i18n-dicts/vi").then((m) => m.default) :
    lang === "zh" ? import("./i18n-dicts/zh").then((m) => m.default) :
    Promise.resolve(ko);
  loading[lang] = p;
  const d = await p;
  DICT[lang] = d;
  return d;
}

// 부팅 시 저장된 언어가 ko 가 아니면 백그라운드로 즉시 로드
if (typeof window !== "undefined" && currentLang !== "ko") {
  loadDict(currentLang)
    .then(() => listeners.forEach((cb) => cb()))
    .catch((e) => {
      // 네트워크 끊김 — 폴백 ko 사전으로 계속 동작
      console.warn("[i18n] dict load failed", e?.message);
    });
}

// setLanguage 가 호이스팅 forward declaration 으로 호출하는 실제 구현
loadDictIfNeeded = async (lang: Lang) => {
  if (DICT[lang]) return;
  await loadDict(lang);
  listeners.forEach((cb) => cb());
};

export function t(
  key: string,
  lang: Lang = currentLang,
  vars?: Record<string, string | number>
): string {
  // 요청한 사전이 아직 로드 안 됐으면 한국어로 폴백 — 화면이 비지 않게.
  const raw = DICT[lang]?.[key] ?? DICT.ko![key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{${k}}`
  );
}

// Lang → BCP47 locale 매핑. toLocaleString / toLocaleDateString 에 전달.
const LOCALE_MAP: Record<Lang, string> = {
  ko: "ko-KR",
  en: "en-US",
  vi: "vi-VN",
  zh: "zh-CN",
};

/** 현재 또는 지정 언어의 BCP47 locale 코드. */
export function getLocale(lang?: Lang): string {
  return LOCALE_MAP[lang ?? currentLang];
}

// 통화 포매팅 — 한국어는 '₩ 1,000', 그 외는 '₩1,000' (KRW 단위 그대로)
export function fmtKRW(n: number, lang: Lang = currentLang): string {
  return lang === "ko"
    ? `₩ ${n.toLocaleString(LOCALE_MAP.ko)}`
    : `₩${n.toLocaleString(LOCALE_MAP[lang])}`;
}

// 초기 lang 속성 — html 태그에 반영
if (typeof document !== "undefined") {
  document.documentElement.lang = currentLang;
}
