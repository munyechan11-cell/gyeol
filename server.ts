// 결 API 서버 — 합성 루트(composition root).
//
// 여기에는 로직을 두지 않는다. 실제 처리는 server/ 아래 모듈이 담당하고
// 이 파일은 "무엇을, 어떤 순서로 붙이는가"만 선언한다.
//
// 라우터 등록 순서는 Express 매칭 순서다. 아래 순서는 분해 이전 server.ts 의
// 등록 순서를 그대로 보존한 것이다. 단 하나의 예외로 marketing 라우터가
// site 보다 앞에 오는데(원본은 site 뒤에 connect-* 3개가 있었다), 두 그룹의
// 경로 프리픽스(/api/marketing/*, /api/site/*)가 겹치지 않으므로 매칭 결과는 동일하다.
// 새 라우터를 끼워 넣을 때는 경로 충돌 여부를 먼저 확인할 것.
import dotenv from 'dotenv';

dotenv.config();

import app, { PORT } from './server/app.js';
import { startServer } from './server/static.js';

import oauthRoutes from './server/routes/oauth.js';
import phoneAuthRoutes from './server/routes/phoneAuth.js';
import posRoutes from './server/routes/pos.js';
import paymentsRoutes from './server/routes/payments.js';
import tossplaceRoutes from './server/routes/tossplace.js';
import aiRoutes from './server/routes/ai.js';
import printBridgeRoutes from './server/routes/printBridge.js';
import pushRoutes from './server/routes/push.js';
import reservationRoutes from './server/routes/reservation.js';
import retellRoutes from './server/routes/retell.js';
import marketingRoutes from './server/routes/marketing.js';
import siteRoutes from './server/routes/site.js';
import webhookRoutes from './server/routes/webhooks.js';
import marketingCronRoutes from './server/routes/marketingCron.js';

app.use(oauthRoutes);
app.use(phoneAuthRoutes);
app.use(posRoutes);
app.use(paymentsRoutes);
app.use(tossplaceRoutes);
app.use(aiRoutes);
app.use(printBridgeRoutes);
app.use(pushRoutes);
app.use(reservationRoutes);
app.use(retellRoutes);
app.use(marketingRoutes);
app.use(siteRoutes);
app.use(webhookRoutes);
app.use(marketingCronRoutes);

// 정적 파일 서빙(과 catch-all)은 반드시 마지막 — 위의 API 경로를 먹어치우면 안 된다.
startServer(app, PORT).catch(console.error);
