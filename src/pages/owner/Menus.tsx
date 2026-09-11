import { newId } from "../../lib/db";
import { useMemo, useRef, useState } from "react";
import { Plus, Trash2, ToggleLeft, ToggleRight, Pencil, Camera, X, ScanLine, Loader2, ChevronUp, ChevronDown } from "lucide-react";
import { OwnerShell } from "../../components/layout/OwnerShell";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { useStore } from "../../store/store";
import type { Menu, OptionGroup, MenuOption } from "../../lib/types";
import { showToast } from "../../lib/toast";
import { useEscapeClose } from "../../lib/useEscapeClose";
import { resizeImage } from "./PhotoVault";
import { useLanguage, t, fmtKRW } from "../../lib/i18n";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";

interface Draft {
  id?: string;
  name: string;
  price: string;
  category: string;
  description: string;
  posProductCode: string;
  isAvailable: boolean;
  imageUrl: string;
  optionGroups: OptionGroup[]; // 편집 중엔 항상 배열, 저장 시 비었으면 undefined 로
}

const emptyDraft: Draft = {
  name: "",
  price: "",
  category: "메인",
  description: "",
  posProductCode: "",
  isAvailable: true,
  imageUrl: "",
  optionGroups: [],
};

// 저장 직전 옵션 그룹 정리: 이름 빈 그룹·옵션 제거, 가감액 정수화. 유효 그룹만 반환.
function sanitizeOptionGroups(groups: OptionGroup[]): OptionGroup[] {
  const out: OptionGroup[] = [];
  for (const g of groups) {
    const name = g.name.trim();
    const options = g.options
      .map((o) => ({
        id: o.id,
        name: o.name.trim(),
        priceDelta: Number.isFinite(o.priceDelta) ? Math.round(o.priceDelta) : 0,
        ...(o.recipe?.length ? { recipe: o.recipe } : {}),
      }))
      .filter((o) => o.name);
    if (!name || options.length === 0) continue;
    out.push({ id: g.id, name, required: !!g.required, multiSelect: !!g.multiSelect, options });
  }
  return out;
}
const newOptionRow = (): MenuOption => ({ id: newId(), name: "", priceDelta: 0 });
const newOptionGroup = (): OptionGroup => ({ id: newId(), name: "", required: false, multiSelect: false, options: [newOptionRow()] });

// 메뉴판 스캔 검토용 항목 — 가격은 입력 편의상 문자열로 보관(Draft 와 동일 컨벤션)
interface ReviewItem {
  name: string;
  price: string;
  category: string;
}

