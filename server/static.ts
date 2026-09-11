import express from 'express';
import type { Express } from 'express';
import path from 'path';


// Optimized startServer for faster Render ready-signal
export async function startServer(app: Express, PORT: string | number) {
  // 1. Open port EARLY to tell Render we are live
  const server = app.listen(Number(PORT), "0.0.0.0", () => {
    console.log(`[READY] Server running on port ${PORT}`);
  });

  // 순서 주의 — SERVE_STATIC=false 를 NODE_ENV 보다 먼저 본다.
  // SERVE_STATIC=false 는 "이 인스턴스는 API 전용" 이라는 배포자의 명시적 선언이고,
  // NODE_ENV 는 없으면 개발로 간주되는 추론값이다. 명시가 추론을 이겨야 한다.
  // Render 는 NODE_ENV 를 자동으로 넣어주지 않고 render.yaml 에도 선언이 없다.
  // 순서가 반대면 운영 API 인스턴스가 Vite 개발 서버를 띄운다 — 512MB 무료
  // 인스턴스에서 의존성 재최적화까지 돌아 메모리로 죽을 수 있고, 죽은 서비스의
  // 응답에는 CORS 헤더가 없어 브라우저에는 "Failed to fetch" 로만 보인다.
  if (process.env.SERVE_STATIC === "false") {
    // API 전용 모드 — Static Site 가 프론트를 따로 호스팅함 (Render Static Site + CDN)
    // 정적 파일 서빙·SPA fallback 둘 다 끔. 알려지지 않은 경로는 404 로 끝.
    app.use((req, res, next) => {
      if (req.method === "GET" && req.path === "/") {
        return res.json({ ok: true, mode: "api-only" });
      }
      next();
    });
    console.log("[Mode] API-only (SERVE_STATIC=false)");
  } else if (process.env.NODE_ENV !== "production") {
    console.log("[Mode] dev (vite middleware)");
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("[Mode] production static");
    // 2. Production: Concurrent path detection
    const fs = await import('fs');
    let distPath = path.join(process.cwd(), 'dist');
    
    // Check most likely path first, then alternates only if needed
    if (!fs.existsSync(distPath)) {
      const alternates = [
        path.join(__dirname, 'dist'),
        path.join(process.cwd(), '..', 'dist')
      ];
      for (const alt of alternates) {
        if (fs.existsSync(alt)) {
          distPath = alt;
          break;
        }
      }
    }

    // Diagnostic logging in background to avoid blocking
    setImmediate(() => {
      if (fs.existsSync(distPath)) {
        const files = fs.readdirSync(distPath);
        console.log(`[Production] Assets served from: ${distPath}`);
      } else {
        console.error(`[CRITICAL] dist folder not found!`);
      }
    });

    // 3. Serve static files
    app.use(express.static(distPath, {
      maxAge: '1d',
      etag: true,
      index: false
    }));

    // 4. Robust catch-all
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      const ext = path.extname(req.path).toLowerCase();
      if (['.js', '.css', '.png', '.jpg', '.svg', '.ico', '.json', '.webp', '.map'].includes(ext)) {
        return res.status(404).send('Asset missing');
      }
      res.sendFile(path.join(distPath, 'index.html'), (err) => {
        if (err) res.status(500).send('Server configuration issue');
      });
    });
  }
}
