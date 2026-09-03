import { Router } from 'express';
import express from 'express';
import { fetchWithTimeout } from '../lib/http.js';
import { langDirective } from '../lib/lang.js';
import { extractJson, extractMenuBoard, extractReceipt } from '../lib/parsers.js';
import { callLLMText } from '../lib/reservation.js';

const router = Router();


// --- AI FLOOR PLAN ANALYSIS ---
// 도면 이미지를 Claude/OpenAI Vision으로 분석해 테이블 배치 좌표 추출

// IP별 단순 토큰 버킷 — AI API 키 비용 폭주 방지 (10초당 1회, 분당 4회)
const aiBuckets = new Map<string, { tokens: number; updatedAt: number; minuteCount: number; minuteStart: number }>();
const checkAiRateLimit = (ip: string): { ok: boolean; reason?: string } => {
  const now = Date.now();
  let b = aiBuckets.get(ip);
  if (!b) {
    b = { tokens: 1, updatedAt: now, minuteCount: 0, minuteStart: now };
    aiBuckets.set(ip, b);
  }
  // 10초 토큰: 최대 1
  const refill = Math.floor((now - b.updatedAt) / 10000);
  if (refill > 0) {
    b.tokens = Math.min(1, b.tokens + refill);
    b.updatedAt = now;
  }
  // 분당 카운트 리셋
  if (now - b.minuteStart > 60000) { b.minuteStart = now; b.minuteCount = 0; }
  if (b.minuteCount >= 4) return { ok: false, reason: 'minute' };
  if (b.tokens < 1) return { ok: false, reason: 'second' };
  b.tokens -= 1;
  b.minuteCount += 1;
  // 메모리 청소 — 1만 개 넘으면 가장 오래된 것 정리
  if (aiBuckets.size > 10000) {
    const cutoff = now - 600000;
    for (const [k, v] of aiBuckets) if (v.updatedAt < cutoff) aiBuckets.delete(k);
  }
  return { ok: true };
};


