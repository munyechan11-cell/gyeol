import { useMemo, useRef, useState } from "react";
import { Camera, Trash2, Image as ImageIcon, Check, Link2, Star, MessageSquare, AlertTriangle, Reply } from "lucide-react";
import { OwnerShell } from "../../components/layout/OwnerShell";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { deleteField } from "../../lib/db";
import { useStore } from "../../store/store";
import type { Photo } from "../../lib/types";
import { unwrapAiContent } from "../../lib/aiText";
import { showToast } from "../../lib/toast";
import { useLanguage, t, getLocale } from "../../lib/i18n";

// Firestore 문서 1MB 제한을 고려, base64 inflation 33% 감안하여 안전 한도 ~700KB
const MAX_BASE64_BYTES = 700_000;

export async function resizeImage(file: File, maxDim = 1280): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const tryEncode = (targetDim: number, quality: number): string => {
          const scale = Math.min(1, targetDim / Math.max(img.width, img.height));
          const w = Math.round(img.width * scale);
          const h = Math.round(img.height * scale);
          const canvas = document.createElement("canvas");
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("canvas");
          ctx.drawImage(img, 0, 0, w, h);
          return canvas.toDataURL("image/jpeg", quality);
        };

        try {
          // 점진적 다운스케일: 1280 → 1024 → 800 → 600 까지 크기 줄여가며 한도 맞춤
          const stages: [number, number][] = [
            [maxDim, 0.85],
            [1024, 0.82],
            [800, 0.78],
            [600, 0.72],
          ];
          let result = "";
          for (const [dim, q] of stages) {
            result = tryEncode(dim, q);
            if (result.length <= MAX_BASE64_BYTES) {
              return resolve(result);
            }
          }
          // 끝까지 줄였는데도 크면 그대로 반환 (Firestore에서 거부될 수 있음)
          resolve(result);
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = reject;
      img.src = reader.result as string;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

type TabKey = "review" | "photo";
// 사진 보기 탭에서 어떤 type 의 사진을 새로 추가할지 — 기본은 메뉴
type PhotoAddType = "menu" | "customer";

export default function OwnerPhotoVault() {
  const { effectiveStoreId, photos, addPhoto, updatePhoto, deletePhoto } = useStore();
  const storeId = effectiveStoreId;
  const lang = useLanguage();
  const [tab, setTab] = useState<TabKey>("review");
  const [addType, setAddType] = useState<PhotoAddType>("menu");
  const [pairFrom, setPairFrom] = useState<Photo | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // 리뷰 필터: 전체/별점/답변 안한 것
  const [rvFilter, setRvFilter] = useState<"all" | 1 | 2 | 3 | 4 | 5 | "unanswered">("all");
  // 어떤 리뷰 카드의 답글을 편집 중인지 — id가 들어있으면 그 카드의 폼이 열림
  const [replyEditingId, setReplyEditingId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");

  // 리뷰 탭: type==="review" 인 항목 (글/별점만 있어도 표시)
  const reviews = useMemo(
    () =>
      photos
        .filter((p) => p.storeId === storeId && p.type === "review")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [photos, storeId]
  );
  // 필터 적용된 리뷰 목록
  const filteredReviews = useMemo(() => {
    if (rvFilter === "all") return reviews;
    if (rvFilter === "unanswered") return reviews.filter((r) => !r.ownerReply);
    return reviews.filter((r) => r.rating === rvFilter);
  }, [reviews, rvFilter]);

  // 최근 7일 내 부정 리뷰(1·2점) 존재 여부 — 상단 경고 카드용
  const hasRecentNegative = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86_400_000;
    return reviews.some(
      (r) =>
        (r.rating === 1 || r.rating === 2) &&
        new Date(r.createdAt).getTime() >= weekAgo &&
        !r.ownerReply
    );
  }, [reviews]);

  // 별점별 카운트 — 필터 칩에 배지로 노출
  const ratingCounts = useMemo(() => {
    const c = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, unanswered: 0 };
    for (const r of reviews) {
      if (r.rating && r.rating >= 1 && r.rating <= 5) c[r.rating as 1 | 2 | 3 | 4 | 5]++;
      if (!r.ownerReply) c.unanswered++;
    }
    return c;
  }, [reviews]);

  const startReply = (r: Photo) => {
    setReplyEditingId(r.id);
    setReplyDraft(unwrapAiContent(r.ownerReply?.text)); // 과거 JSON 오염 데이터도 본문만
  };
  const saveReply = async (r: Photo) => {
    const text = replyDraft.trim();
    if (!text) return;
    await updatePhoto(r.id, {
      ownerReply: { text, repliedAt: new Date().toISOString() },
    });
    setReplyEditingId(null);
    setReplyDraft("");
    showToast(t("ophv.review.replyToastSaved", lang), "success");
  };
  const cancelReply = () => {
    setReplyEditingId(null);
    setReplyDraft("");
  };
  const deleteReply = async (r: Photo) => {
    if (!confirm(t("ophv.review.replyDeleteConfirm", lang))) return;
    // undefined 는 병합에서 무시되므로, 필드를 없애려면 deleteField() 를 쓴다
    await updatePhoto(r.id, { ownerReply: deleteField() as any });
    showToast(t("ophv.review.replyToastDeleted", lang), "info");
  };
  // 사진 탭: imageData 가 있는 모든 항목 (menu/customer/review 통합)
  const allPhotos = useMemo(
    () =>
      photos
        .filter((p) => p.storeId === storeId && !!p.imageData)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [photos, storeId]
  );

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast(t("ophv.toast.invalidImage", lang), "error");
      return;
    }
    try {
      const data = await resizeImage(file);
      if (data.length > 950_000) {
        showToast(t("ophv.toast.tooBig", lang), "error");
        return;
      }
      await addPhoto({ storeId, type: addType, imageData: data });
      showToast(t("ophv.toast.added", lang), "success");
    } catch {
      showToast(t("ophv.toast.procFail", lang), "error");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const togglePair = async (target: Photo) => {
    if (!pairFrom) {
      setPairFrom(target);
      showToast(t("ophv.toast.pickPair", lang), "info");
      return;
    }
    if (pairFrom.id === target.id || pairFrom.type === target.type) {
      showToast(t("ophv.toast.diffType", lang), "error");
      setPairFrom(null);
      return;
    }
    await Promise.all([
      updatePhoto(pairFrom.id, { pairedPhotoId: target.id }),
      updatePhoto(target.id, { pairedPhotoId: pairFrom.id }),
    ]);
    showToast(t("ophv.toast.paired", lang), "success");
    setPairFrom(null);
  };

  // 리뷰 통계 — 별점 평균 / 개수
  const reviewStats = useMemo(() => {
    const rated = reviews.filter((r) => typeof r.rating === "number" && r.rating! > 0);
    const avg =
      rated.length > 0
        ? rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length
        : 0;
    return { count: reviews.length, ratedCount: rated.length, avg };
  }, [reviews]);

  return (
    <OwnerShell
      title={t("ophv.title", lang)}
      headerRight={
        tab === "photo" ? (
          <button
            onClick={() => fileRef.current?.click()}
            className="h-10 px-4 rounded-full bg-[var(--color-navy-700)] text-white inline-flex items-center gap-1.5 text-[13px] font-bold shadow-[var(--shadow-navy)]"
          >
            <Camera className="w-4 h-4" />
            {t("ophv.addPhoto", lang)}
          </button>
        ) : null
      }
    >
      <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={onPick} />

      <div>
        {/* 메인 탭: 리뷰 보기 / 사진 보기 */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-[var(--color-navy-50)] rounded-[14px] max-w-xs">
          {(["review", "photo"] as const).map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={`h-10 rounded-[10px] text-[12px] font-bold ${
                tab === tabKey ? "bg-white text-[var(--color-navy-800)]" : "text-[var(--color-ink-500)]"
              }`}
            >
              {tabKey === "review" ? t("ophv.tab.review", lang) : t("ophv.tab.photo", lang)}
            </button>
          ))}
        </div>

        {/* ===== 리뷰 보기 ===== */}
        {tab === "review" && (
          <>
            {/* 별점 요약 */}
            {reviews.length > 0 && (
              <Card padding="md" className="mt-3 flex items-center gap-4">
                <div className="flex items-center gap-1">
                  <Star className="w-5 h-5 fill-[#f59e0b] text-[#f59e0b]" />
                  <span className="text-[20px] font-extrabold text-[var(--color-navy-900)] tabular-nums">
                    {reviewStats.avg > 0 ? reviewStats.avg.toFixed(1) : "—"}
                  </span>
                </div>
                <div className="text-[12px] text-[var(--color-ink-500)] font-semibold">
                  {t("ophv.review.summary", lang, { count: reviewStats.count, rated: reviewStats.ratedCount })}
                </div>
              </Card>
            )}

            {/* 최근 부정 리뷰 경고 */}
            {hasRecentNegative && (
              <Card padding="md" className="mt-3 bg-[#fff1f0] border-[#ffd1cc] border-[1.5px]">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-[var(--color-danger)]" />
                  <p className="text-[12.5px] font-bold text-[var(--color-danger)]">
                    {t("ophv.review.warnNeg", lang)}
                  </p>
                </div>
              </Card>
            )}

            {/* 필터 칩 */}
            {reviews.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                <FilterChip
                  active={rvFilter === "all"}
                  onClick={() => setRvFilter("all")}
                  label={t("ophv.review.filter.all", lang)}
                  count={reviews.length}
                />
                <FilterChip
                  active={rvFilter === "unanswered"}
                  onClick={() => setRvFilter("unanswered")}
                  label={t("ophv.review.filter.unanswered", lang)}
                  count={ratingCounts.unanswered}
                  tone="warn"
                />
                {([5, 4, 3, 2, 1] as const).map((n) => (
                  <FilterChip
                    key={n}
                    active={rvFilter === n}
                    onClick={() => setRvFilter(n)}
                    label={t("ophv.review.filter.stars", lang, { n })}
                    count={ratingCounts[n]}
                    tone={n <= 2 ? "danger" : undefined}
                  />
                ))}
              </div>
            )}

            {reviews.length === 0 ? (
              <Card padding="lg" className="text-center text-[14px] text-[var(--color-ink-500)] mt-4">
                <MessageSquare className="w-8 h-8 text-[var(--color-ink-300)] mx-auto mb-2" />
                {t("ophv.review.empty", lang)}
                <p className="text-[12px] text-[var(--color-ink-400)] mt-1 font-medium">
                  {t("ophv.review.emptyDesc", lang)}
                </p>
              </Card>
            ) : filteredReviews.length === 0 ? (
              <Card padding="lg" className="text-center text-[14px] text-[var(--color-ink-500)] mt-4">
                {t("ophv.review.emptyFilter", lang)}
              </Card>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4 pb-8">
                {filteredReviews.map((r) => {
                  const locale = getLocale(lang);
                  return (
                  <Card key={r.id} padding="md" className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      {typeof r.rating === "number" && r.rating > 0 ? (
                        <div className="flex items-center gap-0.5">
                          {[1, 2, 3, 4, 5].map((n) => (
                            <Star
                              key={n}
                              className={`w-4 h-4 ${
                                n <= (r.rating ?? 0)
                                  ? "fill-[#f59e0b] text-[#f59e0b]"
                                  : "text-[var(--color-ink-200)]"
                              }`}
                            />
                          ))}
                          <span className="ml-1 text-[12px] font-bold text-[var(--color-navy-700)] tabular-nums">
                            {t("ophv.review.rating", lang, { n: r.rating ?? 0 })}
                          </span>
                        </div>
                      ) : (
                        <span className="text-[11px] font-bold text-[var(--color-ink-400)]">
                          {t("ophv.review.noRating", lang)}
                        </span>
                      )}
                      <span className="ml-auto text-[11px] text-[var(--color-ink-400)] font-semibold tabular-nums">
                        {new Date(r.createdAt).toLocaleDateString(locale, {
                          month: "short",
                          day: "numeric",
                        })}
                      </span>
                      <button
                        onClick={() => {
                          if (confirm(t("ophv.review.deleteConfirm", lang))) deletePhoto(r.id);
                        }}
                        className="w-7 h-7 rounded-full hover:bg-[var(--color-danger)]/10 inline-flex items-center justify-center text-[var(--color-danger)]"
                        aria-label={t("ophv.review.deleteAria", lang)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    {r.imageData && (
                      <img
                        src={r.imageData}
                        alt=""
                        className="w-full max-h-60 object-cover rounded-xl bg-[var(--color-ink-50)]"
                      />
                    )}
                    {r.reviewText && (
                      <p className="text-[13.5px] text-[var(--color-navy-900)] break-keep leading-relaxed">
                        {r.reviewText}
                      </p>
                    )}
                    <p className="text-[11px] text-[var(--color-ink-500)] font-semibold">
                      {r.customerName ?? t("ophv.review.anonymous", lang)}
                      {r.tableNumber ? t("ophv.review.tableSuffix", lang, { n: r.tableNumber }) : ""}
                    </p>

                    {/* 사장님 답글 영역 */}
                    {r.ownerReply && replyEditingId !== r.id ? (
                      <div className="mt-1 rounded-[10px] bg-[var(--color-mint-50)] border border-[var(--color-mint-200)] p-3">
                        <div className="flex items-center gap-1.5 mb-1">
                          <Reply className="w-3.5 h-3.5 text-[var(--color-mint-700)]" />
                          <p className="text-[11px] font-extrabold text-[var(--color-mint-700)] uppercase tracking-wider">
                            {t("ophv.review.replyLabel", lang)}
                          </p>
                          <span className="ml-auto text-[10.5px] text-[var(--color-ink-500)] tabular-nums">
                            {new Date(r.ownerReply.repliedAt).toLocaleDateString(locale, {
                              month: "short",
                              day: "numeric",
                            })}
                          </span>
                        </div>
                        <p className="text-[13px] text-[var(--color-navy-900)] break-keep leading-relaxed whitespace-pre-wrap">
                          {unwrapAiContent(r.ownerReply.text)}
                        </p>
                        <div className="flex items-center gap-1.5 mt-2">
                          <button
                            onClick={() => startReply(r)}
                            className="h-8 px-3 rounded-full bg-white border border-[var(--color-mint-300)] text-[11.5px] font-bold text-[var(--color-mint-700)]"
                          >
                            {t("ophv.review.replyEdit", lang)}
                          </button>
                          <button
                            onClick={() => deleteReply(r)}
                            className="h-8 px-3 rounded-full text-[11.5px] font-bold text-[var(--color-danger)] hover:bg-[var(--color-danger)]/10"
                          >
                            {t("ophv.review.replyDelete", lang)}
                          </button>
                        </div>
                      </div>
                    ) : replyEditingId === r.id ? (
                      <div className="mt-1 rounded-[10px] bg-[var(--color-bg)] border border-[var(--color-line)] p-2.5">
                        {/* 빠른 답글 템플릿 — 별점에 따라 자동 분기 (저점=사과, 고점=감사) */}
                        <div className="flex items-center gap-1 flex-wrap mb-2">
                          <span className="text-[10.5px] font-bold text-[var(--color-ink-500)] uppercase tracking-wider mr-1">
                            {t("ophv.review.tmpl.label", lang)}
                          </span>
                          {(() => {
                            const isLow = typeof r.rating === "number" && r.rating <= 2;
                            const isHigh = typeof r.rating === "number" && r.rating >= 4;
                            const tmpls: Array<{ key: string; toned?: "danger" | "ok" }> = isLow
                              ? [
                                  { key: "ophv.review.tmpl.apology", toned: "danger" },
                                  { key: "ophv.review.tmpl.thanks" },
                                ]
                              : isHigh
                                ? [
                                    { key: "ophv.review.tmpl.positive", toned: "ok" },
                                    { key: "ophv.review.tmpl.thanks" },
                                  ]
                                : [
                                    { key: "ophv.review.tmpl.thanks" },
                                    { key: "ophv.review.tmpl.positive" },
                                  ];
                            return tmpls.map((tp) => (
                              <button
                                key={tp.key}
                                onClick={() =>
                                  setReplyDraft(t(tp.key, lang, { name: r.customerName ?? "" }).trim())
                                }
                                className={`h-7 px-2.5 rounded-full text-[11px] font-bold border ${
                                  tp.toned === "danger"
                                    ? "bg-[#fff1f0] text-[var(--color-danger)] border-[#ffd1cc]"
                                    : tp.toned === "ok"
                                      ? "bg-[var(--color-mint-50)] text-[var(--color-mint-700)] border-[var(--color-mint-200)]"
                                      : "bg-white text-[var(--color-ink-700)] border-[var(--color-line)]"
                                }`}
                              >
                                {tp.key === "ophv.review.tmpl.thanks"
                                  ? t("ophv.review.tmpl.chipThanks", lang)
                                  : tp.key === "ophv.review.tmpl.apology"
                                    ? t("ophv.review.tmpl.chipApology", lang)
                                    : t("ophv.review.tmpl.chipPositive", lang)}
                              </button>
                            ));
                          })()}
                        </div>
                        <textarea
                          value={replyDraft}
                          onChange={(e) => setReplyDraft(e.target.value)}
                          placeholder={t("ophv.review.replyPh", lang)}
                          rows={3}
                          autoFocus
                          className="w-full bg-white border border-[var(--color-line)] rounded-lg px-3 py-2 text-[13px] resize-none focus:border-[var(--color-mint-500)] focus:outline-none"
                        />
                        <div className="flex items-center gap-1.5 mt-2">
                          <button
                            onClick={() => saveReply(r)}
                            disabled={!replyDraft.trim()}
                            className="h-9 px-4 rounded-full bg-[var(--color-mint-500)] text-white text-[12px] font-extrabold disabled:opacity-50"
                          >
                            {t("ophv.review.replyBtn", lang)}
                          </button>
                          <button
                            onClick={cancelReply}
                            className="h-9 px-3 rounded-full text-[12px] font-bold text-[var(--color-ink-600)] hover:bg-white"
                          >
                            {t("ophv.review.replyCancel", lang)}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        onClick={() => startReply(r)}
                        className="mt-1 h-9 w-full rounded-[10px] border border-dashed border-[var(--color-line)] text-[12.5px] font-bold text-[var(--color-ink-600)] hover:bg-[var(--color-mint-50)] hover:border-[var(--color-mint-300)] hover:text-[var(--color-mint-700)] inline-flex items-center justify-center gap-1.5"
                      >
                        <Reply className="w-3.5 h-3.5" />
                        {t("ophv.review.replyBtn", lang)}
                      </button>
                    )}
                  </Card>
                  );
                })}
              </div>
            )}
          </>
        )}

        {/* ===== 사진 보기 ===== */}
        {tab === "photo" && (
          <>
            {/* 사진 추가 시 분류 선택 */}
            <div className="flex items-center gap-2 mt-3">
              <span className="text-[12px] font-bold text-[var(--color-ink-500)]">{t("ophv.addType.label", lang)}</span>
              {(["menu", "customer"] as const).map((typ) => (
                <button
                  key={typ}
                  onClick={() => setAddType(typ)}
                  className={`h-8 px-3 rounded-full text-[12px] font-bold border ${
                    addType === typ
                      ? "bg-[var(--color-navy-700)] text-white border-transparent"
                      : "bg-white text-[var(--color-ink-600)] border-[var(--color-line)]"
                  }`}
                >
                  {typ === "menu" ? t("ophv.addType.menu", lang) : t("ophv.addType.customer", lang)}
                </button>
              ))}
            </div>

            {pairFrom && (
              <Card padding="md" className="mt-3 bg-[var(--color-mint-100)] border-transparent">
                <p className="text-[12px] font-bold text-[var(--color-mint-700)]">
                  {pairFrom.type === "menu" ? t("ophv.pairHint.customer", lang) : t("ophv.pairHint.menu", lang)}
                </p>
                <Button size="md" variant="ghost" className="mt-2" onClick={() => setPairFrom(null)}>{t("ophv.pairCancel", lang)}</Button>
              </Card>
            )}

            {allPhotos.length === 0 ? (
              <Card padding="lg" className="text-center text-[14px] text-[var(--color-ink-500)] mt-4">
                <ImageIcon className="w-8 h-8 text-[var(--color-ink-300)] mx-auto mb-2" />
                {t("ophv.photo.empty", lang)}
              </Card>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 mt-4 pb-8">
                {allPhotos.map((p) => (
                  <div key={p.id} className="relative group rounded-2xl overflow-hidden bg-[var(--color-ink-50)] aspect-square">
                    <img src={p.imageData} alt="" className="w-full h-full object-cover" />
                    {p.type === "review" && (
                      <span className="absolute top-2 left-2 bg-[#f59e0b] text-white text-[10px] font-extrabold px-2 py-0.5 rounded-full">
                        {t("ophv.photo.reviewBadge", lang)}
                      </span>
                    )}
                    {p.pairedPhotoId && (
                      <span className="absolute top-2 left-2 bg-[var(--color-mint-500)] text-white text-[11px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                        <Link2 className="w-3 h-3" />
                        {t("ophv.photo.pairBadge", lang)}
                      </span>
                    )}
                    {p.type === "menu" && (
                      <button
                        onClick={() =>
                          updatePhoto(p.id, {
                            snsConsent: !p.snsConsent,
                            // null로 명시해야 Firestore에서 필드가 실제로 비워짐 (undefined는 merge 시 변경 없음)
                            consentedAt: !p.snsConsent ? new Date().toISOString() : (null as any),
                          })
                        }
                        className={`absolute top-2 right-2 text-[11px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1 ${
                          p.snsConsent ? "bg-[var(--color-navy-700)] text-white" : "bg-white/80 text-[var(--color-ink-700)]"
                        }`}
                      >
                        <Check className="w-3 h-3" />
                        SNS
                      </button>
                    )}
                    <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent p-2 flex gap-1">
                      {p.type !== "review" && (
                        <button
                          onClick={() => togglePair(p)}
                          className="flex-1 h-8 rounded bg-white/90 text-[11px] font-bold text-[var(--color-navy-700)]"
                        >
                          {pairFrom?.id === p.id ? t("ophv.photo.pickedBtn", lang) : t("ophv.photo.pairBtn", lang)}
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (confirm(t("ophv.photo.deleteConfirm", lang))) deletePhoto(p.id);
                        }}
                        className="w-7 h-7 rounded bg-white/90 inline-flex items-center justify-center text-[var(--color-danger)] ml-auto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </OwnerShell>
  );
}

// ============================================================
// FilterChip — 별점/답변 필터 칩 (count 배지 포함)
// ============================================================
function FilterChip({
  active,
  onClick,
  label,
  count,
  tone,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  tone?: "warn" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? active
        ? "bg-[var(--color-danger)] text-white"
        : "bg-[#fff1f0] text-[var(--color-danger)]"
      : tone === "warn"
        ? active
          ? "bg-[#f0b400] text-white"
          : "bg-[#fff8e6] text-[#b07b00]"
        : active
          ? "bg-[var(--color-navy-700)] text-white"
          : "bg-white border border-[var(--color-line)] text-[var(--color-ink-700)]";
  return (
    <button
      onClick={onClick}
      className={`h-9 px-3 rounded-full text-[12px] font-extrabold inline-flex items-center gap-1.5 ${toneClass}`}
    >
      <span>{label}</span>
      <span className={`px-1.5 rounded-full text-[10.5px] tabular-nums ${active ? "bg-white/20" : "bg-[var(--color-bg)]"}`}>
        {count}
      </span>
    </button>
  );
}

