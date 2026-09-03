


// AI 출력 언어 — 사장님 UI 언어로 답하도록(4개국어 앱). 미지정 시 한국어.
const LANG_NAME: Record<string, string> = { ko: '한국어', en: 'English', vi: 'Tiếng Việt', zh: '中文' };
export const langName = (l: any) => LANG_NAME[String(l)] || '한국어';
export const langDirective = (l: any) => `\n[출력 언어] 위 지시와 무관하게 응답 전체를 반드시 ${langName(l)}로만 작성하세요(면책 문구도 그 언어로 번역). 숫자 천단위 콤마·₩ 표기는 유지.`;