router.post('/api/ai/floor-plan', async (req, res) => {
  // Rate limit — trust proxy=1 설정 하에서 req.ip 는 proxy 가 검증한 첫 X-Forwarded-For 값.
  // raw 헤더를 직접 fallback 으로 쓰면 클라이언트가 IP 를 위조해 rate limit 우회 가능 → req.ip 만 신뢰.
  const ip = String(req.ip || 'unknown').split(',')[0].trim();
  const rl = checkAiRateLimit(ip);
  if (!rl.ok) {
    return res.status(429).json({
      error: rl.reason === 'minute'
        ? '잠시 후 다시 시도해 주세요 (분당 4회 제한).'
        : '요청이 너무 빠릅니다. 10초 후 다시 시도해 주세요.',
    });
  }
  const { image, canvasWidth = 1000, canvasHeight = 700 } = req.body ?? {};
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'image (data URL) is required' });
  }
  // base64 본문 크기 가드 — express.json 의 10mb 한도와 별개로 AI 비용 폭주·요청 거부 방어
  // 8MB raw 이상 차단 (base64 인코딩 후 ~10.7MB → 한도 근접)
  const MAX_IMG_BYTES = 8 * 1024 * 1024;
  const b64Body = image.split(',')[1] ?? '';
  const approxBytes = Math.floor((b64Body.length * 3) / 4);
  if (approxBytes > MAX_IMG_BYTES) {
    return res.status(413).json({ error: '도면 이미지가 너무 큽니다. 8MB 이하로 줄여 주세요.' });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!geminiKey && !anthropicKey && !openaiKey) {
    return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  }

  // 정규화 좌표 (0-1) 사용 — 이미지 종횡비와 무관하게 클라이언트가 캔버스에 정확히 매핑 가능
  const systemPrompt = `
당신은 식당 도면(CAD 도면 또는 사장님이 그린 손스케치)을 분석해 두 가지를 분리해서 추출합니다.

## 핵심 원칙
1. **테이블(tables)** = 손님이 실제로 앉는 자리만. 사각형/원형 박스로 그려진 자리, 의자에 둘러싸인 자리.
2. **구조물(structures)** = 벽, 출입구(문), 룸(방) 경계, 카운터 등 자리가 아닌 모든 것.
3. 벽/문/룸 경계는 **절대 tables 배열에 넣지 마세요.** 그건 structures 입니다.
4. 룸(별실)은 그 자체로 자리가 아닙니다. 룸 안에 그려진 개별 테이블만 tables에 넣고, 룸 경계는 structures에 넣으세요.
5. 도면에 번호가 적혀 있으면 그 번호를 그대로 사용. 없으면 좌상단부터 행 우선으로 1,2,3... 부여.

## 좌표 규칙 (매우 중요)
- 모든 x, y, width, height는 **이미지 너비/높이에 대한 0~1 정규화 비율**입니다.
- 예: 이미지 좌상단 = (0, 0), 우하단 = (1, 1), 중앙 = (0.5, 0.5)
- 이미지에서 보이는 위치에 정확히 맞추세요. 임의로 재배치하지 마세요.

## 출력 스키마 (JSON만, 다른 텍스트 금지)
{
  "tables": [
    { "number": 1, "x": 0.12, "y": 0.08, "width": 0.07, "height": 0.07, "shape": "square"|"circle", "seats": 4 }
  ],
  "structures": [
    { "kind": "wall"|"door"|"room"|"counter", "x": 0.0, "y": 0.0, "width": 0.5, "height": 0.02, "label": "주방" }
  ]
}

## 손그림 해석 규칙
- 작은 사각형/원 = 일반 테이블 (보통 width 0.04~0.10)
- 큰 사각형 = 룸 또는 구역 (structures.kind="room")
- 직선/실선 = 벽 (structures.kind="wall", 얇은 height/width)
- 호 모양/벽 끝의 빈 틈 = 출입구 (structures.kind="door")
- "주방", "카운터", "화장실" 같은 글씨가 있는 영역 = structures.kind="counter" (label에 글씨 그대로)

## 누락 우선 원칙
명백한 객체만 추출. 애매하면 누락이 과추출보다 훨씬 낫습니다.
도면이 거의 비어 보이면 빈 배열 두 개를 반환하세요: {"tables":[],"structures":[]}.
`.trim();

  try {
    // 우선순위: Gemini(무료) → Anthropic → OpenAI
    if (geminiKey) {
      const m = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: 'invalid image data URL' });
      const mediaType = m[1];
      const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
      if (!ALLOWED.has(mediaType)) {
        return res.status(400).json({ error: `unsupported image type: ${mediaType}` });
      }
      const b64 = m[2];

      // gemini-2.5-flash는 무료 티어 포함, 비전 + JSON 응답 모두 지원
      const apiRes = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [
              {
                role: 'user',
                parts: [
                  { inlineData: { mimeType: mediaType, data: b64 } },
                  { text: `이 도면을 분석해 tables(실제 자리)와 structures(벽·문·룸·카운터)를 분리하여 0~1 정규화 좌표 JSON으로 반환하세요. 도면에서 보이는 위치를 정확히 따르고, 임의 재배치 금지.` },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2,
              maxOutputTokens: 4000,
              thinkingConfig: { thinkingBudget: 0 }, // thinking 끔 — 복잡 도면에서 출력 토큰 잘림·지연 방지
            },
          }),
        },
        30000 // 30초 timeout — Gemini가 안 돌아오는 사고 방지
      );
      if (!apiRes.ok) {
        const t = await apiRes.text();
        throw new Error(`Gemini ${apiRes.status}: ${t.slice(0, 200)}`);
      }
      const data: any = await apiRes.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      const json = extractJson(text);
      return res.json(json);
    }

    if (anthropicKey) {
      const m = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: 'invalid image data URL' });
      const mediaType = m[1];
      // Anthropic Vision이 지원하는 타입만 허용 (svg·heic 등 거부)
      const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
      if (!ALLOWED.has(mediaType)) {
        return res.status(400).json({ error: `unsupported image type: ${mediaType}` });
      }
      const b64 = m[2];

      const apiRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 4000,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
                { type: 'text', text: `이 도면을 분석해 tables(실제 자리)와 structures(벽·문·룸·카운터)를 분리하여 0~1 정규화 좌표 JSON으로 반환하세요. 도면에서 보이는 위치를 정확히 따르고, 임의 재배치 금지.` },
              ],
            },
          ],
        }),
      }, 30000);
      if (!apiRes.ok) {
        const t = await apiRes.text();
        throw new Error(`Anthropic ${apiRes.status}: ${t.slice(0, 200)}`);
      }
      const data: any = await apiRes.json();
      const text = data?.content?.[0]?.text ?? '';
      const json = extractJson(text);
      return res.json(json);
    }

    // OpenAI fallback
    const apiRes = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: `이 도면을 분석해 tables(실제 자리)와 structures(벽·문·룸·카운터)를 분리하여 0~1 정규화 좌표 JSON으로 반환하세요. 도면에서 보이는 위치를 정확히 따르고, 임의 재배치 금지.` },
              { type: 'image_url', image_url: { url: image } },
            ],
          },
        ],
        max_tokens: 4000,
      }),
    }, 30000);
    if (!apiRes.ok) {
      const t = await apiRes.text();
      throw new Error(`OpenAI ${apiRes.status}: ${t.slice(0, 200)}`);
    }
    const data: any = await apiRes.json();
    const text = data?.choices?.[0]?.message?.content ?? '';
    const json = extractJson(text);
    return res.json(json);
  } catch (e: any) {
    console.error('[AI floor-plan]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? 'AI 분석 실패' });
  }
});

