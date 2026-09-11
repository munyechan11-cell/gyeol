/**
 * 결 인쇄 브릿지 — Electron 메인 프로세스.
 *
 * 역할:
 *  1) 트레이 아이콘 + 컨텍스트 메뉴
 *  2) 설정 창(페어링 코드 입력·프린터 선택) 제공
 *  3) Firestore print_jobs 구독 → 로컬 프린터 출력
 *  4) 60초 하트비트로 사장님 화면에 "온라인" 표시
 */
import { app, Tray, Menu, BrowserWindow, ipcMain, nativeImage, dialog } from "electron";
import * as path from "path";
import { config } from "./config";
import { signInWithStoredToken, subscribePendingJobs, markJob, heartbeat, pairWithTokenHash, type PrintJob } from "./supabase";
import { printReceipt, printTestPage, listSystemPrinters } from "./printer";
// 자동 업데이트 — GitHub Releases 에서 latest.yml 폴링
import { autoUpdater } from "electron-updater";

// 인쇄 이력 — 최근 50건, 메모리 only (재시작 시 초기화)
interface HistoryEntry {
  id: string;
  table?: number;
  total?: number;
  itemsCount?: number;
  at: string;
  status: "printed" | "failed";
  error?: string;
}
const history: HistoryEntry[] = [];
const pushHistory = (e: HistoryEntry) => {
  history.unshift(e);
  if (history.length > 50) history.pop();
};

let tray: Tray | null = null;
let setupWin: BrowserWindow | null = null;
let unsubJobs: (() => void) | null = null;
let heartbeatTimer: NodeJS.Timeout | null = null;

// 중복 인쇄 방지 — 같은 jobId 처리 중 set
const inFlight = new Set<string>();

const TRAY_ICON = path.join(__dirname, "..", "assets", "tray-icon.png");

function buildTrayMenu(connected: boolean, lastError?: string) {
  const storeName = config.get("storeName");
  return Menu.buildFromTemplate([
    {
      label: connected
        ? (storeName ? `🟢 ${storeName} 연결됨` : "🟢 연결됨")
        : "🟡 페어링 필요",
      enabled: false,
    },
    ...(lastError ? [{ label: `⚠️ ${lastError.slice(0, 60)}`, enabled: false }] : []),
    { type: "separator" as const },
    {
      label: connected ? "다시 페어링하기" : "매장 연결",
      click: openSetupWindow,
    },
    {
      label: "프린터 다시 선택 / 테스트",
      click: openSetupWindow,
    },
    { type: "separator" as const },
    {
      label: "자동 시작",
      type: "checkbox" as const,
      checked: !!config.get("autoLaunch"),
      click: (item) => {
        config.set("autoLaunch", item.checked);
        app.setLoginItemSettings({ openAtLogin: item.checked });
      },
    },
    { type: "separator" as const },
    {
      label: "종료",
      click: () => app.quit(),
    },
  ]);
}

function updateTray(connected: boolean, lastError?: string) {
  if (!tray) return;
  const storeName = config.get("storeName");
  tray.setToolTip(
    connected
      ? (storeName ? `결 인쇄 브릿지 — ${storeName}` : "결 인쇄 브릿지 — 연결됨")
      : "결 인쇄 브릿지 — 페어링이 필요해요"
  );
  tray.setContextMenu(buildTrayMenu(connected, lastError));
}

