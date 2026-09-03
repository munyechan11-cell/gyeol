import { arrayUnion, newId, removeDoc, saveDoc } from "../../lib/db";
import type { StoreCore } from "../core";
import { useCallback } from "react";
import type { Photo, MarketingDraft } from "../../lib/types";

export function useMarketingActions(core: StoreCore) {
  const { photos, marketingDrafts, marketingDraftsRef, currentUserRef } = core;


  // ===== 마케팅 에이전트 초안 (TODO 7-3) — 승인 게이트 + 감사 로깅 =====
  const addMarketingDraft = useCallback(
    async (
      storeId: string,
      data: Pick<MarketingDraft, "channel" | "kind" | "content"> & {
        title?: string;
        source?: MarketingDraft["source"];
        targetId?: string;
        targetSummary?: string;
      }
    ) => {
      const id = newId();
      const now = new Date().toISOString();
      const by = currentUserRef.current?.id;
      const draft: MarketingDraft = {
        id,
        storeId,
        channel: data.channel,
        kind: data.kind,
        title: data.title,
        content: data.content,
        status: "draft", // 항상 초안으로 — 자동 발행 금지(승인 필수)
        source: data.source ?? "manual",
        targetId: data.targetId,
        targetSummary: data.targetSummary,
        createdAt: now,
        audit: [{ at: now, action: "created", by }],
      };
      await saveDoc("marketingDrafts", id, draft);
    },
    []
  );
  const reviewMarketingDraft = useCallback(
    async (id: string, action: "approve" | "reject" | "publish", note?: string) => {
      const cur = marketingDraftsRef.current.find((d) => d.id === id);
      if (!cur) return;
      const now = new Date().toISOString();
      const by = currentUserRef.current?.id;
      const status: MarketingDraft["status"] =
        action === "approve" ? "approved" : action === "reject" ? "rejected" : "published";
      // arrayUnion 으로 atomic append — 동시/멀티기기 쓰기에서도 로그 항목 유실 방지. (sentinel 내부는
      // stripUndefined 가 정리하지 않으므로 undefined 키를 넣지 않도록 조건부 구성)
      const entry: Record<string, string> = { at: now, action };
      if (by) entry.by = by;
      if (note?.trim()) entry.note = note.trim();
      const patch: Partial<MarketingDraft> = {
        status,
        reviewedAt: now,
        audit: arrayUnion(entry) as any,
      };
      if (action === "publish") patch.publishedAt = now;
      await saveDoc("marketingDrafts", id, patch);
    },
    []
  );
  const updateMarketingDraftContent = useCallback(async (id: string, content: string, title?: string) => {
    const cur = marketingDraftsRef.current.find((d) => d.id === id);
    if (!cur) return;
    const now = new Date().toISOString();
    const by = currentUserRef.current?.id;
    const entry: Record<string, string> = { at: now, action: "edited" };
    if (by) entry.by = by;
    await saveDoc("marketingDrafts", id, {
      content,
      title,
      audit: arrayUnion(entry) as any,
    });
  }, []);
  const deleteMarketingDraft = useCallback(async (id: string) => {
    await removeDoc("marketingDrafts", id);
  }, []);


  // ============ PHOTOS ============
  const addPhoto = useCallback(async (input: Omit<Photo, "id" | "createdAt">): Promise<Photo> => {
    const p: Photo = {
      id: newId(),
      createdAt: new Date().toISOString(),
      ...input,
    };
    await saveDoc("photos", p.id, p);
    return p;
  }, []);

  const updatePhoto = useCallback(async (id: string, data: Partial<Photo>) => {
    await saveDoc("photos", id, data);
  }, []);

  const deletePhoto = useCallback(async (id: string) => {
    await removeDoc("photos", id);
  }, []);

  return { addMarketingDraft, reviewMarketingDraft, updateMarketingDraftContent, deleteMarketingDraft, addPhoto, updatePhoto, deletePhoto };
}