// ============================================================
// AI RECEIPT — 영수증 사진에서 지출 정보 추출 (ERP 진입장벽↓)
// 영수증 촬영 한 장으로 매출장부 비용 입력을 자동 채운다.
// ============================================================
router.post('/api/ai/receipt', async (req, res) => {
  const ip = String(req.ip || 'unknown').split(',')[0].trim();
  const rl = checkAiRateLimit(ip);
  if (!rl.ok) {
    return res.status(429).json({
      error: rl.reason === 'minute'
        ? '잠시 후 다시 시도해 주세요 (분당 4회 제한).'
        : '요청이 너무 빠릅니다. 10초 후 다시 시도해 주세요.',
    });
  }
  const { image } = req.body ?? {};
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'image (data URL) is required' });
  }
  const MAX_IMG_BYTES = 8 * 1024 * 1024;
  const b64Body = image.split(',')[1] ?? '';
  if (Math.floor((b64Body.length * 3) / 4) > MAX_IMG_BYTES) {
    return res.status(413).json({ error: '영수증 이미지가 너무 큽니다. 8MB 이하로 줄여 주세요.' });
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  const m = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'invalid image data URL' });
  const mediaType = m[1];
  const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  if (!ALLOWED.has(mediaType)) {
    return res.status(400).json({ error: `unsupported image type: ${mediaType}` });
  }
  const b64 = m[2];
  const todayKST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const systemPrompt = `당신은 한국 식당 사장님의 영수증·거래명세서 사진에서 지출 정보를 추출합니다.
JSON 만 출력. 스키마:
{ "amount": 숫자, "vendor": "상호명", "date": "YYYY-MM-DD", "category": "rent|material|utility|marketing|other", "memo": "간단 메모" }
규칙:
- amount: 최종 결제 합계(VAT 포함). 콤마·₩·"원" 제거하고 숫자만.
- date: 영수증 발행일. 안 보이면 "${todayKST}".
- category: 임대료=rent, 식자재·재료·매입=material, 전기·가스·수도·통신=utility, 광고·마케팅=marketing, 그 외=other.
- vendor: 가맹점/상호명. 없으면 "".
- memo: 주요 품목 한 줄 요약(선택).
- 안 보이는 값은 비우되 amount 는 최선 추정. 애매하면 category="other".`;
  try {
    const apiRes = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: mediaType, data: b64 } },
                { text: '이 영수증에서 지출 정보를 위 스키마 JSON 으로 추출하세요.' },
              ],
            },
          ],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
      30000
    );
    if (!apiRes.ok) {
      const t = await apiRes.text();
      throw new Error(`Gemini ${apiRes.status}: ${t.slice(0, 200)}`);
    }
    const data: any = await apiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return res.json(extractReceipt(text, todayKST));
  } catch (e: any) {
    console.error('[AI receipt]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? '영수증 분석 실패' });
  }
});

