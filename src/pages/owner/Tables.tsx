import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, RotateCcw, Sofa, DoorOpen, Layers, LayoutGrid, Move, List, Maximize2, Circle, Square, X } from "lucide-react";
import { OwnerShell } from "../../components/layout/OwnerShell";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { NumberField } from "../../components/ui/NumberField";
import { useStore } from "../../store/store";
import { cn } from "../../lib/cn";
import type { TableDoc } from "../../lib/types";
import { showToast } from "../../lib/toast";
import { api } from "../../lib/api";
import { useLanguage, t } from "../../lib/i18n";
import { compressImageToDataUrl } from "../../lib/image";
import { STATUS_FLOW } from "./tables/statusFlow";
import { FloorPlanPanel } from "./tables/FloorPlanPanel";
import { LayoutCanvas } from "./tables/LayoutCanvas";

type ViewMode = "list" | "layout";

export default function OwnerTables() {
  const {
    effectiveStoreId,
    tables,
    sections,
    addTable,
    deleteTable,
    updateTableStatus,
    updateTableLayout,
    initTables,
    addSection,
    deleteSection,
  } = useStore();
  const storeId = effectiveStoreId;
  const lang = useLanguage();
  const [view, setView] = useState<ViewMode>(() => {
    try {
      const raw = localStorage.getItem("gyeol:tables-view");
      return raw === "list" || raw === "layout" ? raw : "list";
    } catch {
      return "list";
    }
  });
  const [selected, setSelected] = useState<TableDoc | null>(null);
  const [newSection, setNewSection] = useState("");

  // ===== 도면 배경 (기기 로컬 저장 — 매장별) =====
  const floorPlanKey = useMemo(() => (storeId ? `gyeol:floorplan:${storeId}` : ""), [storeId]);
  const floorPlanOpKey = useMemo(() => (storeId ? `gyeol:floorplan-op:${storeId}` : ""), [storeId]);
  const [floorPlan, setFloorPlan] = useState<string | null>(null);
  const [floorPlanOpacity, setFloorPlanOpacity] = useState(35);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiDraft, setAiDraft] = useState<Array<Partial<TableDoc> & { number: number; type: TableDoc["type"]; x: number; y: number }> | null>(
    null
  );
  // AI가 인식한 구조물 (벽·문·룸 경계·카운터) — 테이블이 아니므로 Firestore에 저장 안 함, 캔버스에 시각적으로만 표시
  type AiStructure = {
    kind: "wall" | "door" | "room" | "counter";
    x: number; y: number; width: number; height: number;
    label?: string;
  };
  const [aiStructures, setAiStructures] = useState<AiStructure[] | null>(null);
  // AI 분석 시점의 캔버스 크기 (도면 종횡비 기반) — LayoutCanvas가 이걸 우선 사용
  const [aiCanvasSize, setAiCanvasSize] = useState<{ w: number; h: number } | null>(null);

  // 컴포넌트 마운트 상태 추적 — 비동기 이미지 측정 도중 언마운트 시 setState 경고 방지
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // 도면 dataURL을 받아 자연 크기 측정 후 aiCanvasSize 자동 설정 (캔버스-도면 정합 유지)
  const measureAndSetCanvas = async (dataUrl: string) => {
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error(t("otables.floorplan.measureFail", lang)));
        im.src = dataUrl;
      });
      if (!mountedRef.current) return;
      const MAX = 1200;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      setAiCanvasSize({ w: Math.round(img.width * scale), h: Math.round(img.height * scale) });
    } catch {
      if (mountedRef.current) setAiCanvasSize(null);
    }
  };

  useEffect(() => {
    if (!floorPlanKey) return;
    const stored = localStorage.getItem(floorPlanKey);
    setFloorPlan(stored);
    const op = Number(localStorage.getItem(floorPlanOpKey));
    if (!Number.isNaN(op) && op > 0) setFloorPlanOpacity(op);
    // 저장된 도면이 있으면 새로고침 후에도 캔버스 종횡비를 도면에 맞춰 유지
    if (stored) measureAndSetCanvas(stored);
    else setAiCanvasSize(null);
  }, [floorPlanKey, floorPlanOpKey]);

  // localStorage 쿼터 안전 저장 — 5MB 초과 시 친화 메시지
  const safeStoreFloorPlan = (dataUrl: string): boolean => {
    try {
      localStorage.setItem(floorPlanKey, dataUrl);
      return true;
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (e?.name === "QuotaExceededError" || msg.includes("quota")) {
        showToast(t("otables.floorplan.quota", lang), "error");
      } else {
        showToast(t("otables.floorplan.saveFail", lang, { msg }), "error");
      }
      return false;
    }
  };

  const onUploadFloorPlan = async (file: File) => {
    try {
      const compressed = await compressImageToDataUrl(file, 1280);
      // 일부 브라우저에서 5MB 넘으면 localStorage 실패 → 한 번 더 압축
      let final = compressed;
      if (final.length > 4_500_000) {
        final = await compressImageToDataUrl(file, 900);
      }
      if (!safeStoreFloorPlan(final)) return;
      setFloorPlan(final);
      // 새 도면 = 좌표계 재설정
      setAiDraft(null);
      setAiStructures(null);
      await measureAndSetCanvas(final);
      showToast(t("otables.floorplan.uploaded", lang), "success");
    } catch (e: any) {
      showToast(t("otables.floorplan.uploadFail", lang, { msg: e?.message ?? "" }), "error");
    }
  };

  const onRemoveFloorPlan = () => {
    try {
      localStorage.removeItem(floorPlanKey);
      localStorage.removeItem(floorPlanOpKey);
    } catch { /* 시크릿모드 등 — 무시 */ }
    setFloorPlan(null);
    setFloorPlanOpacity(35);
    setAiDraft(null);
    setAiStructures(null);
    setAiCanvasSize(null);
    showToast(t("otables.floorplan.removeDone", lang), "info");
  };

  const onChangeOpacity = (v: number) => {
    setFloorPlanOpacity(v);
    try {
      localStorage.setItem(floorPlanOpKey, String(v));
    } catch {
      /* 쿼터/시크릿모드 — 메모리 상 값만 유지 */
    }
  };

  const runAiDraft = async () => {
    if (!floorPlan) {
      showToast(t("otables.ai.uploadFirst", lang), "error");
      return;
    }
    // 분석 시작 시점의 매장 ID를 캡처 — 분석 중 매장 변경 시 결과 무시
    const requestStoreId = storeId;
    setAiLoading(true);
    // 60초 타임아웃 — Gemini 응답이 느릴 때 사용자가 영원히 기다리지 않도록
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60_000);
    try {
      // 1) 도면 이미지의 자연 크기를 측정 → 이미지 종횡비 그대로 캔버스 좌표계 구성
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error(t("otables.ai.cannotRead", lang)));
        im.src = floorPlan;
      });
      // 캔버스 최대 변을 1200px로 스케일 (긴 변 기준)
      const MAX = 1200;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const CW = Math.round(img.width * scale);
      const CH = Math.round(img.height * scale);

      const res = await fetch(api("/api/ai/floor-plan"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ image: floorPlan, canvasWidth: CW, canvasHeight: CH }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(t || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        tables: Array<{
          number?: number;
          x: number; y: number;
          width?: number; height?: number;
          shape?: "square" | "circle";
          seats?: number;
        }>;
        structures?: Array<{
          kind?: "wall" | "door" | "room" | "counter";
          x: number; y: number;
          width: number; height: number;
          label?: string;
        }>;
      };

      // 2) 정규화 좌표 (0~1) → 실제 픽셀로 변환
      const clamp = (v: number, min: number, max: number) =>
        Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : min;
      // AI가 정규화 대신 픽셀로 반환할 가능성도 있어 자동 감지
      const looksNormalized = (arr: { x: number; y: number; width?: number; height?: number }[]) => {
        if (!arr.length) return true;
        return arr.every((t) => (t.x ?? 0) <= 1.5 && (t.y ?? 0) <= 1.5 && (t.width ?? 0) <= 1.5 && (t.height ?? 0) <= 1.5);
      };
      const all = [...(data.tables ?? []), ...(data.structures ?? [])];
      const normalized = looksNormalized(all);
      const toPx = (v: number, isX: boolean) =>
        normalized ? Math.round(v * (isX ? CW : CH)) : Math.round(v);

      // 3) 테이블 정제 — 좌석만 추출, 번호 1부터 재부여
      const cleanedTables = (data.tables ?? [])
        .map((t) => {
          const w = clamp(toPx(t.width ?? 0.06, true) || 70, 30, 300);
          const h = clamp(toPx(t.height ?? 0.06, false) || 70, 30, 300);
          return {
            type: "table" as TableDoc["type"], // AI 응답은 자리만 받음. room/door는 structures로 분리
            x: clamp(toPx(t.x, true), 0, CW - w),
            y: clamp(toPx(t.y, false), 0, CH - h),
            width: w,
            height: h,
            shape: (t.shape === "circle" ? "circle" : "square") as "square" | "circle",
            seats: clamp(t.seats ?? 4, 1, 30),
          };
        })
        .map((t, i) => ({ ...t, number: i + 1 }));

      // 4) 구조물 정제 — 벽/문/룸/카운터 (Firestore 저장 X, 시각 안내용)
      const VALID_KINDS = new Set(["wall", "door", "room", "counter"]);
      const cleanedStructures = (data.structures ?? [])
        .filter((s) => VALID_KINDS.has(s.kind ?? "wall"))
        .map((s) => ({
          kind: (s.kind ?? "wall") as AiStructure["kind"],
          x: clamp(toPx(s.x, true), 0, CW),
          y: clamp(toPx(s.y, false), 0, CH),
          width: clamp(toPx(s.width, true) || 20, 4, CW),
          height: clamp(toPx(s.height, false) || 20, 4, CH),
          label: s.label?.slice(0, 20),
        }));

      if (cleanedTables.length === 0 && cleanedStructures.length === 0) {
        throw new Error(t("otables.ai.empty", lang));
      }

      // 분석 중 매장이 바뀌었다면 결과 폐기 — 다른 매장에 적용되지 않도록
      if (requestStoreId !== storeId) {
        showToast(t("otables.ai.storeChanged", lang), "info");
        return;
      }

      setAiCanvasSize({ w: CW, h: CH });
      setAiDraft(cleanedTables);
      setAiStructures(cleanedStructures.length ? cleanedStructures : null);
      const structSuffix = cleanedStructures.length ? t("otables.ai.structSuffix", lang, { n: cleanedStructures.length }) : "";
      const msg = t("otables.ai.recognized", lang, { tables: cleanedTables.length, structures: structSuffix });
      showToast(msg, "success");
    } catch (e: any) {
      const msg = String(e?.message ?? "");
      if (msg.includes("AI_NOT_CONFIGURED")) {
        showToast(t("otables.ai.notConfigured", lang), "error");
      } else if (msg.includes("429") || msg.includes("분당") || msg.includes("10초")) {
        showToast(t("otables.ai.rateLimit", lang), "error");
      } else if (msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("timeout")) {
        showToast(t("otables.ai.timeout", lang), "error");
      } else {
        showToast(t("otables.ai.failed", lang, { msg: msg || "" }), "error");
      }
    } finally {
      clearTimeout(timeoutId);
      setAiLoading(false);
    }
  };

  const applyAiDraft = async () => {
    if (!aiDraft || !storeId) return;
    // 적용 시점의 매장 ID 캡처 — 비동기 작업 중 매장 변경 방어
    const activeStoreId = storeId;
    const existing = tables.filter((t) => t.storeId === activeStoreId);
    // 명시적 confirm — destructive 작업
    if (existing.length > 0) {
      const ok = window.confirm(
        t("otables.ai.applyConfirm", lang, { existing: existing.length, next: aiDraft.length })
      );
      if (!ok) return;
    }
    setSelected(null); // 선택 해제 — 곧 삭제될 객체를 가리키지 않도록
    let deleteFails = 0;
    let createFails = 0;
    for (const tbl of existing) {
      try {
        await deleteTable(activeStoreId, tbl.number);
      } catch (e) {
        deleteFails++;
        console.error("[applyAiDraft delete]", tbl.number, e);
      }
    }
    for (const d of aiDraft) {
      const doc: TableDoc = {
        id: `${activeStoreId}_${d.number}`,
        number: d.number,
        storeId: activeStoreId,
        type: d.type,
        x: d.x,
        y: d.y,
        width: d.width ?? 70,
        height: d.height ?? 70,
        seats: d.seats ?? 4,
        shape: d.shape ?? "square",
        status: "available",
      };
      try {
        await updateTableLayout(activeStoreId, d.number, doc);
      } catch (e) {
        createFails++;
        console.error("[applyAiDraft create]", d.number, e);
      }
    }
    setAiDraft(null);
    setAiStructures(null);
    // aiCanvasSize는 의도적으로 유지 — 도면 종횡비 매칭이 깨지지 않도록
    // (사용자가 도면을 제거하거나 새로 업로드할 때만 reset)
    if (deleteFails === 0 && createFails === 0) {
      showToast(t("otables.ai.applyOk", lang), "success");
    } else {
      showToast(
        t("otables.ai.applyPartial", lang, { del: deleteFails, create: createFails }),
        "error"
      );
    }
  };

  const discardAiDraft = () => {
    setAiDraft(null);
    setAiStructures(null);
    setAiCanvasSize(null);
  };

  useEffect(() => {
    try {
      localStorage.setItem("gyeol:tables-view", view);
    } catch {
      /* 쿼터 초과·시크릿모드 등 — 다음 진입 시 기본값 사용 */
    }
  }, [view]);

  // 선택 동기화 (store 업데이트 반영) — 같은 내용이면 setSelected 생략해
  // 매 스냅샷마다 selected identity 가 바뀌어 하위 리렌더 폭주하던 문제 차단.
  useEffect(() => {
    if (!selected) return;
    const fresh = tables.find((t) => t.id === selected.id);
    if (!fresh) {
      setSelected(null);
      return;
    }
    // 얕은 비교로 변경 없으면 skip
    if (fresh === selected) return;
    let same = true;
    for (const k of Object.keys(fresh) as (keyof typeof fresh)[]) {
      if ((fresh as any)[k] !== (selected as any)[k]) { same = false; break; }
    }
    if (!same) setSelected(fresh);
  }, [tables, selected?.id]);

  // 모바일: 테이블 선택 시 상세 카드로 자동 스크롤 (데스크탑 sticky는 그대로)
  const detailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    if (typeof window === "undefined") return;
    if (window.innerWidth >= 1024) return; // lg 이상은 sticky라 스크롤 불필요
    // 다음 paint 후 스크롤 — DOM이 새 카드 렌더 끝낸 다음
    const id = setTimeout(() => {
      detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
    return () => clearTimeout(id);
  }, [selected?.id]);

  const sorted = [...tables].sort((a, b) => a.number - b.number);

  return (
    <OwnerShell
      title={t("otables.title", lang)}
      headerRight={
        <div className="flex items-center gap-1.5">
          <div className="inline-flex p-1 bg-[var(--color-navy-50)] rounded-full">
            <button
              onClick={() => setView("list")}
              className={cn(
                "h-9 px-3.5 rounded-full text-[12px] font-bold inline-flex items-center gap-1.5 transition-all",
                view === "list" ? "bg-white text-[var(--color-navy-800)] shadow-[var(--shadow-press)]" : "text-[var(--color-ink-500)]"
              )}
            >
              <List className="w-3.5 h-3.5" />
              {t("otables.view.list", lang)}
            </button>
            <button
              onClick={() => setView("layout")}
              className={cn(
                "h-9 px-3.5 rounded-full text-[12px] font-bold inline-flex items-center gap-1.5 transition-all",
                view === "layout" ? "bg-white text-[var(--color-navy-800)] shadow-[var(--shadow-press)]" : "text-[var(--color-ink-500)]"
              )}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              {t("otables.view.layout", lang)}
            </button>
          </div>
          <button
            onClick={() => {
              if (confirm(t("otables.resetConfirm", lang))) {
                initTables(storeId);
              }
            }}
            className="h-10 px-3 rounded-full hover:bg-[var(--color-navy-50)] inline-flex items-center gap-1.5 text-[13px] font-bold text-[var(--color-navy-800)]"
            aria-label={t("otables.reset", lang)}
          >
            <RotateCcw className="w-4 h-4" />
            <span className="hidden sm:inline">{t("otables.reset", lang)}</span>
          </button>
        </div>
      }
    >
      <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-5 lg:gap-6">
        <div className="lg:col-span-2 xl:col-span-3">
          {/* Add buttons */}
          <div className="grid grid-cols-3 gap-2">
            <Button size="md" variant="ghost" onClick={() => addTable(storeId, "table")} leftIcon={<Plus className="w-4 h-4" />}>
              {t("otables.addTable", lang)}
            </Button>
            <Button size="md" variant="ghost" onClick={() => addTable(storeId, "room")} leftIcon={<Sofa className="w-4 h-4" />}>
              {t("otables.addRoom", lang)}
            </Button>
            <Button size="md" variant="ghost" onClick={() => addTable(storeId, "door")} leftIcon={<DoorOpen className="w-4 h-4" />}>
              {t("otables.addDoor", lang)}
            </Button>
          </div>

          {/* Sections */}
          <Card padding="md" className="mt-4">
            <div className="flex items-center gap-2 mb-3">
              <Layers className="w-4 h-4 text-[var(--color-navy-700)]" />
              <h3 className="text-[14px] font-bold text-[var(--color-navy-900)]">{t("otables.sections", lang)}</h3>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!newSection.trim()) return;
                addSection(storeId, newSection.trim());
                setNewSection("");
              }}
            >
              <Input
                placeholder={t("otables.sectionPh", lang)}
                value={newSection}
                onChange={(e) => setNewSection(e.target.value)}
              />
              <Button size="md" type="submit" disabled={!newSection.trim()}>
                {t("otables.sectionAdd", lang)}
              </Button>
            </form>
            {sections.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {sections.map((s) => (
                  <span key={s.id} className="chip">
                    {s.name}
                    <button onClick={() => deleteSection(s.id)} className="ml-1 opacity-60 hover:opacity-100">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </Card>

          {/* Main viewport */}
          {view === "list" ? (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
              {sorted.length === 0 ? (
                <Card padding="lg" className="text-center body-md sm:col-span-2">
                  {t("otables.empty", lang)}
                </Card>
              ) : (
                sorted.map((tbl) => {
                  const st = STATUS_FLOW[tbl.status ?? "available"];
                  return (
                    <Card
                      key={tbl.id}
                      padding="md"
                      className={cn(
                        "flex items-center gap-3 transition-shadow cursor-pointer",
                        selected?.id === tbl.id && "ring-2 ring-[var(--color-navy-700)]"
                      )}
                      onClick={() => setSelected((s) => (s?.id === tbl.id ? null : tbl))}
                    >
                      <div className="w-10 h-10 rounded-xl bg-[var(--color-navy-50)] text-[var(--color-navy-800)] font-extrabold inline-flex items-center justify-center">
                        {tbl.number}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-[14px] font-bold text-[var(--color-navy-900)]">
                          {tbl.type === "room"
                            ? t("otables.type.room", lang)
                            : tbl.type === "door"
                            ? t("otables.type.door", lang)
                            : t("otables.type.table", lang)} {tbl.number}
                        </p>
                        {tbl.type !== "door" && <p className="body-sm">{t("otables.seats", lang, { n: tbl.seats })}</p>}
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          updateTableStatus(storeId, tbl.number, st.next);
                        }}
                        className={`px-2.5 py-1 rounded-full text-[12px] font-bold ${st.cls}`}
                      >
                        {t(st.labelKey, lang)}
                      </button>
                    </Card>
                  );
                })
              )}
            </div>
          ) : (
            <>
              <FloorPlanPanel
                hasImage={!!floorPlan}
                currentImage={floorPlan}
                opacity={floorPlanOpacity}
                onUpload={onUploadFloorPlan}
                onRemove={onRemoveFloorPlan}
                onOpacity={onChangeOpacity}
                onSketchSave={(dataUrl) => {
                  // 스케치 결과를 도면 슬롯에 저장 (한 번 더 압축해서 용량 관리)
                  const persist = async (finalData: string) => {
                    if (!safeStoreFloorPlan(finalData)) return;
                    setFloorPlan(finalData);
                    setAiDraft(null);
                    setAiStructures(null);
                    await measureAndSetCanvas(finalData);
                    showToast(t("otables.sketch.saved", lang), "success");
                  };

                  if (dataUrl.length <= 4_500_000) {
                    persist(dataUrl);
                    return;
                  }
                  // 큰 PNG는 캔버스로 재인코딩해 JPEG 0.85로 축약
                  const tmp = document.createElement("canvas");
                  const im = new Image();
                  im.onload = () => {
                    const ratio = Math.min(1, 1280 / im.width);
                    tmp.width = Math.round(im.width * ratio);
                    tmp.height = Math.round(im.height * ratio);
                    const ctx = tmp.getContext("2d");
                    if (!ctx) { showToast(t("otables.floorplan.imageProcFail", lang), "error"); return; }
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(0, 0, tmp.width, tmp.height);
                    ctx.drawImage(im, 0, 0, tmp.width, tmp.height);
                    const reduced = tmp.toDataURL("image/jpeg", 0.85);
                    persist(reduced);
                  };
                  im.onerror = () => showToast(t("otables.floorplan.imageProcFail", lang), "error");
                  im.src = dataUrl;
                }}
                aiLoading={aiLoading}
                aiDraftCount={aiDraft?.length ?? 0}
                onRunAi={runAiDraft}
                onApplyAi={applyAiDraft}
                onDiscardAi={discardAiDraft}
              />
              <LayoutCanvas
                tables={sorted}
                selectedId={selected?.id ?? null}
                onSelect={(t) => setSelected((s) => (s?.id === t.id ? null : t))}
                onMove={(t, x, y) => updateTableLayout(storeId, t.number, { x, y })}
                backgroundDataUrl={floorPlan}
                backgroundOpacity={floorPlanOpacity}
                aiDraft={aiDraft}
                aiStructures={aiStructures}
                canvasOverride={aiCanvasSize}
              />
            </>
          )}
        </div>

        {/* Right rail: selected detail */}
        <div ref={detailRef} className="scroll-mt-[80px]">
          {selected ? (
            <Card padding="lg" className="lg:sticky lg:top-[88px]">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <p className="text-[12px] font-bold text-[var(--color-ink-500)] uppercase tracking-wide">
                    {selected.type === "room"
                      ? t("otables.type.room", lang)
                      : selected.type === "door"
                      ? t("otables.type.door", lang)
                      : t("otables.type.table", lang)}
                  </p>
                  <p className="text-[22px] font-extrabold text-[var(--color-navy-900)] tracking-tight">
                    {t("otables.numSuffix", lang, { n: selected.number })}
                  </p>
                </div>
                <span className={`px-2.5 py-1 rounded-full text-[11px] font-bold ${STATUS_FLOW[selected.status ?? "available"].cls}`}>
                  {t(STATUS_FLOW[selected.status ?? "available"].labelKey, lang)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[12px] text-[var(--color-ink-500)] mb-1.5 font-semibold">{t("otables.field.seats", lang)}</p>
                  <NumberField
                    value={selected.seats}
                    min={1}
                    max={99}
                    onCommit={(v) => updateTableLayout(storeId, selected.number, { seats: v })}
                  />
                </div>
                <div>
                  <p className="text-[12px] text-[var(--color-ink-500)] mb-1.5 font-semibold">{t("otables.field.section", lang)}</p>
                  <select
                    value={selected.sectionId ?? ""}
                    onChange={(e) =>
                      updateTableLayout(storeId, selected.number, {
                        sectionId: e.target.value || null,
                      } as any)
                    }
                    className="input-field"
                  >
                    <option value="">{t("otables.field.sectionNone", lang)}</option>
                    {sections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Shape / size (배치도 모드에서 더 유용) */}
              <div className="mt-4">
                <p className="text-[12px] text-[var(--color-ink-500)] mb-1.5 font-semibold">{t("otables.field.shape", lang)}</p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => updateTableLayout(storeId, selected.number, { shape: "square" })}
                    className={cn(
                      "h-11 rounded-[12px] text-[13px] font-bold inline-flex items-center justify-center gap-2 border",
                      (selected.shape ?? "square") === "square"
                        ? "bg-[var(--color-navy-700)] text-white border-transparent"
                        : "bg-white text-[var(--color-ink-700)] border-[var(--color-line)]"
                    )}
                  >
                    <Square className="w-4 h-4" /> {t("otables.shape.square", lang)}
                  </button>
                  <button
                    onClick={() => updateTableLayout(storeId, selected.number, { shape: "circle" })}
                    className={cn(
                      "h-11 rounded-[12px] text-[13px] font-bold inline-flex items-center justify-center gap-2 border",
                      selected.shape === "circle"
                        ? "bg-[var(--color-navy-700)] text-white border-transparent"
                        : "bg-white text-[var(--color-ink-700)] border-[var(--color-line)]"
                    )}
                  >
                    <Circle className="w-4 h-4" /> {t("otables.shape.circle", lang)}
                  </button>
                </div>
              </div>

              <div className="mt-4">
                <p className="text-[12px] text-[var(--color-ink-500)] mb-1.5 font-semibold flex items-center gap-1">
                  <Maximize2 className="w-3 h-3" /> {t("otables.field.size", lang)}
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <NumberField
                    value={selected.width ?? 70}
                    min={40}
                    max={400}
                    onCommit={(v) => updateTableLayout(storeId, selected.number, { width: v })}
                  />
                  <NumberField
                    value={selected.height ?? 70}
                    min={40}
                    max={400}
                    onCommit={(v) => updateTableLayout(storeId, selected.number, { height: v })}
                  />
                </div>
              </div>

              <Button
                block
                variant="outline"
                className="mt-5 text-[var(--color-danger)] border-[var(--color-danger)]/30"
                leftIcon={<Trash2 className="w-4 h-4" />}
                onClick={() => {
                  if (confirm(t("otables.deleteConfirm", lang, { n: selected.number }))) {
                    deleteTable(storeId, selected.number);
                    setSelected(null);
                  }
                }}
              >
                {t("otables.delete", lang)}
              </Button>
            </Card>
          ) : (
            <Card padding="lg" className="text-center body-md hidden lg:block lg:sticky lg:top-[88px]">
              {view === "layout" ? (
                <>
                  <Move className="w-8 h-8 text-[var(--color-ink-300)] mx-auto mb-2" />
                  {t("otables.hintTouch", lang)}
                </>
              ) : (
                <>{t("otables.hintMouse", lang)}</>
              )}
            </Card>
          )}
        </div>
      </div>
    </OwnerShell>
  );
}

