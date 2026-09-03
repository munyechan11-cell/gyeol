/**
 * 영수증 인쇄 브릿지 설정 — electron-store 로 OS 사용자 디렉토리에 영구 저장.
 * 위치: %APPDATA%/gyeol-print-agent (Windows) / ~/Library/Application Support/gyeol-print-agent (Mac)
 */
import Store from "electron-store";

export interface AgentConfig {
  /** 결 API 베이스 URL (예: https://gyeol.onrender.com) */
  apiBaseUrl?: string;
  /**
   * Supabase 리프레시 토큰 (페어링 시 받음). 재시작 시 세션 복구용.
   * ⚠️ 갱신될 때마다 **새 값으로 교체**해 저장해야 한다 — Supabase 는 리프레시
   *    토큰을 회전시키므로, 첫 값을 계속 쓰면 하루 뒤 로그인이 깨진다.
   */
  refreshToken?: string;
  /** 페어링된 매장 ID */
  storeId?: string;
  /** 매장명 — 페어링 후 서버에서 자동 동기화, UI 표시·트레이 툴팁용 */
  storeName?: string;
  /** 사장님이 선택한 프린터 정보 */
  printer?: {
    name: string;            // OS 에 등록된 프린터 이름 (예: "EPSON TM-T20II Receipt")
    vendor: string;          // "EPSON" | "STAR" | "ESCPOS"
    width?: number;          // 80mm = 42자, 58mm = 32자
  };
  /** 자동 시작 등록 여부 */
  autoLaunch?: boolean;
}

const store = new Store<AgentConfig>({
  name: "config",
  defaults: {
    autoLaunch: true,
  },
});

export const config = {
  get<K extends keyof AgentConfig>(key: K): AgentConfig[K] {
    return store.get(key);
  },
  set<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) {
    if (value === undefined) {
      store.delete(key);
    } else {
      store.set(key, value);
    }
  },
  clear() {
    store.clear();
  },
  // 결정적 헬퍼
  isPaired(): boolean {
    return !!store.get("refreshToken") && !!store.get("storeId");
  },
  apiUrl(): string {
    return store.get("apiBaseUrl") || "https://gyeol.onrender.com";
  },
};