// ============================================================
// AI MENU BOARD — 메뉴판 사진 한 장에서 메뉴 일괄 추출 + 자동 분류
// 사장님이 메뉴판/입간판/인쇄 메뉴 사진을 올리면 모든 메뉴를 {이름,가격,분류} 로 뽑아,
// 검토 화면에서 확인 후 한 번에 등록한다. (receipt 핸들러와 동일 구조 — 프롬프트/추출기만 다름)
// ============================================================
router.post('/api/ai/menu-board', async (req, res) => {
  const ip = String(req.ip || 'unknown').split(',')[0].trim();
  const rl = checkAiRateLimit(ip);
  if (!rl.ok) {
    return res.status(429).json({
      error: rl.reason === 'minute'
        ? '잠시 후 다시 시도해 주세요 (분당 4회 제한).'
        : '요청이 너무 빠릅니다. 10초 후 다시 시도해 주세요.',
    });
  }
  const { image } = req.body ?? {};
  if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
    return res.status(400).json({ error: 'image (data URL) is required' });
  }
  const MAX_IMG_BYTES = 8 * 1024 * 1024;
  const b64Body = image.split(',')[1] ?? '';
  if (Math.floor((b64Body.length * 3) / 4) > MAX_IMG_BYTES) {
    return res.status(413).json({ error: '메뉴판 이미지가 너무 큽니다. 8MB 이하로 줄여 주세요.' });
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  const m = image.match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'invalid image data URL' });
  const mediaType = m[1];
  const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  if (!ALLOWED.has(mediaType)) {
    return res.status(400).json({ error: `unsupported image type: ${mediaType}` });
  }
  const b64 = m[2];
  const systemPrompt = `당신은 한국 식당·카페의 메뉴판(메뉴 보드, 입간판, 인쇄 메뉴, 손글씨 메뉴 포함) 사진에서 판매 메뉴를 빠짐없이 추출합니다. JSON 만 출력합니다.
스키마: { "items": [ { "name": "메뉴 이름", "price": 숫자, "category": "분류" } ] }
규칙:
- 사진에 보이는 모든 개별 메뉴를 한 항목씩 추출한다. 사이즈/옵션(HOT/ICE, R/L)이 한 줄에 묶여 있으면 대표 1개로 만들고 가장 잘 보이는 가격을 price 로 쓴다.
- name: 메뉴 이름만. 가격·단위·설명은 넣지 않는다.
- price: 숫자만. 콤마·₩·"원"·".-" 등은 제거한다. 가격이 안 보이면 0. 보이지 않는 자릿수를 추측해 만들지 않는다.
- category: 메뉴판에 인쇄된 분류 머리글(예: COFFEE, 논커피, 디저트, 브런치)이 있으면 그 이름을 그대로(한글 우선) 사용한다. 머리글이 없으면 메뉴 성격으로 추론한다(라떼·아메리카노→"커피", 에이드·스무디→"논커피", 케이크·쿠키→"디저트"). 같은 묶음 메뉴는 같은 category 문자열을 쓴다.
- 분류가 도저히 불명확하면 category="기타".
- 메뉴가 아닌 문구(가게 이름, 영업시간, 전화번호, 와이파이, 인사말)는 제외한다.
- 확실한 메뉴만 넣고, 없는 메뉴를 지어내지 않는다.`;
  try {
    const apiRes = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: mediaType, data: b64 } },
                { text: '이 메뉴판 사진에서 모든 메뉴를 위 스키마 JSON 으로 추출하세요.' },
              ],
            },
          ],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
        }),
      },
      30000
    );
    if (!apiRes.ok) {
      const t = await apiRes.text();
      throw new Error(`Gemini ${apiRes.status}: ${t.slice(0, 200)}`);
    }
    const data: any = await apiRes.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    // 응답에 텍스트가 없으면(예: API 형식 오류) 빈 메뉴가 아니라 실패로 처리 → 클라가 "빈 메뉴"로 오인하지 않게
    if (typeof text !== 'string') throw new Error('unexpected Gemini response shape');
    return res.json(extractMenuBoard(text));
  } catch (e: any) {
    console.error('[AI menu-board]', e?.message ?? e);
    // 내부 오류 메시지(Gemini 원문 등)를 클라이언트에 노출하지 않음 — 서버 로그로만
    res.status(500).json({ error: '메뉴판 분석에 실패했어요. 잠시 후 다시 시도해 주세요.' });
  }
});

