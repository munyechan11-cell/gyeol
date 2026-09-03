import { describe, expect, it } from 'vitest';

import oauthRoutes from './routes/oauth.js';
import phoneAuthRoutes from './routes/phoneAuth.js';
import posRoutes from './routes/pos.js';
import paymentsRoutes from './routes/payments.js';
import tossplaceRoutes from './routes/tossplace.js';
import aiRoutes from './routes/ai.js';
import printBridgeRoutes from './routes/printBridge.js';
import pushRoutes from './routes/push.js';
import reservationRoutes from './routes/reservation.js';
import retellRoutes from './routes/retell.js';
import marketingRoutes from './routes/marketing.js';
import siteRoutes from './routes/site.js';
import webhookRoutes from './routes/webhooks.js';
import marketingCronRoutes from './routes/marketingCron.js';

// server.ts 가 실제로 app.use 하는 순서와 동일하게 유지할 것.
const ROUTERS = [
  oauthRoutes, phoneAuthRoutes, posRoutes, paymentsRoutes, tossplaceRoutes, aiRoutes,
  printBridgeRoutes, pushRoutes, reservationRoutes, retellRoutes,
  marketingRoutes, siteRoutes, webhookRoutes, marketingCronRoutes,
];

// 분해 이전 단일 server.ts 가 노출하던 경로 표. 프린트 에이전트(Electron)·토스플레이스
// 웹훅·외부 cron 이 이 경로들을 하드코딩하고 있어서, 하나라도 사라지면 조용히 죽는다.
// 리팩터링으로 경로가 바뀌면 이 테스트가 먼저 깨져야 한다.
const EXPECTED = [
  'get /api/auth/kakao/url',
  'get /api/auth/kakao/callback',
  'get /api/auth/naver/url',
  'get /api/auth/naver/callback',
  'post /api/auth/social/session',
  'post /api/auth/phone/signup',
  'post /api/order/relay-to-pos',
  'post /api/payment/confirm',
  'post /api/store/toss-secret',
  'post /api/store/tossplace-config',
  'post /api/tossplace/webhook',
  'post /api/store/tossplace-diag',
  'post /api/store/tossplace-sync',
  'post /api/ai/floor-plan',
  'post /api/ai/receipt',
  'post /api/ai/menu-board',
  'post /api/ai/tax',
  'post /api/ai/support',
  'post /api/ai/insight',
  'post /api/print-bridge/issue-code',
  'post /api/print-bridge/exchange',
  'post /api/print-bridge/heartbeat',
  'post /api/push/send-to-owner',
  'post /api/reservation/availability',
  'post /api/reservation/create',
  'post /api/reservation/resolve-store',
  'post /api/reservation/slots',
  'post /api/reservation/agent',
  'post /api/retell/availability',
  'post /api/retell/slots',
  'post /api/retell/book',
  'post /api/marketing/generate',
  'post /api/marketing/publish',
  'get /api/marketing/image/:photoId',
  'post /api/marketing/connect-url',
  'post /api/marketing/connect-finish',
  'post /api/marketing/disconnect',
  'get /api/site/:storeId',
  'post /api/webhook/order-status',
  'all /api/cron/marketing',
];

function collect(): string[] {
  const out: string[] = [];
  for (const router of ROUTERS) {
    for (const layer of (router as any).stack) {
      const route = layer.route;
      if (!route) continue;
      // express 5 는 route.methods 대신 내부 표현이 다를 수 있어 양쪽을 본다.
      const methods: Record<string, boolean> = route.methods ?? layer.route._methods ?? {};
      const names = Object.keys(methods).filter((m) => methods[m]);
      const verb = names.length > 1 || names.includes('_all') ? 'all' : names[0];
      out.push(`${verb} ${route.path}`);
    }
  }
  return out;
}

describe('API 경로 표', () => {
  it('[회귀] 분해 이전 server.ts 와 동일한 경로·메서드를 노출한다', () => {
    expect(collect()).toEqual(EXPECTED);
  });

  it('중복 등록된 경로가 없다 — 먼저 등록된 쪽이 뒤를 가려버리는 사고 방지', () => {
    const seen = collect();
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('모든 경로가 /api 로 시작한다 — SPA catch-all 과 충돌하지 않도록', () => {
    for (const entry of collect()) {
      expect(entry.split(' ')[1].startsWith('/api/')).toBe(true);
    }
  });
});
