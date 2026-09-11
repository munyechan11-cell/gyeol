import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    esbuild: {
      // Strip console.* (except warn/error) and debugger from production bundles
      drop: mode === 'production' ? ['debugger'] : [],
      pure: mode === 'production' ? ['console.log', 'console.info', 'console.debug', 'console.trace'] : [],
    },
    build: {
      rollupOptions: {
        output: {
          // 무거운 vendor 모듈을 분리해 메인 번들을 가볍게.
          // 사장님 첫 로딩 시 받아야 하는 코어(react + react-router + 기본 UI 라이브러리)만 main 에 남기고,
          // 차트/QR/스캐너처럼 무거운 모듈은 필요할 때 로드.
          // (firebase/auth·firestore·storage 규칙은 지웠다 — 그 셋은 Supabase 로
          //  옮겨 더 이상 번들에 들어오지 않는다. 남은 firebase 는 푸시뿐이다.)
          manualChunks(id) {
            if (id.includes("node_modules")) {
              if (id.includes("firebase/messaging")) return "vendor-firebase-messaging";
              if (id.includes("firebase")) return "vendor-firebase-core";
              if (id.includes("@supabase")) return "vendor-supabase";
              if (id.includes("lucide-react")) return "vendor-icons";
              if (id.includes("recharts") || id.includes("d3-")) return "vendor-charts";
              if (id.includes("qrcode") || id.includes("html5-qrcode") || id.includes("jsqr")) return "vendor-qr";
              if (id.includes("react-router")) return "vendor-router";
              if (id.includes("react-dom") || id.includes("react/")) return "vendor-react";
            }
          },
          entryFileNames: `assets/[name]-[hash]-${Date.now()}.js`,
          chunkFileNames: `assets/[name]-[hash]-${Date.now()}.js`,
          assetFileNames: `assets/[name]-[hash]-${Date.now()}.[ext]`
        }
      },
      chunkSizeWarningLimit: 1000,
      cssCodeSplit: true,
      sourcemap: false,
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
