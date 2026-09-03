import type { Metadata } from "next";
import { notFound } from "next/navigation";

import "../../globals.css";
import { isLang } from "../../../lib/i18n";

export const metadata: Metadata = { title: "결" };

/**
 * 언어별 루트 레이아웃.
 *
 * `<html lang>` 은 검색엔진이 페이지 언어를 판단하는 1차 신호라 URL 세그먼트와
 * 반드시 일치해야 한다. 그래서 루트 레이아웃을 [lang] 아래 두고 여기서 정한다.
 * (구 경로 리다이렉트는 app/(legacy) 가 자기 루트 레이아웃을 따로 갖는다.)
 */
export default async function LocalizedLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ lang: string }>;
}) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  return (
    <html lang={lang}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
