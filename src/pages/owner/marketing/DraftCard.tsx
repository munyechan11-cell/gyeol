import { useState } from "react";
import { Sparkles, Check, X, Send, Pencil, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { useLanguage, t } from "../../../lib/i18n";
import type { MarketingDraft } from "../../../lib/types";
import { unwrapAiContent } from "../../../lib/aiText";


const STATUS_STYLE: Record<MarketingDraft["status"], string> = {
  draft: "bg-[var(--color-navy-50)] text-[var(--color-navy-700)]",
  approved: "bg-[var(--color-mint-100)] text-[var(--color-mint-700)]",
  published: "bg-[var(--color-mint-500)] text-white",
  rejected: "bg-[#fdecea] text-[#c0392b]",
};

export function DraftCard({
  draft,
  onApprove,
  onReject,
  onPublish,
  onEdit,
  onDelete,
  compact,
  bannedWords,
}: {
  draft: MarketingDraft;
  onApprove: (note?: string) => void;
  onReject: (note?: string) => void;
  onPublish: () => void;
  onEdit: (content: string) => void;
  onDelete: () => void;
  compact?: boolean;
  bannedWords: string[];
}) {
  const lang = useLanguage();
  const cleanContent = unwrapAiContent(draft.content); // 과거 JSON 오염 데이터도 본문만 표시/편집
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(cleanContent);
  const [showAudit, setShowAudit] = useState(false);
  const isDraft = draft.status === "draft";
  const isApproved = draft.status === "approved";
  // 가드레일: 콘텐츠에 금지어가 들어가 있으면 경고 + 승인/발행 시 명시적 확인 요구
  const bannedHits = bannedWords.filter((w) => cleanContent.includes(w));
  const confirmIfBanned = () =>
    bannedHits.length === 0 || window.confirm(t("magent.bannedConfirm", lang, { words: bannedHits.join(", ") }));

  return (
    <div className="rounded-2xl bg-white border border-[var(--color-line)] p-4">
      <div className="flex items-center gap-1.5 mb-2 flex-wrap">
        <span className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full ${STATUS_STYLE[draft.status]}`}>
          {t(`magent.status.${draft.status}`, lang)}
        </span>
        <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-[var(--color-bg)] text-[var(--color-ink-600)]">
          {t(`magent.channel.${draft.channel}`, lang)}
        </span>
        <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-[var(--color-bg)] text-[var(--color-ink-600)]">
          {t(`magent.kind.${draft.kind}`, lang)}
        </span>
        {draft.source === "agent" && (
          <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-[var(--color-mint-50)] text-[var(--color-mint-700)] inline-flex items-center gap-0.5">
            <Sparkles className="w-3 h-3" />AI
          </span>
        )}
      </div>

      {draft.targetSummary && (
        <p className="text-[11.5px] text-[var(--color-ink-500)] bg-[var(--color-bg)] rounded-lg px-2.5 py-1.5 mb-2 line-clamp-2">
          <span className="font-bold">{t("magent.replyTo", lang)}:</span> {draft.targetSummary}
        </p>
      )}
      {editing ? (
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={3}
          className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-line)] text-[14px] bg-white resize-y mb-2"
        />
      ) : (
        <p className={`text-[13.5px] text-[var(--color-ink-700)] whitespace-pre-wrap leading-relaxed ${compact ? "line-clamp-2" : ""}`}>
          {cleanContent}
        </p>
      )}

      {bannedHits.length > 0 && (isDraft || isApproved) && (
        <p className="mt-2 text-[11.5px] font-bold text-[#c0392b] bg-[#fdecea] rounded-lg px-2.5 py-1.5 inline-flex items-center gap-1">
          <X className="w-3.5 h-3.5" aria-hidden="true" />
          {t("magent.bannedBadge", lang, { words: bannedHits.join(", ") })}
        </p>
      )}

      {/* 액션 — draft: 수정/승인/거절/삭제 · approved: 발행 */}
      <div className="flex items-center gap-1.5 mt-3 flex-wrap">
        {editing ? (
          <>
            <button onClick={() => { onEdit(editText); setEditing(false); }} className="h-8 px-3 rounded-lg bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)] text-[12px] font-bold">
              {t("magent.saveEdit", lang)}
            </button>
            <button onClick={() => { setEditText(cleanContent); setEditing(false); }} className="h-8 px-3 rounded-lg bg-[var(--color-bg)] text-[var(--color-ink-600)] text-[12px] font-bold">
              {t("magent.cancel", lang)}
            </button>
          </>
        ) : (
          <>
            {isDraft && (
              <>
                <button onClick={() => { if (confirmIfBanned()) onApprove(); }} className="h-8 px-3 rounded-lg bg-[var(--color-mint-600)] text-white text-[12px] font-bold inline-flex items-center gap-1">
                  <Check className="w-3.5 h-3.5" />{t("magent.approve", lang)}
                </button>
                <button onClick={() => { const r = window.prompt(t("magent.rejectReason", lang)); if (r !== null) onReject(r); }} className="h-8 px-3 rounded-lg bg-[#fdecea] text-[#c0392b] text-[12px] font-bold inline-flex items-center gap-1">
                  <X className="w-3.5 h-3.5" />{t("magent.reject", lang)}
                </button>
                <button onClick={() => { setEditText(cleanContent); setEditing(true); }} className="h-8 px-3 rounded-lg bg-[var(--color-bg)] text-[var(--color-ink-700)] text-[12px] font-bold inline-flex items-center gap-1">
                  <Pencil className="w-3.5 h-3.5" />{t("magent.edit", lang)}
                </button>
              </>
            )}
            {isApproved && (
              <button onClick={() => { if (confirmIfBanned()) onPublish(); }} className="h-8 px-3 rounded-lg bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)] text-[12px] font-bold inline-flex items-center gap-1">
                <Send className="w-3.5 h-3.5" />{t("magent.publish", lang)}
              </button>
            )}
            <button onClick={onDelete} className="h-8 px-2.5 rounded-lg bg-[var(--color-bg)] text-[var(--color-ink-500)] text-[12px] font-bold inline-flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setShowAudit((v) => !v)} className="h-8 px-2.5 rounded-lg text-[var(--color-ink-500)] text-[11.5px] font-bold inline-flex items-center gap-0.5 ml-auto">
              {t("magent.audit", lang)} {showAudit ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </>
        )}
      </div>

      {/* 감사 로그 */}
      {showAudit && (
        <div className="mt-3 pt-3 border-t border-[var(--color-line-soft)] space-y-1">
          {(draft.audit ?? []).map((a, i) => (
            <div key={i} className="text-[11.5px] text-[var(--color-ink-500)] tabular-nums flex items-center gap-2">
              <span className="font-bold text-[var(--color-ink-700)]">{t(`magent.log.${a.action}`, lang)}</span>
              <span>{new Date(a.at).toLocaleString()}</span>
              {a.note && <span className="text-[var(--color-ink-600)]">· {a.note}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
