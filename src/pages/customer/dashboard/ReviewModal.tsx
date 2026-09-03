import { useState } from "react";
import { Star, Camera, X as XIcon } from "lucide-react";
import { resizeImage } from "../../owner/PhotoVault";
import { useLanguage, t, fmtKRW } from "../../../lib/i18n";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";
import { showToast } from "../../../lib/toast";


export function ReviewModal({
  unpaidTotal,
  onCancel,
  onSubmit,
}: {
  unpaidTotal: number;
  onCancel: () => void;
  onSubmit: (review?: { rating?: number; reviewText?: string; imageData?: string }) => void;
}) {
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const [image, setImage] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const lang = useLanguage();

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast(t("review.invalidImage", lang), "error");
      return;
    }
    setBusy(true);
    try {
      const data = await resizeImage(file);
      setImage(data);
    } catch {
      showToast(t("review.imageFail", lang), "error");
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    onSubmit({
      rating: rating > 0 ? rating : undefined,
      reviewText: text.trim() || undefined,
      imageData: image || undefined,
    });
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/50 flex items-end sm:items-center justify-center sm:p-4" onClick={onCancel}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[480px] mx-auto bg-white rounded-t-[28px] sm:rounded-[28px] p-6 pb-[max(env(safe-area-inset-bottom),24px)] sm:pb-6 max-h-[88vh] overflow-y-auto"
      >
        <div className="w-12 h-1.5 rounded-full bg-[var(--color-ink-100)] mx-auto mb-5" />
        <h2 className="text-[18px] font-extrabold text-[var(--color-navy-900)] mb-1">
          {t("review.title", lang)}
        </h2>
        <p className="text-[12.5px] text-[var(--color-ink-500)] font-medium mb-5">
          {t("review.desc", lang)}
        </p>

        {/* 별점 */}
        <div className="mb-4">
          <p className="text-[12px] font-bold text-[var(--color-navy-800)] mb-2">{t("review.rating", lang)}</p>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRating(rating === n ? 0 : n)}
                className="w-11 h-11 inline-flex items-center justify-center"
                aria-label={t("review.ratingValue", lang, { n })}
              >
                <Star
                  className={cn(
                    "w-8 h-8 transition-colors",
                    n <= rating
                      ? "fill-[#f59e0b] text-[#f59e0b]"
                      : "text-[var(--color-ink-300)]"
                  )}
                />
              </button>
            ))}
            {rating > 0 && (
              <span className="ml-2 text-[13px] font-bold text-[var(--color-navy-700)]">
                {t("review.ratingValue", lang, { n: rating })}
              </span>
            )}
          </div>
        </div>

        {/* 글 */}
        <div className="mb-4">
          <p className="text-[12px] font-bold text-[var(--color-navy-800)] mb-2">{t("review.text", lang)}</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 300))}
            placeholder={t("review.textPlaceholder", lang)}
            rows={3}
            className="w-full px-3 py-2.5 rounded-[12px] border-[1.5px] border-[var(--color-line)] text-[14px] focus:border-[var(--color-navy-700)] focus:outline-none resize-none"
          />
          <p className="text-[10.5px] text-[var(--color-ink-400)] text-right mt-1">{text.length}/300</p>
        </div>

        {/* 사진 */}
        <div className="mb-5">
          <p className="text-[12px] font-bold text-[var(--color-navy-800)] mb-2">{t("review.photo", lang)}</p>
          <div className="flex items-center gap-3">
            {image ? (
              <div className="relative">
                <img src={image} alt="" className="w-20 h-20 rounded-xl object-cover" />
                <button
                  type="button"
                  onClick={() => setImage("")}
                  className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-white border border-[var(--color-ink-200)] inline-flex items-center justify-center shadow-sm"
                  aria-label={t("review.removePhoto", lang)}
                >
                  <XIcon className="w-3.5 h-3.5 text-[var(--color-ink-700)]" />
                </button>
              </div>
            ) : (
              <label className="w-20 h-20 rounded-xl bg-[var(--color-ink-50)] inline-flex items-center justify-center text-[var(--color-ink-400)] cursor-pointer">
                <Camera className="w-6 h-6" />
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={onPickImage}
                />
              </label>
            )}
            <p className="text-[12px] text-[var(--color-ink-500)] font-medium flex-1">
              {busy
                ? t("review.photoBusy", lang)
                : image
                ? t("review.photoPicked", lang)
                : t("review.photoOne", lang)}
            </p>
          </div>
        </div>

        {/* 결제 요청 금액 + 세금 breakdown */}
        {(() => {
          const vat = Math.round((unpaidTotal * 0.1) / 1.1);
          const supply = unpaidTotal - vat;
          return (
            <div className="rounded-[12px] bg-[var(--color-bg)] px-3 py-3 mb-4 space-y-1">
              <div className="flex items-center justify-between text-[11.5px] text-[var(--color-ink-500)]">
                <span>{t("bill.supply", lang)}</span>
                <span className="tabular-nums">{fmtKRW(supply)}</span>
              </div>
              <div className="flex items-center justify-between text-[11.5px] text-[var(--color-ink-500)]">
                <span>{t("bill.vat", lang)}</span>
                <span className="tabular-nums">{fmtKRW(vat)}</span>
              </div>
              <div className="flex items-center justify-between pt-1.5 border-t border-dashed border-[var(--color-line)]">
                <span className="text-[12.5px] font-bold text-[var(--color-ink-700)]">{t("review.payAmount", lang)}</span>
                <span className="text-[16px] font-extrabold text-[var(--color-navy-900)] tabular-nums">
                  {fmtKRW(unpaidTotal)}
                </span>
              </div>
            </div>
          );
        })()}

        <div className="grid grid-cols-2 gap-2">
          <Button variant="ghost" size="md" onClick={() => onSubmit(undefined)}>
            {t("review.skip", lang)}
          </Button>
          <Button size="md" onClick={submit} disabled={busy}>
            {t("review.submit", lang)}
          </Button>
        </div>
      </div>
    </div>
  );
}