function openSetupWindow() {
  if (setupWin) {
    setupWin.focus();
    return;
  }
  setupWin = new BrowserWindow({
    width: 480,
    height: 620,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "결 인쇄 브릿지 설정",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWin.setMenuBarVisibility(false);
  setupWin.loadFile(path.join(__dirname, "..", "src", "ui", "setup.html"));
  setupWin.on("closed", () => {
    setupWin = null;
  });
}

async function startWorker() {
  const storeId = config.get("storeId");
  if (!storeId) return;
  try {
    await signInWithStoredToken();
  } catch (e: any) {
    console.error("[main] 세션 복구 실패", e?.message);
    updateTray(false, "재로그인 실패 — 다시 페어링하세요");
    return;
  }

  // 인쇄 작업 구독
  if (unsubJobs) unsubJobs();
  unsubJobs = subscribePendingJobs(
    storeId,
    async (job: PrintJob) => {
      if (inFlight.has(job.id)) return;
      inFlight.add(job.id);
      try {
        await markJob(job.id, { status: "printing" });
        await printReceipt(job.payload);
        await markJob(job.id, {
          status: "printed",
          printedAt: new Date().toISOString(),
        });
        pushHistory({
          id: job.id,
          table: job.payload?.order?.tableNumber,
          total: job.payload?.order?.totalAmount,
          itemsCount: job.payload?.order?.items?.length,
          at: new Date().toISOString(),
          status: "printed",
        });
        updateTray(true);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        console.error("[main] print failed", msg);
        await markJob(job.id, {
          status: "failed",
          lastError: msg.slice(0, 200),
          attempts: (job.attempts ?? 0) + 1,
        });
        pushHistory({
          id: job.id,
          table: job.payload?.order?.tableNumber,
          at: new Date().toISOString(),
          status: "failed",
          error: msg.slice(0, 120),
        });
        updateTray(true, msg);
      } finally {
        inFlight.delete(job.id);
      }
    },
    (err) => {
      updateTray(false, err.message);
    }
  );

  // 하트비트 — 매장명 동기화도 같은 응답으로 받는다(사장님이 결 웹앱에서 매장명을
  // 바꾸면 다음 하트비트에 따라온다). 예전엔 두 갈래였는데 서버가 한 번에 처리한다.
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const beat = async () => {
    const info = await heartbeat();
    if (info?.restaurantName && info.restaurantName !== config.get("storeName")) {
      config.set("storeName", info.restaurantName);
      updateTray(true);
    }
  };
  await beat();
  heartbeatTimer = setInterval(() => void beat(), 60_000);

  updateTray(true);
}

// ============================================================
// IPC — 설정 창에서 호출
// ============================================================
ipcMain.handle("config:get-all", () => ({
  apiBaseUrl: config.apiUrl(),
  storeId: config.get("storeId"),
  storeName: config.get("storeName"),
  printer: config.get("printer"),
  autoLaunch: !!config.get("autoLaunch"),
  paired: config.isPaired(),
}));

ipcMain.handle("printers:list", async () => {
  return await listSystemPrinters();
});

ipcMain.handle("printer:select", (_e, p: { name: string; vendor: string; width?: number }) => {
  config.set("printer", p);
  return true;
});

ipcMain.handle("printer:test", async () => {
  try {
    await printTestPage("결 (테스트 인쇄)");
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

ipcMain.handle(
  "pairing:exchange",
  async (_e, payload: { code: string; deviceName?: string }) => {
    try {
      const res = await fetch(`${config.apiUrl()}/api/print-bridge/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        return { ok: false, error: t || `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { tokenHash: string; storeId: string };
      config.set("storeId", data.storeId);
      // 1회용 토큰을 지금 바로 세션으로 바꾼다 — 미루면 만료된다.
      await pairWithTokenHash(data.tokenHash);
      // 매장명도 즉시 받아오기 (UI 가 코드 입력 직후 매장명을 보여줄 수 있도록)
      try {
        const info = await heartbeat();
        if (info?.restaurantName) config.set("storeName", info.restaurantName);
      } catch (e: any) {
        console.warn("[pairing:exchange] storeName fetch skip", e?.message);
      }
      // 즉시 워커 시작
      startWorker().catch(console.error);
      return { ok: true, storeId: data.storeId, storeName: config.get("storeName") };
    } catch (e: any) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }
);

// 인쇄 이력 조회 — UI 에서 표시용
ipcMain.handle("history:get", () => history.slice(0, 50));

// 수동 업데이트 확인
ipcMain.handle("update:check", async () => {
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r?.updateInfo?.version ?? null };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
});

ipcMain.handle("config:reset", () => {
  if (unsubJobs) unsubJobs();
  unsubJobs = null;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  config.clear();
  updateTray(false);
  return true;
});

// ============================================================
// App lifecycle
// ============================================================
app.on("ready", async () => {
  // 트레이 아이콘 — PNG 가 없으면 빈 이미지로 대체 (개발 단계)
  let icon = nativeImage.createFromPath(TRAY_ICON);
  if (icon.isEmpty()) {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  updateTray(config.isPaired());

  // 자동 시작 등록
  app.setLoginItemSettings({ openAtLogin: !!config.get("autoLaunch") });

  // 페어링되어 있으면 즉시 워커 시작, 아니면 설정 창 열기
  if (config.isPaired()) {
    startWorker().catch((e) => {
      dialog.showErrorBox("결 인쇄 브릿지", `시작 실패: ${e?.message ?? e}`);
    });
  } else {
    openSetupWindow();
  }

  // 자동 업데이트 — GitHub Releases 에서 4시간마다 체크
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", () => {
    updateTray(config.isPaired(), "새 버전이 준비됐어요. 종료 시 자동 설치됩니다.");
  });
  autoUpdater.on("error", (e) => {
    console.warn("[autoUpdater]", e?.message ?? e);
  });
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
});

app.on("window-all-closed", () => {
  // 트레이 앱이므로 창이 모두 닫혀도 종료하지 않음.
  // Electron 의 기본 동작: macOS 빼고는 자동 종료 → preventDefault 대신
  // 그냥 핸들러를 등록만 해두면 종료 안 함 (Electron 31+).
  // 명시적으로 아무 것도 하지 않음.
});

app.on("before-quit", () => {
  if (unsubJobs) unsubJobs();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
});
