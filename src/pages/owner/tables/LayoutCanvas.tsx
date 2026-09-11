import { useEffect, useRef, useState } from "react";
import { Move, Save } from "lucide-react";
import { Card } from "../../../components/ui/Card";
import { cn } from "../../../lib/cn";
import type { TableDoc } from "../../../lib/types";
import { useLanguage, t } from "../../../lib/i18n";

// ============================================================
// Layout Canvas (드래그로 매장 배치도)
// ============================================================
interface CanvasProps {
  tables: TableDoc[];
  selectedId: string | null;
  onSelect: (t: TableDoc) => void;
  onMove: (t: TableDoc, x: number, y: number) => void;
  backgroundDataUrl?: string | null;
  backgroundOpacity?: number;
  aiDraft?: Array<Partial<TableDoc> & { number: number; type: TableDoc["type"]; x: number; y: number }> | null;
  aiStructures?: Array<{ kind: "wall" | "door" | "room" | "counter"; x: number; y: number; width: number; height: number; label?: string }> | null;
  /** AI 분석 시점에 정한 캔버스 크기 (도면 종횡비 기반). 있으면 기존 maxX/Y 계산보다 우선. */
  canvasOverride?: { w: number; h: number } | null;
}

export function LayoutCanvas({
  tables, selectedId, onSelect, onMove,
  backgroundDataUrl, backgroundOpacity = 35,
  aiDraft, aiStructures, canvasOverride,
}: CanvasProps) {
  const lang = useLanguage();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
  // 모바일·소화면용 줌 (0.5x ~ 2x)
  const [zoom, setZoom] = useState(1);

  // 캔버스 크기: AI 오버라이드 > 테이블 최대 좌표 > 최소 800x600
  const maxX = tables.reduce((m, tbl) => Math.max(m, (tbl.x ?? 0) + (tbl.width ?? 70)), 0);
  const maxY = tables.reduce((m, tbl) => Math.max(m, (tbl.y ?? 0) + (tbl.height ?? 70)), 0);
  const canvasW = canvasOverride?.w ?? Math.max(800, maxX + 100);
  const canvasH = canvasOverride?.h ?? Math.max(600, maxY + 100);

  // 전체 보기 — wrap 크기에 맞춰 자동 줌
  const fitToScreen = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width < 10 || rect.height < 10) return; // 레이아웃 미정 가드
    const sx = (rect.width - 16) / canvasW;
    const sy = (rect.height - 16) / canvasH;
    setZoom(Math.max(0.3, Math.min(2, Math.min(sx, sy))));
  };

  // AI 분석 결과로 canvasOverride가 바뀌면 모바일에서 자동으로 전체 보기
  useEffect(() => {
    if (!canvasOverride) return;
    // wrap 레이아웃이 안정된 후 fit
    const id = setTimeout(fitToScreen, 80);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasOverride?.w, canvasOverride?.h]);

  // 키보드 단축키 (데스크탑): +/- 줌, 0=전체보기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const targ = e.target as HTMLElement | null;
      if (targ && (targ.tagName === "INPUT" || targ.tagName === "TEXTAREA" || targ.isContentEditable)) return;
      // 모달/그림판이 열려있을 때 충돌 방지 — 스케치팟에서도 같은 키를 다루므로 fixed inset 모달이 위에 있으면 스킵
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === "+" || e.key === "=") { e.preventDefault(); setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2))); }
      else if (e.key === "-" || e.key === "_") { e.preventDefault(); setZoom((z) => Math.max(0.3, +(z - 0.1).toFixed(2))); }
      else if (e.key === "0") { e.preventDefault(); fitToScreen(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasW, canvasH]);

  // 마우스 휠 + Ctrl/Cmd 로 줌 (데스크탑)
  // React onWheel 은 passive listener 라 preventDefault 가 무시되어 페이지 전체가 같이 스크롤·확대됨.
  // native addEventListener 로 passive:false 등록해야 wheel 기본 동작을 막을 수 있다.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const handler = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom((z) => Math.max(0.3, Math.min(2, +(z + delta).toFixed(2))));
    };
    wrap.addEventListener("wheel", handler, { passive: false });
    return () => wrap.removeEventListener("wheel", handler);
  }, []);

  const structureStyleByKind: Record<string, string> = {
    wall: "bg-[var(--color-ink-700)]",
    door: "bg-transparent border-2 border-dashed border-[var(--color-warn)]",
    room: "bg-[var(--color-navy-50)]/40 border-[1.5px] border-dashed border-[var(--color-navy-300)]",
    counter: "bg-[var(--color-mint-50)]/60 border-[1.5px] border-[var(--color-mint-300)]",
  };
  const structureLabelByKind: Record<string, string> = {
    wall: t("otables.ai.struct.wall", lang),
    door: t("otables.ai.struct.door", lang),
    room: t("otables.ai.struct.room", lang),
    counter: t("otables.ai.struct.counter", lang),
  };

  const startDrag = (e: React.PointerEvent, table: TableDoc) => {
    e.preventDefault();
    e.stopPropagation();
    onSelect(table);

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const origX = table.x ?? 40;
    const origY = table.y ?? 40;
    let lastX = origX;
    let lastY = origY;
    let moved = false;

    const onMove = (ev: PointerEvent) => {
      // 줌 상태 보정: 화면 픽셀 이동량을 캔버스 좌표 이동량으로 환산
      const dx = (ev.clientX - startClientX) / Math.max(0.01, zoom);
      const dy = (ev.clientY - startClientY) / Math.max(0.01, zoom);
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      lastX = Math.max(0, origX + dx);
      lastY = Math.max(0, origY + dy);
      setDrag({ id: table.id, x: lastX, y: lastY });
    };

    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      setDrag(null);
      // 5px 이상 움직였을 때만 저장 (탭과 구분)
      if (moved) {
        onMoveFinal(table, lastX, lastY);
      }
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  const onMoveFinal = (tbl: TableDoc, x: number, y: number) => {
    onMove(tbl, Math.round(x), Math.round(y));
  };

  return (
    <div className="mt-4">
      <Card padding="none" className="overflow-hidden">
        <div className="px-3 py-2 bg-[var(--color-navy-50)] border-b border-[var(--color-line)] flex items-center gap-1.5 text-[11px] sm:text-[12px] font-semibold text-[var(--color-ink-700)] flex-wrap">
          <Move className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden sm:inline">{t("otables.canvas.hint", lang)}</span>
          <span className="sm:hidden">{t("otables.canvas.hintShort", lang)}</span>
          {/* 줌 컨트롤 — 모바일 작은 화면에서 한눈 보기 */}
          <div className="ml-auto inline-flex items-center gap-0.5">
            <button
              onClick={() => setZoom((z) => Math.max(0.3, +(z - 0.1).toFixed(2)))}
              className="h-7 w-7 rounded-md hover:bg-white text-[14px] font-bold text-[var(--color-navy-800)] flex items-center justify-center"
              aria-label={t("otables.canvas.zoomOut", lang)}
            >−</button>
            <span className="text-[11px] font-bold text-[var(--color-navy-800)] w-9 text-center">{Math.round(zoom * 100)}%</span>
            <button
              onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))}
              className="h-7 w-7 rounded-md hover:bg-white text-[14px] font-bold text-[var(--color-navy-800)] flex items-center justify-center"
              aria-label={t("otables.canvas.zoomIn", lang)}
            >+</button>
            <button
              onClick={fitToScreen}
              className="h-7 px-2 rounded-md hover:bg-white text-[10.5px] font-bold text-[var(--color-navy-800)]"
              aria-label={t("otables.canvas.fit", lang)}
            >{t("otables.canvas.fitShort", lang)}</button>
            <button
              onClick={() => setZoom(1)}
              className="h-7 px-2 rounded-md hover:bg-white text-[10.5px] font-bold text-[var(--color-navy-800)] hidden sm:block"
              aria-label="100%"
            >1:1</button>
          </div>
        </div>
        <div
          ref={wrapRef}
          className="relative overflow-auto bg-white h-[min(70vh,640px)] landscape:h-[min(85vh,640px)] lg:h-[min(78vh,820px)]"
        >
          {/* 줌 시 스크롤바가 정확히 작동하도록 외부 wrapper가 시각 크기를 잡고, overflow:hidden으로 내부 layout box를 클립 */}
          <div style={{ width: canvasW * zoom, height: canvasH * zoom, overflow: "hidden", position: "relative" }}>
          <div
            className="relative origin-top-left bg-[repeating-linear-gradient(0deg,transparent,transparent_39px,#eef2f8_39px,#eef2f8_40px),repeating-linear-gradient(90deg,transparent,transparent_39px,#eef2f8_39px,#eef2f8_40px)]"
            style={{ width: canvasW, height: canvasH, transform: `scale(${zoom})`, transformOrigin: "top left" }}
          >
            {backgroundDataUrl && (
              <img
                src={backgroundDataUrl}
                alt={t("otables.bgAlt", lang)}
                draggable={false}
                // AI 캔버스 오버라이드 모드(도면 종횡비와 일치): stretch fill로 AI 좌표와 도면 위치 정확 매칭
                // 그렇지 않은 일반 모드: contain으로 비율 유지
                className={cn(
                  "absolute inset-0 w-full h-full pointer-events-none select-none",
                  canvasOverride ? "object-fill" : "object-contain"
                )}
                style={{ opacity: backgroundOpacity / 100 }}
              />
            )}
            {/* AI가 인식한 구조물 — 벽/문/룸/카운터, 시각 안내용 (Firestore에 저장되지 않음) */}
            {aiStructures?.map((s, i) => (
              <div
                key={`struct-${i}`}
                className={cn(
                  "absolute pointer-events-none flex items-center justify-center",
                  structureStyleByKind[s.kind] ?? "bg-[var(--color-ink-200)]/40"
                )}
                style={{ left: s.x, top: s.y, width: s.width, height: s.height }}
                title={s.label || structureLabelByKind[s.kind]}
              >
                {(s.kind === "room" || s.kind === "counter") && (
                  <span className="text-[10px] font-bold text-[var(--color-ink-700)] px-1 bg-white/70 rounded">
                    {s.label || structureLabelByKind[s.kind]}
                  </span>
                )}
              </div>
            ))}
            {aiDraft?.map((d) => {
              const w = d.width ?? 70;
              const h = d.height ?? 70;
              const shapeCls = d.shape === "circle" ? "rounded-full" : "rounded-[14px]";
              return (
                <div
                  key={`ai-${d.number}`}
                  className={cn(
                    "absolute border-[2px] border-dashed border-[var(--color-mint-700)] bg-[var(--color-mint-100)]/60 text-[var(--color-mint-700)] flex flex-col items-center justify-center pointer-events-none",
                    shapeCls
                  )}
                  style={{ left: d.x, top: d.y, width: w, height: h }}
                >
                  <p className="text-[16px] font-extrabold leading-none">{d.number}</p>
                  <p className="text-[10px] font-bold opacity-80 mt-0.5">{t("otables.ai.suggestion", lang)}</p>
                </div>
              );
            })}
            {tables.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-[14px] text-[var(--color-ink-500)] font-medium">
                {t("otables.canvas.empty", lang)}
              </div>
            )}
            {tables.map((tbl) => {
              const isDragging = drag?.id === tbl.id;
              const x = isDragging ? drag!.x : tbl.x ?? 40;
              const y = isDragging ? drag!.y : tbl.y ?? 40;
              const w = tbl.width ?? (tbl.type === "room" ? 150 : 70);
              const h = tbl.height ?? (tbl.type === "room" ? 80 : 70);
              const isSelected = selectedId === tbl.id;

              const colorCls =
                tbl.type === "door"
                  ? "bg-[#fff1e0] text-[var(--color-warn)] border-[var(--color-warn)]/30"
                  : tbl.type === "room"
                  ? "bg-[var(--color-mint-100)] text-[var(--color-mint-700)] border-[var(--color-mint-300)]"
                  : tbl.status === "occupied"
                  ? "bg-[var(--color-mint-100)] text-[var(--color-mint-700)] border-[var(--color-mint-300)]"
                  : tbl.status === "dirty"
                  ? "bg-[#fff1e0] text-[var(--color-warn)] border-[var(--color-warn)]/30"
                  : "bg-white text-[var(--color-navy-800)] border-[var(--color-line)]";

              const shapeCls = tbl.shape === "circle" ? "rounded-full" : "rounded-[14px]";
              const typeLabel = tbl.type === "room" ? t("otables.type.room", lang) : tbl.type === "door" ? t("otables.type.door", lang) : t("otables.type.table", lang);

              return (
                <div
                  key={tbl.id}
                  onPointerDown={(e) => startDrag(e, tbl)}
                  className={cn(
                    "absolute border-2 flex flex-col items-center justify-center select-none touch-none transition-shadow",
                    colorCls,
                    shapeCls,
                    isSelected && "ring-4 ring-[var(--color-navy-700)]/30 shadow-[var(--shadow-lifted)]",
                    isDragging ? "cursor-grabbing shadow-[var(--shadow-lifted)]" : "cursor-grab hover:shadow-[var(--shadow-lifted)]"
                  )}
                  style={{
                    left: x,
                    top: y,
                    width: w,
                    height: h,
                  }}
                  title={`${typeLabel} ${tbl.number}`}
                >
                  <p className="text-[18px] font-extrabold leading-none">
                    {tbl.type === "door" ? t("otables.type.doorShort", lang) : tbl.number}
                  </p>
                  {tbl.type !== "door" && (
                    <p className="text-[11px] font-semibold opacity-80 mt-0.5">{t("otables.seats", lang, { n: tbl.seats })}</p>
                  )}
                </div>
              );
            })}
          </div>
          </div>
        </div>
      </Card>
      <p className="mt-2 px-1 text-[12px] text-[var(--color-ink-600)] font-medium flex items-center gap-1">
        <Save className="w-3 h-3" /> {t("otables.canvas.autosave", lang)}
      </p>
    </div>
  );
}
