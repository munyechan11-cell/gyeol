


export function extractJson(text: string): { tables: any[]; structures: any[] } {
  // 모델이 ```json ... ``` 블록으로 감쌀 경우 대비
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 첫 { 부터 마지막 } 까지 슬라이스 — 단, 두 인덱스가 모두 명확한 JSON 객체 경계여야 함
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i < 0 || j <= i) throw new Error('AI 응답에서 JSON을 찾지 못했습니다.');
    try { parsed = JSON.parse(raw.slice(i, j + 1)); }
    catch { throw new Error('AI 응답을 JSON 으로 파싱할 수 없습니다.'); }
  }
  // 스키마 가드 — 모델이 다른 모양으로 답해도 클라이언트는 항상 동일한 구조를 받도록
  const tables = Array.isArray(parsed?.tables) ? parsed.tables : [];
  const structures = Array.isArray(parsed?.structures) ? parsed.structures : [];
  return { tables, structures };
}

// ```json 펜스/잡음을 걷어내고 첫 JSON 객체만 파싱 — 실패 시 {} 반환(영수증은 부분값도 살림)
export function parseLooseJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  try {
    return JSON.parse(raw);
  } catch {
    const i = raw.indexOf('{');
    const j = raw.lastIndexOf('}');
    if (i < 0 || j <= i) return {};
    try { return JSON.parse(raw.slice(i, j + 1)); }
    catch { return {}; }
  }
}

// 영수증 AI 응답 정규화 — 클라이언트가 항상 동일한 지출 스키마를 받도록 가드.
// (floor-plan 의 extractJson 은 {tables,structures} 전용이라 영수증엔 쓰면 안 됨)
const RECEIPT_CATEGORIES = new Set(['rent', 'material', 'utility', 'marketing', 'other']);
export function extractReceipt(
  text: string,
  fallbackDate: string,
): { amount: number; vendor: string; date: string; category: string; memo: string } {
  const parsed = parseLooseJson(text) ?? {};
  // amount — 숫자/문자(₩·콤마·"원") 혼재 정상화
  let amount = 0;
  const a = parsed?.amount;
  if (typeof a === 'number' && isFinite(a)) amount = Math.max(0, Math.round(a));
  else if (typeof a === 'string') {
    const n = Number(a.replace(/[^0-9.]/g, ''));
    if (isFinite(n)) amount = Math.max(0, Math.round(n));
  }
  // date — YYYY-MM-DD 만 신뢰, 아니면 오늘(KST)
  const date =
    typeof parsed?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
      ? parsed.date
      : fallbackDate;
  const category = RECEIPT_CATEGORIES.has(parsed?.category) ? parsed.category : 'other';
  const vendor = typeof parsed?.vendor === 'string' ? parsed.vendor.trim().slice(0, 80) : '';
  const memo = typeof parsed?.memo === 'string' ? parsed.memo.trim().slice(0, 200) : '';
  return { amount, vendor, date, category, memo };
}

// 메뉴판 AI 응답 정규화 — 항상 { items: [{name, price, category}] } 로 가드.
// 최상위가 배열일 수도, {items:[...]} 일 수도 있어 parseLooseJson(객체 전용) 대신 별도 처리.
export function extractMenuBoard(text: string): { items: { name: string; price: number; category: string }[] } {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 배열([..]) 또는 객체({..}) 경계로 슬라이스 재시도 (maxOutputTokens 잘림 대비)
    const s = raw.search(/[[{]/);
    const e = Math.max(raw.lastIndexOf(']'), raw.lastIndexOf('}'));
    if (s < 0 || e <= s) return { items: [] };
    try { parsed = JSON.parse(raw.slice(s, e + 1)); }
    catch { return { items: [] }; }
  }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
  const items: { name: string; price: number; category: string }[] = [];
  for (const e of arr) {
    const name = typeof e?.name === 'string' ? e.name.trim().slice(0, 80) : '';
    if (!name) continue;
    // price — 숫자/문자(₩·콤마·"원") 혼재 정상화 (extractReceipt amount 와 동일 로직)
    let price = 0;
    const p = e?.price;
    if (typeof p === 'number' && isFinite(p)) price = Math.max(0, Math.round(p));
    else if (typeof p === 'string') {
      const n = Number(p.replace(/[^0-9.]/g, ''));
      if (isFinite(n)) price = Math.max(0, Math.round(n));
    }
    const category = typeof e?.category === 'string' ? e.category.trim().slice(0, 40) : '';
    items.push({ name, price, category });
    if (items.length >= 60) break; // 과도한 항목 방어
  }
  return { items };
}
