import express from 'express';
import cors from 'cors';


const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// 헬스 체크 — Render 가 부팅 후 / 와 /api/health 둘 다 폴링.
// 둘 중 하나라도 200 응답이 없으면 'Timed Out' 으로 배포 실패 처리됨.
// 라우터 가장 위에 둬서 다른 미들웨어 부작용을 받지 않게.
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
// CORS — 운영 환경에서는 ALLOWED_ORIGINS(콤마구분) 으로 제한, 미설정이면 same-origin만 허용
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    // 같은 출처(서버 사이드 호출 등) 는 origin 헤더가 없음 — 허용
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0) return cb(null, true); // 미설정이면 기존 동작 유지
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
// AI 비전 요청용 이미지(base64 데이터 URL)는 100kb를 쉽게 넘어가므로 한도 상향
// verify: 웹훅 서명 검증을 위해 원본(raw) 바디를 보관 — 파싱 후엔 재구성이 불가.
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    (req as any).rawBody = buf;
  },
}));

export { app, PORT };
export default app;
