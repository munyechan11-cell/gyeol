import type { TableDoc } from "../lib/types";

export const LS_USER = "gyeol:currentUser";
export const LS_MASTER = "gyeol:isMaster";
export const LS_OFFLINE_STATE = "gyeol:offline_state";

// Default 15 tables for new owner
export function makeDefaultTables(storeId: string): TableDoc[] {
  return Array.from({ length: 15 }, (_, i) => {
    const n = i + 1;
    const col = (n - 1) % 5;
    const row = Math.floor((n - 1) / 5);
    return {
      id: `${storeId}_${n}`,
      number: n,
      storeId,
      x: col * 120 + 40,
      y: row * 120 + 40,
      width: 90,
      height: 90,
      seats: 4,
      type: "table",
      shape: "square",
      status: "available",
      currentCustomerId: null,
      sessionStartTime: null,
    };
  });
}
