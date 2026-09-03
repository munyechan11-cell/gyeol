import { t } from "./i18n";

// 도면 이미지 압축: 최대 폭 1280px, JPEG 0.8 — Firestore 1MB 제한 대응 + Vision API 토큰 절약
export async function compressImageToDataUrl(file: File, maxWidth = 1280): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error(t("otables.floorplan.readFail")));
    im.src = dataUrl;
  });
  const ratio = Math.min(1, maxWidth / img.width);
  const w = Math.round(img.width * ratio);
  const h = Math.round(img.height * ratio);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(t("otables.floorplan.canvasFail"));
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.8);
}
