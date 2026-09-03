import { headers } from "next/headers";
import { permanentRedirect } from "next/navigation";

import { pickLang } from "../../../../lib/i18n";

/**
 * 기존 경로 호환 — 매장이 이미 배포한 QR·명함·인스타 링크가 `/site/:storeId` 다.
 * 브라우저 언어에 맞는 언어판으로 영구 리다이렉트한다(308).
 * 크롤러는 리다이렉트를 따라가 canonical 로 수렴하므로 색인이 갈라지지 않는다.
 */
export default async function LegacySiteRedirect({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const lang = pickLang((await headers()).get("accept-language"));
  permanentRedirect(`/${lang}/site/${encodeURIComponent(storeId)}`);
}
