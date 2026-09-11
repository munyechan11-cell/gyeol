import type { NextConfig } from "next";

const config: NextConfig = {
  // 사전(src/lib/i18n-dicts)을 이 앱 밖에서 가져온다 — 번역을 두 벌로 두면
  // 반드시 어긋나므로 한 벌만 유지하고 여기서 참조한다.
  outputFileTracingRoot: __dirname + "/../..",
  reactStrictMode: true,
};

export default config;