export default function OwnerMenus() {
  const { effectiveStoreId, menus, addMenuItem, updateMenuItem, deleteMenuItem } = useStore();
  const storeId = effectiveStoreId;
  const lang = useLanguage();
  const myMenus = useMemo(
    () => menus.filter((m) => m.storeId === storeId).sort((a, b) => a.category.localeCompare(b.category)),
    [menus, storeId]
  );
  const grouped = useMemo(() => {
    const map: Record<string, Menu[]> = {};
    for (const m of myMenus) (map[m.category] ??= []).push(m);
    return map;
  }, [myMenus]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  useEscapeClose(!!draft, () => setDraft(null));

  // ===== 메뉴판 사진 스캔 → 일괄 등록 =====
  const [scanning, setScanning] = useState(false);
  const [review, setReview] = useState<ReviewItem[] | null>(null);
  const [activeCat, setActiveCat] = useState("");
  const [adding, setAdding] = useState<{ done: number; total: number } | null>(null);
  const boardFileRef = useRef<HTMLInputElement>(null);

  const reviewCats = useMemo(
    () => (review ? [...new Set(review.map((r) => r.category))] : []),
    [review]
  );
  // 선택 탭이 사라졌으면(마지막 항목을 옮김 등) 첫 탭으로 폴백
  const shownCat = reviewCats.includes(activeCat) ? activeCat : reviewCats[0] ?? "";

  const closeReview = () => {
    if (adding) return; // 추가 진행 중엔 닫기 금지
    if (review && review.length > 0 && !confirm(t("omenus.scan.discardConfirm", lang))) return;
    setReview(null);
  };
  useEscapeClose(!!review, closeReview);

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !draft) return;
    if (!file.type.startsWith("image/")) {
      showToast(t("omenus.err.invalidImage", lang), "error");
      return;
    }
    setUploading(true);
    try {
      const dataUrl = await resizeImage(file);
      setDraft({ ...draft, imageUrl: dataUrl });
    } catch {
      showToast(t("omenus.err.imageProc", lang), "error");
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim() || !draft.price) {
      showToast(t("omenus.err.required", lang), "error");
      return;
    }
    const price = Number(draft.price);
    if (!Number.isFinite(price) || price < 0) {
      showToast(t("omenus.err.price", lang), "error");
      return;
    }
    // 새 메뉴는 storeId 가 반드시 있어야 함 — 빈 매장 ID 로 잘못된 곳에 저장되는 사고 차단
    if (!draft.id && !storeId) {
      showToast(t("omenus.err.noStore", lang), "error");
      return;
    }
    const cleanedGroups = sanitizeOptionGroups(draft.optionGroups);
    // 문서 크기 폭주 방지 — 옵션 그룹/옵션 수 상한 (Firestore 1MB 문서 한도 보호)
    if (cleanedGroups.length > 20 || cleanedGroups.some((g) => g.options.length > 50)) {
      showToast(t("omenus.opt.tooMany", lang), "error");
      return;
    }
    const data = {
      name: draft.name.trim(),
      price,
      category: draft.category.trim() || t("omenus.otherCategory", lang),
      description: draft.description.trim(),
      posProductCode: draft.posProductCode.trim() || undefined,
      isAvailable: draft.isAvailable,
      imageUrl: draft.imageUrl || undefined,
      optionGroups: cleanedGroups.length ? cleanedGroups : undefined,
    };
    try {
      if (draft.id) {
        await updateMenuItem(draft.id, data);
        showToast(t("omenus.ok.updated", lang), "success");
      } else {
        await addMenuItem(storeId, data);
        showToast(t("omenus.ok.added", lang), "success");
      }
      setDraft(null);
    } catch (e: any) {
      showToast(t("omenus.err.saveFail", lang, { msg: e?.message ?? "" }), "error");
    }
  };

  // 메뉴판 사진 한 장 → AI OCR → 검토 항목 시드
  const onPickBoard = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      showToast(t("omenus.err.invalidImage", lang), "error");
      return;
    }
    setScanning(true);
    try {
      const image = await resizeImage(file, 1600); // 메뉴판 글자 가독성 위해 고해상도 우선(초과 시 자동 축소)
      const res = await fetch(api("/api/ai/menu-board"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({} as any));
        if (res.status === 503 || data?.error === "AI_NOT_CONFIGURED") {
          showToast(t("omenus.scan.notConfigured", lang), "error");
        } else if (res.status === 429) {
          showToast(data.error || t("omenus.scan.failed", lang), "error"); // 서버의 한글 레이트리밋 메시지 그대로
        } else {
          showToast(t("omenus.scan.failed", lang), "error");
        }
        return;
      }
      const data = (await res.json()) as { items?: { name: string; price: number; category: string }[] };
      const items = data.items ?? [];
      if (items.length === 0) {
        showToast(t("omenus.scan.empty", lang), "info");
        return;
      }
      const other = t("omenus.otherCategory", lang);
      const seeded: ReviewItem[] = items.map((i) => ({
        name: i.name,
        price: i.price ? String(i.price) : "",
        category: (i.category || "").trim() || other,
      }));
      setReview(seeded);
      setActiveCat(seeded[0].category);
    } catch {
      showToast(t("omenus.scan.failed", lang), "error");
    } finally {
      setScanning(false);
    }
  };

  const setReviewItem = (idx: number, patch: Partial<ReviewItem>) =>
    setReview((prev) => (prev ? prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)) : prev));
  const removeReviewItem = (idx: number) =>
    setReview((prev) => (prev ? prev.filter((_, i) => i !== idx) : prev));
  // 분류 이동: 현재 탭에 머무르게 둠(연속 재분류 시 자리 안 잃도록) — 옮긴 항목은 목록에서 빠짐
  const moveItemCategory = (idx: number, cat: string) => setReviewItem(idx, { category: cat });
  const addNewCategory = (idx: number) => {
    const name = prompt(t("omenus.scan.newCatPrompt", lang))?.trim();
    if (name) moveItemCategory(idx, name.slice(0, 40));
  };

  // 검토 항목 전체를 메뉴로 일괄 등록 (사진은 미포함 — 나중에 메뉴별 편집에서 추가)
  const saveAll = async () => {
    if (!review) return;
    if (!storeId) {
      showToast(t("omenus.err.noStore", lang), "error");
      return;
    }
    const other = t("omenus.otherCategory", lang);
    const valid = review
      .map((r) => ({ name: r.name.trim(), price: Number(r.price), category: r.category.trim() || other }))
      .filter((r) => r.name && Number.isFinite(r.price) && r.price >= 0);
    if (valid.length === 0) {
      showToast(t("omenus.err.required", lang), "error");
      return;
    }
    let done = 0;
    setAdding({ done: 0, total: valid.length });
    try {
      for (const r of valid) {
        await addMenuItem(storeId, { name: r.name, price: r.price, category: r.category, isAvailable: true }, true);
        done += 1;
        setAdding({ done, total: valid.length });
      }
      setReview(null);
      showToast(t("omenus.scan.added", lang, { n: done }), "success");
    } catch (e: any) {
      if (done > 0) showToast(t("omenus.scan.partial", lang, { done, total: valid.length }), "error");
      else showToast(t("omenus.err.saveFail", lang, { msg: e?.message ?? "" }), "error");
    } finally {
      setAdding(null);
    }
  };

  // 옵션 그룹 편집 핸들러
  const addGroup = () =>
    setDraft((d) => (d ? { ...d, optionGroups: [...d.optionGroups, newOptionGroup()] } : d));
  const removeGroup = (gi: number) =>
    setDraft((d) => (d ? { ...d, optionGroups: d.optionGroups.filter((_, i) => i !== gi) } : d));
  const patchGroup = (gi: number, patch: Partial<OptionGroup>) =>
    setDraft((d) => (d ? { ...d, optionGroups: d.optionGroups.map((g, i) => (i === gi ? { ...g, ...patch } : g)) } : d));
  const addOption = (gi: number) =>
    setDraft((d) => (d ? { ...d, optionGroups: d.optionGroups.map((g, i) => (i === gi ? { ...g, options: [...g.options, newOptionRow()] } : g)) } : d));
  const removeOption = (gi: number, oi: number) =>
    setDraft((d) => (d ? { ...d, optionGroups: d.optionGroups.map((g, i) => (i === gi ? { ...g, options: g.options.filter((_, j) => j !== oi) } : g)) } : d));
  const patchOption = (gi: number, oi: number, patch: Partial<MenuOption>) =>
    setDraft((d) => (d ? { ...d, optionGroups: d.optionGroups.map((g, i) => (i === gi ? { ...g, options: g.options.map((o, j) => (j === oi ? { ...o, ...patch } : o)) } : g)) } : d));
  // 순서 변경 (위/아래)
  const moveGroup = (gi: number, dir: -1 | 1) =>
    setDraft((d) => {
      if (!d) return d;
      const next = [...d.optionGroups];
      const j = gi + dir;
      if (j < 0 || j >= next.length) return d;
      [next[gi], next[j]] = [next[j], next[gi]];
      return { ...d, optionGroups: next };
    });
  const moveOption = (gi: number, oi: number, dir: -1 | 1) =>
    setDraft((d) =>
      d
        ? {
            ...d,
            optionGroups: d.optionGroups.map((g, i) => {
              if (i !== gi) return g;
              const opts = [...g.options];
              const j = oi + dir;
              if (j < 0 || j >= opts.length) return g;
              [opts[oi], opts[j]] = [opts[j], opts[oi]];
              return { ...g, options: opts };
            }),
          }
        : d
    );

  return (
    <OwnerShell
      title={t("omenus.title", lang)}
      headerRight={
        <div className="flex items-center gap-2">
          <button
            onClick={() => boardFileRef.current?.click()}
            disabled={scanning}
            className="h-10 px-3.5 rounded-full border border-[var(--color-navy-200)] text-[var(--color-navy-700)] inline-flex items-center gap-1.5 text-[13px] font-bold disabled:opacity-60"
          >
            {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanLine className="w-4 h-4" />}
            <span className="hidden sm:inline">{scanning ? t("omenus.scan.scanning", lang) : t("omenus.scanBtn", lang)}</span>
          </button>
          <button
            onClick={() => setDraft({ ...emptyDraft })}
            className="h-10 px-4 rounded-full bg-[var(--color-navy-700)] text-white inline-flex items-center gap-1.5 text-[13px] font-bold shadow-[var(--shadow-navy)]"
          >
            <Plus className="w-4 h-4" />
            {t("omenus.newBtn", lang)}
          </button>
          <input
            ref={boardFileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onPickBoard}
          />
        </div>
      }
    >
      <div>
        {myMenus.length === 0 && !draft && (
          <Card padding="lg" className="text-center body-md">
            {t("omenus.empty", lang)}
          </Card>
        )}

        {Object.entries(grouped).map(([cat, items]) => (
          <div key={cat} className="mt-2">
            <h3 className="label-xs px-1 mb-2 mt-3">
              {cat}
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {items.map((m) => (
                <Card key={m.id} padding="md" className="flex items-center gap-3">
                  {m.imageUrl ? (
                    <img
                      src={m.imageUrl}
                      alt={m.name}
                      className="w-14 h-14 rounded-xl object-cover flex-shrink-0 bg-[var(--color-ink-50)]"
                    />
                  ) : null}
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-bold text-[var(--color-navy-900)] break-keep">{m.name}</p>
                    <p className="text-[13px] text-[var(--color-ink-600)] line-clamp-2 break-keep">
                      <span className="font-semibold text-[var(--color-navy-700)]">{fmtKRW(m.price, lang)}</span>
                      {m.description ? ` · ${m.description}` : ""}
                    </p>
                  </div>
                  <button
                    onClick={() => updateMenuItem(m.id, { isAvailable: !m.isAvailable })}
                    className="p-1 text-[var(--color-navy-700)]"
                    aria-label={t("omenus.toggleAria", lang)}
                  >
                    {m.isAvailable === false ? (
                      <ToggleLeft className="w-6 h-6 text-[var(--color-ink-300)]" />
                    ) : (
                      <ToggleRight className="w-6 h-6" />
                    )}
                  </button>
                  <button
                    onClick={() =>
                      setDraft({
                        id: m.id,
                        name: m.name,
                        price: String(m.price),
                        category: m.category,
                        description: m.description ?? "",
                        posProductCode: m.posProductCode ?? "",
                        isAvailable: m.isAvailable !== false,
                        imageUrl: m.imageUrl ?? "",
                        optionGroups: (m.optionGroups ?? []).map((g) => ({ ...g, options: g.options.map((o) => ({ ...o })) })),
                      })
                    }
                    className="w-9 h-9 rounded-full hover:bg-[var(--color-navy-50)] inline-flex items-center justify-center text-[var(--color-navy-700)]"
                    aria-label={t("omenus.editAria", lang)}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Drawer-ish editor */}
      {draft && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={() => setDraft(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[480px] mx-auto bg-white rounded-t-[28px] sm:rounded-[28px] p-6 pb-[max(env(safe-area-inset-bottom),24px)] sm:pb-6 max-h-[88vh] overflow-y-auto"
          >
            <div className="w-12 h-1.5 rounded-full bg-[var(--color-ink-100)] mx-auto mb-5" />
            <h2 className="text-[18px] font-extrabold text-[var(--color-navy-900)] mb-4">
              {draft.id ? t("omenus.editTitle", lang) : t("omenus.newTitle", lang)}
            </h2>
            <div className="space-y-4">
              <div>
                <p className="label-xs mb-2">{t("omenus.field.photo", lang)}</p>
                <div className="flex items-center gap-3">
                  {draft.imageUrl ? (
                    <div className="relative">
                      <img
                        src={draft.imageUrl}
                        alt={t("omenus.photoAlt", lang)}
                        className="w-20 h-20 rounded-xl object-cover bg-[var(--color-ink-50)]"
                      />
                      <button
                        type="button"
                        onClick={() => setDraft({ ...draft, imageUrl: "" })}
                        className="absolute -top-1.5 -right-1.5 w-6 h-6 rounded-full bg-white border border-[var(--color-ink-200)] inline-flex items-center justify-center shadow-sm"
                        aria-label={t("omenus.photoRemove", lang)}
                      >
                        <X className="w-3.5 h-3.5 text-[var(--color-ink-700)]" />
                      </button>
                    </div>
                  ) : (
                    <div className="w-20 h-20 rounded-xl bg-[var(--color-ink-50)] inline-flex items-center justify-center text-[var(--color-ink-400)]">
                      <Camera className="w-6 h-6" />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                    className="h-10 px-4 rounded-full border border-[var(--color-ink-200)] text-[13px] font-semibold text-[var(--color-navy-700)] disabled:opacity-50"
                  >
                    {uploading ? t("omenus.photoProcessing", lang) : draft.imageUrl ? t("omenus.photoChange", lang) : t("omenus.photoPick", lang)}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={onPickImage}
                  />
                </div>
              </div>
              <Input
                label={t("omenus.field.name", lang)}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label={t("omenus.field.price", lang)}
                  inputMode="numeric"
                  value={draft.price}
                  onChange={(e) => setDraft({ ...draft, price: e.target.value.replace(/\D/g, "") })}
                />
                <Input
                  label={t("omenus.field.category", lang)}
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                />
              </div>
              <Input
                label={t("omenus.field.desc", lang)}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />

              {/* 옵션 그룹 (선택) — 온도/농도/양 등 */}
              <div className="rounded-[16px] border border-[var(--color-line)] p-3">
                <div className="flex items-center justify-between">
                  <p className="text-[13px] font-bold text-[var(--color-navy-900)]">{t("omenus.opt.section", lang)}</p>
                  <button type="button" onClick={addGroup} className="h-8 px-2.5 rounded-full bg-[var(--color-navy-50)] text-[12px] font-bold text-[var(--color-navy-700)]">
                    {t("omenus.opt.addGroup", lang)}
                  </button>
                </div>
                <p className="text-[11.5px] text-[var(--color-ink-400)] mt-1 leading-snug">{t("omenus.opt.hint", lang)}</p>
                {draft.optionGroups.length > 0 && (
                  <div className="space-y-3 mt-3">
                    {draft.optionGroups.map((g, gi) => (
                      <div key={g.id} className="rounded-[14px] bg-[var(--color-bg)] p-2.5">
                        <div className="flex items-center gap-2">
                          <input
                            value={g.name}
                            onChange={(e) => patchGroup(gi, { name: e.target.value })}
                            placeholder={t("omenus.opt.groupName", lang)}
                            className="flex-1 min-w-0 h-9 px-2.5 rounded-lg bg-white border border-[var(--color-line)] text-[13px] font-bold text-[var(--color-navy-900)] outline-none"
                          />
                          {draft.optionGroups.length > 1 && (
                            <div className="flex flex-col flex-shrink-0">
                              <button type="button" onClick={() => moveGroup(gi, -1)} disabled={gi === 0} aria-label={t("omenus.opt.moveUp", lang)} className="w-6 h-[18px] inline-flex items-center justify-center text-[var(--color-ink-400)] disabled:opacity-30"><ChevronUp className="w-3.5 h-3.5" /></button>
                              <button type="button" onClick={() => moveGroup(gi, 1)} disabled={gi === draft.optionGroups.length - 1} aria-label={t("omenus.opt.moveDown", lang)} className="w-6 h-[18px] inline-flex items-center justify-center text-[var(--color-ink-400)] disabled:opacity-30"><ChevronDown className="w-3.5 h-3.5" /></button>
                            </div>
                          )}
                          <button type="button" onClick={() => removeGroup(gi)} aria-label={t("omenus.opt.removeGroup", lang)} className="w-8 h-8 inline-flex items-center justify-center text-[var(--color-ink-400)] hover:text-[var(--color-danger)] flex-shrink-0">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        <div className="flex items-center gap-4 mt-2 px-0.5">
                          <button type="button" onClick={() => patchGroup(gi, { required: !g.required })} className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-ink-600)]">
                            {g.required ? <ToggleRight className="w-5 h-5 text-[var(--color-navy-700)]" /> : <ToggleLeft className="w-5 h-5 text-[var(--color-ink-300)]" />}
                            {t("omenus.opt.required", lang)}
                          </button>
                          <button type="button" onClick={() => patchGroup(gi, { multiSelect: !g.multiSelect })} className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-ink-600)]">
                            {g.multiSelect ? <ToggleRight className="w-5 h-5 text-[var(--color-navy-700)]" /> : <ToggleLeft className="w-5 h-5 text-[var(--color-ink-300)]" />}
                            {t("omenus.opt.multi", lang)}
                          </button>
                        </div>
                        <div className="space-y-1.5 mt-2">
                          {g.options.map((o, oi) => (
                            <div key={o.id} className="flex items-center gap-1.5">
                              <input
                                value={o.name}
                                onChange={(e) => patchOption(gi, oi, { name: e.target.value })}
                                placeholder={t("omenus.opt.optionName", lang)}
                                className="flex-1 min-w-0 h-9 px-2.5 rounded-lg bg-white border border-[var(--color-line)] text-[13px] font-semibold text-[var(--color-navy-900)] outline-none"
                              />
                              <button type="button" onClick={() => patchOption(gi, oi, { priceDelta: -o.priceDelta })} aria-label={t("omenus.opt.sign", lang)} className="w-9 h-9 rounded-lg bg-white border border-[var(--color-line)] text-[15px] font-extrabold text-[var(--color-navy-700)] flex-shrink-0">
                                {o.priceDelta < 0 ? "−" : "+"}
                              </button>
                              <input
                                value={o.priceDelta ? String(Math.abs(o.priceDelta)) : ""}
                                inputMode="numeric"
                                onChange={(e) => {
                                  const mag = Number(e.target.value.replace(/\D/g, "")) || 0;
                                  patchOption(gi, oi, { priceDelta: o.priceDelta < 0 ? -mag : mag });
                                }}
                                placeholder="0"
                                className="w-20 h-9 px-2 rounded-lg bg-white border border-[var(--color-line)] text-[13px] font-semibold text-[var(--color-navy-900)] outline-none text-right"
                              />
                              {g.options.length > 1 && (
                                <div className="flex flex-col flex-shrink-0">
                                  <button type="button" onClick={() => moveOption(gi, oi, -1)} disabled={oi === 0} aria-label={t("omenus.opt.moveUp", lang)} className="w-5 h-[18px] inline-flex items-center justify-center text-[var(--color-ink-400)] disabled:opacity-30"><ChevronUp className="w-3.5 h-3.5" /></button>
                                  <button type="button" onClick={() => moveOption(gi, oi, 1)} disabled={oi === g.options.length - 1} aria-label={t("omenus.opt.moveDown", lang)} className="w-5 h-[18px] inline-flex items-center justify-center text-[var(--color-ink-400)] disabled:opacity-30"><ChevronDown className="w-3.5 h-3.5" /></button>
                                </div>
                              )}
                              <button type="button" onClick={() => removeOption(gi, oi)} aria-label={t("omenus.opt.removeOption", lang)} className="w-8 h-8 inline-flex items-center justify-center text-[var(--color-ink-400)] hover:text-[var(--color-danger)] flex-shrink-0">
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          ))}
                          <button type="button" onClick={() => addOption(gi)} className="text-[12px] font-bold text-[var(--color-navy-700)] mt-0.5">
                            {t("omenus.opt.addOption", lang)}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Input
                label={t("omenus.field.pos", lang)}
                value={draft.posProductCode}
                onChange={(e) => setDraft({ ...draft, posProductCode: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 mt-6">
              {draft.id && (
                <Button
                  variant="outline"
                  className="text-[var(--color-danger)] border-[var(--color-danger)]/30"
                  leftIcon={<Trash2 className="w-4 h-4" />}
                  onClick={async () => {
                    if (confirm(t("omenus.deleteConfirm", lang))) {
                      await deleteMenuItem(draft.id!);
                      setDraft(null);
                    }
                  }}
                >
                  {t("omenus.delete", lang)}
                </Button>
              )}
              <Button onClick={save} className={draft.id ? "" : "col-span-2"}>
                {t("omenus.save", lang)}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 메뉴판 스캔 검토 모달 (카테고리 탭 + 일괄 등록) ===== */}
      {review && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4"
          onClick={closeReview}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[560px] mx-auto bg-white rounded-t-[28px] sm:rounded-[28px] p-5 sm:p-6 pb-[max(env(safe-area-inset-bottom),20px)] sm:pb-6 max-h-[92vh] flex flex-col"
          >
            <div className="w-12 h-1.5 rounded-full bg-[var(--color-ink-100)] mx-auto mb-4 sm:hidden" />
            <div className="mb-3">
              <h2 className="text-[18px] font-extrabold text-[var(--color-navy-900)]">
                {t("omenus.scan.reviewTitle", lang)}
                <span className="ml-2 text-[13px] font-bold text-[var(--color-navy-500)]">
                  {t("omenus.scan.itemCount", lang, { n: review.length })}
                </span>
              </h2>
              <p className="text-[12.5px] text-[var(--color-ink-500)] mt-1 leading-snug">
                {t("omenus.scan.reviewHint", lang)}
              </p>
            </div>

            {/* 카테고리 탭 */}
            <div className="flex gap-1.5 overflow-x-auto pb-2 -mx-1 px-1">
              {reviewCats.map((c) => {
                const n = review.filter((r) => r.category === c).length;
                const on = c === shownCat;
                return (
                  <button
                    key={c}
                    onClick={() => setActiveCat(c)}
                    aria-pressed={on}
                    className={cn(
                      "h-9 px-3 rounded-full text-[13px] font-bold whitespace-nowrap inline-flex items-center gap-1.5 flex-shrink-0",
                      on ? "bg-[var(--color-navy-700)] text-white" : "bg-[var(--color-bg)] text-[var(--color-ink-600)]"
                    )}
                  >
                    {c}
                    <span className={cn("text-[11px] font-semibold", on ? "text-white/80" : "text-[var(--color-ink-400)]")}>
                      {n}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* 항목 목록 (선택 분류만) */}
            <div className="flex-1 overflow-y-auto -mx-1 px-1 mt-1 space-y-2">
              {review.map((r, idx) =>
                r.category !== shownCat ? null : (
                  <div key={idx} className="rounded-[16px] border border-[var(--color-line)] p-3">
                    <div className="flex items-center gap-2">
                      <input
                        value={r.name}
                        onChange={(e) => setReviewItem(idx, { name: e.target.value })}
                        placeholder={t("omenus.scan.namePh", lang)}
                        className="flex-1 min-w-0 h-10 px-3 rounded-xl bg-[var(--color-bg)] text-[14px] font-semibold text-[var(--color-navy-900)] outline-none"
                      />
                      <button
                        onClick={() => removeReviewItem(idx)}
                        aria-label={t("omenus.scan.removeItem", lang)}
                        className="w-9 h-9 rounded-full inline-flex items-center justify-center text-[var(--color-ink-400)] hover:text-[var(--color-danger)] flex-shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2 mt-2">
                      <input
                        value={r.price}
                        inputMode="numeric"
                        onChange={(e) => setReviewItem(idx, { price: e.target.value.replace(/\D/g, "") })}
                        placeholder={t("omenus.scan.pricePh", lang)}
                        className="w-28 h-10 px-3 rounded-xl bg-[var(--color-bg)] text-[14px] font-semibold text-[var(--color-navy-900)] outline-none"
                      />
                      <span className="text-[12px] text-[var(--color-ink-400)] flex-shrink-0">
                        {t("omenus.scan.catLabel", lang)}
                      </span>
                      <select
                        value={r.category}
                        onChange={(e) =>
                          e.target.value === "__new__" ? addNewCategory(idx) : moveItemCategory(idx, e.target.value)
                        }
                        className="flex-1 min-w-0 h-10 px-2 rounded-xl bg-[var(--color-bg)] text-[13px] font-semibold text-[var(--color-navy-700)] outline-none"
                      >
                        {reviewCats.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                        <option value="__new__">{t("omenus.scan.newCat", lang)}</option>
                      </select>
                    </div>
                  </div>
                )
              )}
            </div>

            {/* 푸터 */}
            <div className="grid grid-cols-2 gap-3 mt-4">
              <Button variant="outline" onClick={closeReview} disabled={!!adding}>
                {t("omenus.scan.cancel", lang)}
              </Button>
              <Button onClick={saveAll} disabled={!!adding}>
                {adding
                  ? t("omenus.scan.adding", lang, { done: adding.done, total: adding.total })
                  : t("omenus.scan.addAll", lang, { n: review.length })}
              </Button>
            </div>
          </div>
        </div>
      )}
    </OwnerShell>
  );
}