// ============================================================
// AI BUSINESS INSIGHT — 매장 데이터 자연어 분석
// ============================================================
// 사장님이 통계 페이지에서 미리 정의된 질문을 클릭 → 매장 요약 데이터 +
// 질문을 AI 에 전달 → 자연어 분석 답변 반환.
// 데이터 자체는 클라이언트가 요약해서 보냄 (Firebase Admin 으로 다시 읽지 않음 — 비용 절감).

interface InsightIn {
  storeId: string;
  question: string;          // 사장님이 본 질문 문장
  context: {
    storeName?: string;
    period?: string;         // '이번 달' / '지난 7일' 등
    revenue?: number;
    orderCount?: number;
    customerCount?: number;
    topMenus?: Array<{ name: string; count: number; revenue: number }>;
    topCustomers?: Array<{ name?: string; visits: number; lastVisit?: string; totalSpent?: number }>;
    churnedCustomers?: Array<{ name?: string; lastVisit?: string; visits?: number }>;
    hourlyDistribution?: Record<string, number>;
    weekdayDistribution?: Record<string, number>;
    prevPeriodRevenue?: number;
  };
}

// AI 인사이트 IP rate limit — 분당 10회 (도면 분석보다 가벼움)
const aiInsightBuckets = new Map<string, { count: number; resetAt: number }>();
const checkInsightRate = (ip: string): boolean => {
  const now = Date.now();
  const b = aiInsightBuckets.get(ip);
  if (!b || now > b.resetAt) {
    aiInsightBuckets.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (b.count >= 10) return false;
  b.count += 1;
  return true;
};


// ============================================================
// 세무 AI (TODO 8-3) — 매출·지출 데이터로 절세 관점의 "과정→결과" 설명 생성.
// 참고용 추정만 제공하고, 정확한 신고·절세는 세무사 상담을 권한다(면책 명시).
// ============================================================
router.post('/api/ai/tax', async (req, res) => {
  const ip = String(req.ip || 'unknown').split(',')[0].trim();
  if (!checkInsightRate(ip)) return res.status(429).json({ error: '잠시 후 다시 시도해 주세요. (분당 10회 제한)' });
  const { storeName, bizType, period, revenue, orderCount, expenses, lang } = req.body ?? {};
  if (typeof revenue !== 'number' || revenue < 0) return res.status(400).json({ error: 'revenue required' });
  const expSafe = expenses && typeof expenses === 'object' ? expenses : {};
  const won = (n: any) => '₩' + (Number(n) || 0).toLocaleString('en-US');

  const sys = `당신은 한국 소상공인을 돕는 친절한 세무 도우미입니다. 아래 매장 데이터로 절세·감세를 이해하도록 "과정을 단계별로" 보여주고 "결과(개략 추정)"까지 이어지게 설명하세요.
[출력 구조 — 각 단계를 "1) 제목" 형식으로]
1) 매출 정리 — 기간 매출의 의미(부가세 포함/별도 개념 간단히)
2) 비용·공제 정리 — 카테고리별 지출을 경비처리 관점에서 짚기(임대료·인건비·재료비·공과금·광고비는 대표적 필요경비). 누락하기 쉬운 경비 환기
3) 예상 세금(개략) — 부가가치세(일반/간이 구분이 있다는 점)와 종합소득세를 "대략 어떤 과정으로" 계산하는지 보여주고, 단정 없이 범위로 감 잡게(정확한 세율·공제는 사장님 상황마다 다름을 명시)
4) 절세 포인트 3가지 — 이 데이터 기준 실천 가능한 것(적격증빙 수취, 사업용 카드·계좌 분리, 노란우산공제, 경비 누락 방지 등)
5) 신고 준비 체크리스트 — 다음 신고 때 챙길 것 3~4개
[규칙] 쉬운 한국어, 숫자는 천단위 콤마(₩). 마크다운 헤더(#) 금지(단계 제목은 "1) ..."). 확정적 세액 단정·과장 금지. 데이터가 적으면 솔직히 말하기.
마지막 줄에 반드시: "※ 참고용 추정이에요. 정확한 신고·절세는 세무사나 홈택스 상담을 권해드려요."`;
  const user = `매장명: ${String(storeName || '우리 가게').slice(0, 60)} / 업종: ${String(bizType || '일반')} / 기간: ${String(period || '이번 달')}
매출(결제완료): ${won(revenue)} (주문 ${Number(orderCount) || 0}건)
지출(카테고리별): ${Object.entries(expSafe).map(([k, v]) => `${k}=${won(v)}`).join(', ') || '없음'}
위 데이터로 절세 관점의 과정→결과 설명을 작성해 주세요.`;

  try {
    const text = await callLLMText(sys + langDirective(lang), user, 1500);
    if (text === null) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
    if (!text.trim()) return res.status(502).json({ error: 'AI_EMPTY' }); // 빈 응답(안전필터·조기종료) → 실패 처리
    return res.json({ text });
  } catch (e: any) {
    console.error('[ai/tax]', e?.message);
    return res.status(502).json({ error: 'AI_CALL_FAILED' });
  }
});

// ============================================================
// 소상공인 지원정보 AI 맞춤 추천 (TODO 8-4) — 업종·지역 기준 신청해볼 만한 지원제도 추천.
// 공고·자격은 수시로 바뀌므로 공식 사이트(소상공인24/기업마당) 확인을 권한다(면책).
// ============================================================
router.post('/api/ai/support', async (req, res) => {
  const ip = String(req.ip || 'unknown').split(',')[0].trim();
  if (!checkInsightRate(ip)) return res.status(429).json({ error: '잠시 후 다시 시도해 주세요. (분당 10회 제한)' });
  const { storeName, bizType, region, lang, employeeCount, monthlyRevenue } = req.body ?? {};
  const sys = `당신은 한국 소상공인 지원제도 안내 도우미입니다. 아래 매장 정보를 보고 지금 신청해볼 만한 정부·지자체·공공 지원제도를 "맞춤"으로 추천하세요.
[출력] 3~5개를 "• 제도명 — 한 줄 설명 — 누구에게 좋은지/어떻게 신청" 형식으로. 업종·지역·직원수·매출 규모를 반영(예: 직원 있으면 두루누리, 1인이면 1인 소상공인 고용보험, 매출 적으면 카드수수료 우대). 자격은 공고마다 다르니 단정·과장 금지.
대표 상시 제도(소상공인 정책자금=저금리 융자, 노란우산공제=폐업·노후 대비+소득공제, 두루누리 사회보험료 지원, 카드수수료 우대(영세가맹점), 1인 소상공인 고용보험료 지원, 온누리·지역화폐 가맹, 지자체 소상공인 지원) 중 적합한 것 + 업종 특화가 있으면 함께.
규칙: 쉬운 한국어. 주어진 매장 정보(지역·업종·수치)는 그대로 사용하고, 없는 지역·숫자를 절대 지어내지 말 것. "반드시 받는다"식 확정·과장 금지(자격·금액은 공고마다 다름 명시). 마크다운 헤더(#) 금지.
마지막 줄에 반드시: "※ 공고·자격은 수시로 바뀌어요. 신청 전 소상공인24(sbiz24.kr)·기업마당(bizinfo.go.kr)에서 꼭 확인하세요."`;
  const staff = Number(employeeCount);
  const rev = Number(monthlyRevenue);
  const user = `매장명: ${String(storeName || '우리 가게').slice(0, 60)} / 업종: ${String(bizType || '일반')} / 지역: ${String(region || '미상').slice(0, 40)}`
    + ` / 직원수: ${Number.isFinite(staff) && staff >= 0 ? staff + '명' : '미상'}`
    + ` / 최근 월매출(대략): ${Number.isFinite(rev) && rev > 0 ? '약 ' + Math.round(rev).toLocaleString('ko-KR') + '원' : '미상'}`;
  try {
    const text = await callLLMText(sys + langDirective(lang), user, 1100);
    if (text === null) return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
    if (!text.trim()) return res.status(502).json({ error: 'AI_EMPTY' });
    return res.json({ text });
  } catch (e: any) {
    console.error('[ai/support]', e?.message);
    return res.status(502).json({ error: 'AI_CALL_FAILED' });
  }
});

router.post('/api/ai/insight', async (req, res) => {
  // Rate limit
  const ip = String(req.ip || 'unknown').split(',')[0].trim();
  if (!checkInsightRate(ip)) {
    return res.status(429).json({ error: '잠시 후 다시 시도해 주세요. (분당 10회 제한)' });
  }

  const input = req.body as InsightIn;
  if (!input?.question || !input?.context) {
    return res.status(400).json({ error: 'question, context required' });
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!geminiKey && !anthropicKey && !openaiKey) {
    return res.status(503).json({ error: 'AI_NOT_CONFIGURED' });
  }

  const systemPrompt = `
당신은 한국 식당 사장님의 매장 분석 비서입니다.
아래 매장 데이터와 사장님 질문을 보고 친절하고 실용적인 조언을 한국어로 답하세요.

## 답변 규칙
1. 4-60대 사장님도 쉽게 이해할 수 있는 평이한 한국어 사용. 전문 용어 X.
2. 숫자는 한국식 천 단위 콤마 (예: ₩1,234,000).
3. 답변 길이: 200~400자. 너무 길지 않게.
4. 구조: 핵심 결론 한 줄 → 근거 2-3개 → 다음 액션 제안 1개.
5. 손님 이름은 그대로 사용 (예: '홍길동 손님').
6. 데이터가 부족하면 솔직히 '아직 데이터가 부족해요' 라고 말하기.
7. 친근한 어조 ('~네요', '~을 추천드려요').
8. 절대 마크다운 헤더(#) 사용 금지. 일반 줄바꿈만.
9. 이모지는 답변 시작에 1개만 (예: 📈 / ⭐ / 💔).
`.trim() + langDirective((req.body as any)?.lang);

  const userMsg = `매장명: ${input.context.storeName ?? '매장'}
기간: ${input.context.period ?? '최근'}

사장님 질문: "${input.question}"

매장 데이터:
${JSON.stringify(input.context, null, 2)}

위 데이터로 사장님 질문에 답해주세요.`;

  try {
    if (geminiKey) {
      const apiRes = await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userMsg }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 800, thinkingConfig: { thinkingBudget: 0 } },
          }),
        },
        20000
      );
      if (!apiRes.ok) throw new Error(`Gemini ${apiRes.status}: ${(await apiRes.text()).slice(0, 200)}`);
      const data: any = await apiRes.json();
      const answer = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
      return res.json({ answer });
    }
    if (anthropicKey) {
      const apiRes = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 800,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMsg }],
        }),
      }, 20000);
      if (!apiRes.ok) throw new Error(`Anthropic ${apiRes.status}: ${(await apiRes.text()).slice(0, 200)}`);
      const data: any = await apiRes.json();
      const answer = data?.content?.[0]?.text?.trim() ?? '';
      return res.json({ answer });
    }
    // OpenAI fallback
    const apiRes = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0.4,
        max_tokens: 800,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMsg },
        ],
      }),
    }, 20000);
    if (!apiRes.ok) throw new Error(`OpenAI ${apiRes.status}: ${(await apiRes.text()).slice(0, 200)}`);
    const data: any = await apiRes.json();
    const answer = data?.choices?.[0]?.message?.content?.trim() ?? '';
    return res.json({ answer });
  } catch (e: any) {
    console.error('[AI insight]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? 'AI 분석 실패' });
  }
});

export default router;
