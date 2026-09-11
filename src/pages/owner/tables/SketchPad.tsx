import { useEffect, useRef, useState } from "react";
import { X, Pencil, Eraser, Undo2, Check } from "lucide-react";
import { Button } from "../../../components/ui/Button";
import { cn } from "../../../lib/cn";
import { useLanguage, t } from "../../../lib/i18n";

// ============================================================
// 내장 그림판 — 펜·지우개·되돌리기 · 결과는 PNG dataURL
// ============================================================
export function SketchPad({
  initialDataUrl,
  onClose,
  onSave,
}: {
  initialDataUrl?: string | null;
  onClose: () => void;
  onSave: (dataUrl: string) => void;
}) {
  const lang = useLanguage();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [size, setSize] = useState(4);
  const [color, setColor] = useState("#0B1220");
  const [dirty, setDirty] = useState(false);
  // 초기 이미지 로드 race 방지: 이미지가 다 그려지기 전까지 입력 차단
  const [ready, setReady] = useState(!initialDataUrl);
  // 강제 리렌더 (canUndo/canRedo 표시 갱신용)
  const [, force] = useState(0);
  const drawingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);
  // 되돌리기/다시실행 dataURL 스택 — ImageData 대비 메모리 70-90% 절감, 모바일 OOM 방지
  const historyRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);

  // 캔버스 초기화 + 회전·리사이즈 시 그림 보존 재설정
  useEffect(() => {
    let mounted = true;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const setupCanvas = (preserveData?: string) => {
      // 데스크탑은 Retina 선명도 확보 위해 DPR 3까지, 모바일은 메모리 보호로 2 상한
      const isDesktop = window.innerWidth >= 1024;
      const dpr = Math.min(window.devicePixelRatio || 1, isDesktop ? 3 : 2);
      const rect = wrap.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) return; // 모달 진입 중
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, rect.width, rect.height);
      if (preserveData) {
        setReady(false);
        const img = new Image();
        img.onload = () => {
          if (!mounted) return;
          ctx.drawImage(img, 0, 0, rect.width, rect.height);
          setReady(true);
        };
        img.onerror = () => mounted && setReady(true);
        img.src = preserveData;
      } else if (initialDataUrl) {
        setReady(false);
        const img = new Image();
        img.onload = () => {
          if (!mounted) return;
          const r = Math.min(rect.width / img.width, rect.height / img.height);
          const w = img.width * r;
          const h = img.height * r;
          ctx.drawImage(img, (rect.width - w) / 2, (rect.height - h) / 2, w, h);
          historyRef.current = [];
          pushHistory();
          setReady(true);
        };
        img.onerror = () => mounted && setReady(true);
        img.src = initialDataUrl;
      } else {
        historyRef.current = [];
        pushHistory();
        setReady(true);
      }
    };

    setupCanvas();

    // 화면 회전 / 창 크기 변경 시 현재 그림을 보존하고 캔버스 재설정
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        try {
          const snapshot = canvas.toDataURL("image/png");
          setupCanvas(snapshot);
        } catch {
          setupCanvas();
        }
      }, 150);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);

    return () => {
      mounted = false;
      if (resizeTimer) clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDataUrl]);

  const pushHistory = (clearRedo = true) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const snap = canvas.toDataURL("image/png");
      historyRef.current.push(snap);
      if (historyRef.current.length > 12) historyRef.current.shift();
      // 새 그리기 발생 → redo 스택은 무효
      if (clearRedo) redoRef.current = [];
      force((n) => n + 1);
    } catch {
      /* CORS 등 직렬화 실패 시 무시 */
    }
  };

  // 마지막 restore 호출만 화면에 반영 — undo/redo 빠르게 누를 때 이전 이미지 onload 가 늦게 도착해
  // 사용자가 본 상태와 캔버스가 어긋나는 race 방지.
  const restoreTokenRef = useRef(0);
  const restoreFromDataUrl = (dataUrl: string) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const token = ++restoreTokenRef.current;
    const img = new Image();
    img.onload = () => {
      if (token !== restoreTokenRef.current) return; // 더 새 호출이 있으면 폐기
      if (!canvasRef.current) return; // 언마운트 방어
      const rect = canvas.getBoundingClientRect();
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
      ctx.drawImage(img, 0, 0, rect.width, rect.height);
    };
    img.onerror = () => {
      // 손상된 dataURL — 무한 대기 방지, 사용자에게 별도 알림은 불필요(히스토리 내부값이므로)
      if (token !== restoreTokenRef.current) return;
      console.warn("[SketchPad] restoreFromDataUrl: 이미지 로드 실패");
    };
    img.src = dataUrl;
  };

  const undo = () => {
    if (historyRef.current.length <= 1) return;
    const current = historyRef.current.pop();
    if (current) redoRef.current.push(current);
    const last = historyRef.current[historyRef.current.length - 1];
    if (!last) return;
    restoreFromDataUrl(last);
    force((n) => n + 1);
  };

  const redo = () => {
    if (redoRef.current.length === 0) return;
    const next = redoRef.current.pop();
    if (!next) return;
    historyRef.current.push(next);
    if (historyRef.current.length > 12) historyRef.current.shift();
    restoreFromDataUrl(next);
    setDirty(true);
    force((n) => n + 1);
  };

  const clearAll = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    if (dirty && !window.confirm(t("otables.sketch.clearConfirm", lang))) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    pushHistory();
    setDirty(false);
  };

  const pos = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onDown = (e: React.PointerEvent) => {
    if (!ready) return; // 초기 이미지 로드 전 입력 무시
    e.preventDefault();
    try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* 미지원 브라우저 */ }
    drawingRef.current = true;
    lastRef.current = pos(e);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !lastRef.current) return;
    const cur = pos(e);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = size * (tool === "eraser" ? 4 : 1);
    ctx.strokeStyle = tool === "eraser" ? "#ffffff" : color;
    ctx.beginPath();
    ctx.moveTo(lastRef.current.x, lastRef.current.y);
    ctx.lineTo(cur.x, cur.y);
    ctx.stroke();
    lastRef.current = cur;
  };

  const onUp = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastRef.current = null;
    setDirty(true);
    pushHistory();
  };

  const save = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    onSave(canvas.toDataURL("image/png"));
  };

  const handleClose = () => {
    if (dirty && !window.confirm(t("otables.sketch.unsavedConfirm", lang))) return;
    onClose();
  };

  // 키보드 단축키 (데스크탑) — ESC: 닫기, Ctrl/Cmd+Z: 실행취소, Ctrl/Cmd+Y or Shift+Z: 다시실행, Delete/Backspace: 지움, B: 펜, E: 지우개
  // 핸들러 최신 참조를 ref로 보관 — 매 dirty 변경마다 listener 재등록하지 않으면서도 stale closure 방지
  const handlersRef = useRef({ handleClose, undo, redo, clearAll });
  handlersRef.current = { handleClose, undo, redo, clearAll };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // input·textarea·color picker 안에선 무시
      const targ = e.target as HTMLElement | null;
      if (targ && (targ.tagName === "INPUT" || targ.tagName === "TEXTAREA" || targ.isContentEditable)) return;
      const meta = e.ctrlKey || e.metaKey;
      const h = handlersRef.current;
      if (e.key === "Escape") { e.preventDefault(); h.handleClose(); return; }
      if (meta && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) h.redo();
        else h.undo();
        return;
      }
      if (meta && (e.key === "y" || e.key === "Y")) { e.preventDefault(); h.redo(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); h.clearAll(); return; }
      if (e.key === "b" || e.key === "B") { e.preventDefault(); setTool("pen"); return; }
      if (e.key === "e" || e.key === "E") { e.preventDefault(); setTool("eraser"); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 모달 열릴 때 포커스를 안으로 이동 (Tab 트랩의 약식 구현) + 배경 스크롤 잠금
  useEffect(() => {
    const focusTimer = setTimeout(() => {
      modalRef.current?.focus();
    }, 50);
    // 배경 스크롤 잠금 — 캔버스 그리기 중 페이지가 같이 스크롤되는 사고 방지
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      clearTimeout(focusTimer);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const canUndo = historyRef.current.length > 1;
  const canRedo = redoRef.current.length > 0;
  const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-stretch sm:items-center justify-center sm:p-4"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        ref={modalRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t("otables.sketch.aria", lang)}
        className="w-full sm:max-w-3xl lg:max-w-5xl bg-white sm:rounded-[18px] overflow-hidden shadow-[var(--shadow-lifted)] flex flex-col outline-none"
        style={{ maxHeight: "100vh" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 h-12 border-b border-[var(--color-line)] shrink-0">
          <Pencil className="w-4 h-4 text-[var(--color-navy-700)]" />
          <h3 className="text-[14px] font-extrabold text-[var(--color-navy-900)]">{t("otables.sketch.title", lang)}</h3>
          {dirty && <span className="text-[10px] font-bold text-[var(--color-mint-700)] bg-[var(--color-mint-50)] px-2 py-0.5 rounded-full">{t("otables.sketch.editing", lang)}</span>}
          <span className="ml-auto text-[10.5px] text-[var(--color-ink-400)] font-medium hidden lg:inline">
            {t("otables.sketch.shortcuts", lang, { mod: modKey })}
          </span>
          <button onClick={handleClose} className="lg:ml-3 h-9 w-9 rounded-full hover:bg-[var(--color-ink-50)] inline-flex items-center justify-center" aria-label={t("otables.sketch.close", lang)}>
            <X className="w-5 h-5 text-[var(--color-ink-600)]" />
          </button>
        </div>

        <div className="px-2 py-2 flex items-center gap-1.5 flex-wrap border-b border-[var(--color-line-soft)] bg-[var(--color-navy-50)]/40 shrink-0">
          <button
            onClick={() => setTool("pen")}
            className={cn(
              "h-9 px-3 rounded-full text-[12px] font-bold inline-flex items-center gap-1",
              tool === "pen" ? "bg-[var(--color-navy-700)] text-white" : "bg-white text-[var(--color-navy-800)]"
            )}
          >
            <Pencil className="w-3.5 h-3.5" /> <span className="hidden xs:inline">{t("otables.sketch.pen", lang)}</span>
          </button>
          <button
            onClick={() => setTool("eraser")}
            className={cn(
              "h-9 px-3 rounded-full text-[12px] font-bold inline-flex items-center gap-1",
              tool === "eraser" ? "bg-[var(--color-navy-700)] text-white" : "bg-white text-[var(--color-navy-800)]"
            )}
          >
            <Eraser className="w-3.5 h-3.5" /> <span className="hidden xs:inline">{t("otables.sketch.eraser", lang)}</span>
          </button>
          <div className="flex items-center gap-1.5">
            <input type="range" min={1} max={20} value={size} onChange={(e) => setSize(Number(e.target.value))} className="w-16 sm:w-24" aria-label={t("otables.sketch.thickness", lang)} />
            <span className="text-[11px] font-bold text-[var(--color-ink-700)] w-5 text-center">{size}</span>
          </div>
          {tool === "pen" && (
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="h-9 w-9 rounded-full border-[1.5px] border-[var(--color-line)] bg-white cursor-pointer shrink-0"
              aria-label={t("otables.sketch.color", lang)}
            />
          )}
          <button
            onClick={undo}
            disabled={!canUndo}
            className="h-9 px-2.5 rounded-full bg-white text-[12px] font-bold text-[var(--color-navy-800)] inline-flex items-center gap-1 disabled:opacity-40"
            aria-label={t("otables.sketch.undo", lang, { mod: modKey })}
            title={t("otables.sketch.undo", lang, { mod: modKey })}
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className="h-9 px-2.5 rounded-full bg-white text-[12px] font-bold text-[var(--color-navy-800)] inline-flex items-center gap-1 disabled:opacity-40"
            aria-label={t("otables.sketch.redo", lang, { mod: modKey })}
            title={t("otables.sketch.redo", lang, { mod: modKey })}
          >
            <Undo2 className="w-3.5 h-3.5 scale-x-[-1]" />
          </button>
          <button
            onClick={clearAll}
            className="h-9 px-2.5 rounded-full bg-white text-[12px] font-bold text-[var(--color-danger)] inline-flex items-center gap-1"
            aria-label={t("otables.sketch.clear", lang)}
            title={t("otables.sketch.clear", lang)}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div
          ref={wrapRef}
          className="relative bg-white flex-1 overflow-hidden min-h-[200px] sm:min-h-[360px]"
        >
          <canvas
            ref={canvasRef}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            className="block cursor-crosshair"
            style={{ touchAction: "none" }}
          />
        </div>

        <div className="px-4 py-3 border-t border-[var(--color-line)] flex items-center gap-2 justify-end shrink-0">
          <Button variant="ghost" onClick={handleClose}>{t("otables.sketch.cancel", lang)}</Button>
          <Button onClick={save} leftIcon={<Check className="w-4 h-4" />}>
            {t("otables.sketch.useAsPlan", lang)}
          </Button>
        </div>
      </div>
    </div>
  );
}

