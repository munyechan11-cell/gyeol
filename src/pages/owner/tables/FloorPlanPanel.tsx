import { useRef, useState } from "react";
import { ImagePlus, Sparkles, X, Wand2, Pencil } from "lucide-react";
import { Card } from "../../../components/ui/Card";
import { Button } from "../../../components/ui/Button";
import { useLanguage, t } from "../../../lib/i18n";
import { SketchPad } from "./SketchPad";

// ============================================================
// 도면 업로드 + AI 초안 패널
// ============================================================
export function FloorPlanPanel({
  hasImage,
  currentImage,
  opacity,
  onUpload,
  onRemove,
  onOpacity,
  onSketchSave,
  aiLoading,
  aiDraftCount,
  onRunAi,
  onApplyAi,
  onDiscardAi,
}: {
  hasImage: boolean;
  currentImage: string | null;
  opacity: number;
  onUpload: (f: File) => void;
  onRemove: () => void;
  onOpacity: (v: number) => void;
  onSketchSave: (dataUrl: string) => void;
  aiLoading: boolean;
  aiDraftCount: number;
  onRunAi: () => void;
  onApplyAi: () => void;
  onDiscardAi: () => void;
}) {
  const lang = useLanguage();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sketchOpen, setSketchOpen] = useState(false);
  return (
    <Card padding="md" className="mt-4">
      <div className="flex items-center gap-2 mb-3">
        <ImagePlus className="w-4 h-4 text-[var(--color-navy-700)]" />
        <h3 className="text-[14px] font-bold text-[var(--color-navy-900)]">{t("otables.floorplan.title", lang)}</h3>
        <span className="ml-auto text-[10.5px] text-[var(--color-ink-400)] font-medium">
          {t("otables.floorplan.localOnly", lang)}
        </span>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onUpload(f);
          e.target.value = "";
        }}
      />

      {!hasImage ? (
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="h-28 rounded-[12px] border-2 border-dashed border-[var(--color-line)] hover:border-[var(--color-navy-700)] hover:bg-[var(--color-navy-50)] flex flex-col items-center justify-center gap-1 text-[var(--color-ink-500)] hover:text-[var(--color-navy-700)] transition-colors"
          >
            <ImagePlus className="w-5 h-5" />
            <span className="text-[13px] font-bold">{t("otables.floorplan.upload", lang)}</span>
            <span className="text-[11px] font-medium opacity-70">JPG · PNG</span>
          </button>
          <button
            onClick={() => setSketchOpen(true)}
            className="h-28 rounded-[12px] border-2 border-dashed border-[var(--color-mint-300)] hover:border-[var(--color-mint-500)] bg-[var(--color-mint-50)]/40 hover:bg-[var(--color-mint-50)] flex flex-col items-center justify-center gap-1 text-[var(--color-mint-700)] transition-colors"
          >
            <Pencil className="w-5 h-5" />
            <span className="text-[13px] font-bold">{t("otables.floorplan.draw", lang)}</span>
            <span className="text-[11px] font-medium opacity-70">{t("otables.floorplan.drawDesc", lang)}</span>
          </button>
        </div>
      ) : (
        <div className="space-y-2.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              onClick={() => fileRef.current?.click()}
              className="h-9 px-2.5 sm:px-3 rounded-full bg-[var(--color-navy-50)] text-[12px] font-bold text-[var(--color-navy-800)] inline-flex items-center gap-1"
              aria-label={t("otables.floorplan.reupload", lang)}
            >
              <ImagePlus className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{t("otables.floorplan.reupload", lang)}</span>
            </button>
            <button
              onClick={() => setSketchOpen(true)}
              className="h-9 px-2.5 sm:px-3 rounded-full bg-[var(--color-mint-50)] text-[12px] font-bold text-[var(--color-mint-700)] inline-flex items-center gap-1"
              aria-label={t("otables.floorplan.editSketch", lang)}
            >
              <Pencil className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{t("otables.floorplan.editSketch", lang)}</span>
            </button>
            <button
              onClick={onRemove}
              className="h-9 px-2.5 sm:px-3 rounded-full hover:bg-[#fef2f2] text-[12px] font-bold text-[var(--color-danger)] inline-flex items-center gap-1"
              aria-label={t("otables.floorplan.remove", lang)}
            >
              <X className="w-3.5 h-3.5" /> <span className="hidden sm:inline">{t("otables.floorplan.remove", lang)}</span>
            </button>
            <div className="ml-auto flex items-center gap-1.5 w-full sm:w-auto sm:min-w-[140px] mt-1.5 sm:mt-0">
              <span className="text-[11px] font-bold text-[var(--color-ink-600)] whitespace-nowrap">{t("otables.floorplan.opacity", lang, { pct: opacity })}</span>
              <input
                type="range"
                min={10}
                max={90}
                value={opacity}
                onChange={(e) => onOpacity(Number(e.target.value))}
                className="flex-1"
                aria-label={t("otables.floorplan.opacityAria", lang)}
              />
            </div>
          </div>

          {aiDraftCount > 0 ? (
            <div className="rounded-[12px] border-[1.5px] border-[var(--color-mint-300)] bg-[var(--color-mint-50)] p-3 flex flex-col sm:flex-row sm:items-center gap-2.5">
              <div className="flex-1">
                <p className="text-[13px] font-extrabold text-[var(--color-navy-900)] inline-flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-[var(--color-mint-700)]" />
                  {t("otables.ai.draftTitle", lang, { n: aiDraftCount })}
                </p>
                <p
                  className="text-[11.5px] text-[var(--color-ink-600)] mt-0.5"
                  dangerouslySetInnerHTML={{ __html: t("otables.ai.draftWarn", lang).replace(/<b>/g, '<b class="text-[var(--color-danger)]">') }}
                />
              </div>
              <div className="flex gap-2">
                <Button size="md" variant="ghost" onClick={onDiscardAi}>{t("otables.ai.cancel", lang)}</Button>
                <Button size="md" onClick={onApplyAi} leftIcon={<Wand2 className="w-4 h-4" />}>
                  {t("otables.ai.apply", lang)}
                </Button>
              </div>
            </div>
          ) : (
            <Button
              block
              variant="outline"
              loading={aiLoading}
              onClick={onRunAi}
              leftIcon={<Sparkles className="w-4 h-4" />}
            >
              {t("otables.ai.generate", lang)}
            </Button>
          )}
        </div>
      )}

      {sketchOpen && (
        <SketchPad
          initialDataUrl={currentImage}
          onClose={() => setSketchOpen(false)}
          onSave={(dataUrl) => {
            onSketchSave(dataUrl);
            setSketchOpen(false);
          }}
        />
      )}
    </Card>
  );
}

