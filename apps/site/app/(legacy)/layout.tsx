/**
 * 구 경로(/site/:storeId) 전용 루트 레이아웃.
 *
 * 이 트리는 렌더되는 일이 없다 — page 가 언제나 308 로 리다이렉트한다.
 * Next 가 라우트 그룹마다 루트 레이아웃을 요구하므로 최소한만 둔다.
 */
export default function LegacyLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
