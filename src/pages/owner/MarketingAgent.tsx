import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles, Check, Send, ShieldCheck, Loader2, BarChart3 } from "lucide-react";
import { OwnerShell } from "../../components/layout/OwnerShell";
import { useStore } from "../../store/store";
import { useLanguage, t, fmtKRW } from "../../lib/i18n";
import { showToast } from "../../lib/toast";
import { api } from "../../lib/api";
import { buildContext, askInsight } from "../../lib/aiInsight";
import type { MarketingDraft } from "../../lib/types";
import { unwrapAiContent } from "../../lib/aiText";
import { Metric } from "./marketing/Metric";
import { DraftCard } from "./marketing/DraftCard";

/**
 * 마케팅 자율 에이전트 "사장님 비서" — 1단계 골격 (TODO 7-1 + 7-3).
 *  - 7-1 매장 마케팅 프로필(톤·타깃·키워드·금지어) → storeConfig.marketingAgent.
 *  - 7-3 승인 큐 + 감사 로깅: 모든 초안은 '초안' 상태로만 생성되고, 사장 승인 후에만 발행.
 *    자동 발행은 의도적으로 막혀 있다(책임 큼). AI 콘텐츠 생성(7-2)은 다음 단계 — 지금은
 *    수동 초안으로 승인 흐름·로깅을 검증한다.
 */

const CHANNELS: MarketingDraft["channel"][] = ["instagram", "naverPlace", "general"];
const KINDS: MarketingDraft["kind"][] = ["post", "reply"];

export default function OwnerMarketingAgent() {
  const {
    currentUser,
    effectiveStoreId,
    updateStoreConfig,
    marketingDrafts,
    addMarketingDraft,
    reviewMarketingDraft,
    updateMarketingDraftContent,
    deleteMarketingDraft,
    photos,
    updatePhoto,
    orders,
    visits,
    reservations,
    users,
  } = useStore();
  const lang = useLanguage();
  const storeId = effectiveStoreId;
  const cfg = currentUser?.storeConfig?.marketingAgent;

  // ----- 프로필 상태 -----
  const [enabled, setEnabled] = useState(!!cfg?.enabled);
  const [tone, setTone] = useState(cfg?.tone ?? "");
  const [target, setTarget] = useState(cfg?.target ?? "");
  const [keywords, setKeywords] = useState(cfg?.keywords ?? "");
  const [banned, setBanned] = useState(cfg?.bannedWords ?? "");
  const [dailyLimit, setDailyLimit] = useState(String(cfg?.dailyPublishLimit ?? 0));
  const [savingProfile, setSavingProfile] = useState(false);

  // 저장값 재동기화 — 비동기 로드/매장 전환 시 프로필 폼이 빈 값·옛 값으로 남던 문제 해결.
  // deps=currentUser?.id 뿐 → 타이핑/저장 중엔 안 덮어쓰고, 처음 로드되거나 매장 바뀔 때만 채운다.
  useEffect(() => {
    if (!cfg) return;
    setEnabled(!!cfg.enabled);
    setTone(cfg.tone ?? "");
    setTarget(cfg.target ?? "");
    setKeywords(cfg.keywords ?? "");
    setBanned(cfg.bannedWords ?? "");
    setDailyLimit(String(cfg.dailyPublishLimit ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser?.id]);

  // 소셜 채널 셀프 연결 (인스타 + 구글 비즈니스) — 연결 상태는 storeConfig.publishing.channels 에서 (서버가 관리)
  const PLATFORMS: { key: "instagram" | "googlebusiness"; labelKey: string }[] = [
    { key: "instagram", labelKey: "magent.chInstagram" },
    { key: "googlebusiness", labelKey: "magent.chGoogle" },
  ];
  const pub = currentUser?.storeConfig?.publishing;
  const channels = pub?.channels ?? {};
  const plan = currentUser?.storeConfig?.plan === "pro" ? "pro" : "free";
  const isChannelConnected = (p: string) =>
    p === "instagram" ? !!(channels.instagram?.accountId || pub?.instagramAccountId) : !!channels[p]?.accountId;
  const channelUsername = (p: string) =>
    p === "instagram" ? channels.instagram?.username || pub?.instagramUsername || "" : channels[p]?.username || "";
  const anyChannelConnected = PLATFORMS.some((p) => isChannelConnected(p.key));
  const [busyPlat, setBusyPlat] = useState<string | null>(null);
  const [pendingPlat, setPendingPlat] = useState<string | null>(null); // authUrl 연 뒤 연결 완료 자동 감지 중
  const pollRef = useRef<string | null>(null); // 자동 폴링 중인 platform (취소/해제 시 중단)

  // 서버에 "이 매장 프로필에 그 채널이 연결됐는지" 물어 우리 DB(channels)에 저장. 연결 여부 반환.
  const detectConnected = async (platform: string): Promise<{ connected: boolean; username?: string }> => {
    try {
      const res = await fetch(api("/api/marketing/connect-finish"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ storeId, platform }),
      });
      const d = await res.json().catch(() => ({} as any));
      return { connected: !!(res.ok && d.connected), username: d.username };
    } catch {
      return { connected: false };
    }
  };
  // OAuth 새 탭이 끝나길 기다리며 자동 감지(최대 ~2분). 사장님이 Zernio 대시보드로 튕겨도, 돌아와 버튼 안 눌러도 자동 저장.
  const startConnectPoll = async (platform: string) => {
    pollRef.current = platform;
    for (let i = 0; i < 40 && pollRef.current === platform; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      if (pollRef.current !== platform) return;
      const { connected, username } = await detectConnected(platform);
      if (connected) {
        pollRef.current = null;
        setPendingPlat((cur) => (cur === platform ? null : cur));
        showToast(t("magent.igConnected", lang, { name: username || "" }), "success"); // storeConfig 는 onSnapshot 으로 갱신
        return;
      }
    }
  };
  const connectChannel = async (platform: string) => {
    if (busyPlat) return;
    setBusyPlat(platform);
    let authUrl = "";
    try {
      const res = await fetch(api("/api/marketing/connect-url"), {
        method: "POST", headers: { "content-type": "application/json" },
        // redirect_url: OAuth 후 Zernio 대시보드 대신 이 페이지로 복귀(?connected=...)
        body: JSON.stringify({ storeId, platform, redirectUrl: window.location.href.split("?")[0] }),
      });
      const d = await res.json().catch(() => ({} as any));
      if (res.status === 402 && d?.error === "upgrade_required") {
        showToast(t("magent.upgradeNeeded", lang, { price: (d.priceKrw ?? 10000).toLocaleString() }), "error");
        return;
      }
      if (!res.ok || !d.authUrl) {
        showToast(d?.error === "ZERNIO_NOT_CONFIGURED" ? t("magent.igNotConfigured", lang) : t("magent.igConnectFail", lang), "error");
        return;
      }
      authUrl = d.authUrl;
    } catch {
      showToast(t("magent.igConnectFail", lang), "error");
    } finally {
      setBusyPlat(null);
    }
    if (!authUrl) return;
    window.open(authUrl, "_blank", "noopener");
    setPendingPlat(platform);
    void startConnectPoll(platform); // 자동 감지 시작(논블로킹)
  };
  // 수동 '연결 완료 확인' — 자동 감지를 못 기다린 경우 즉시 확인.
  const finishChannel = async (platform: string) => {
    if (busyPlat) return;
    setBusyPlat(platform);
    try {
      const { connected, username } = await detectConnected(platform);
      if (connected) {
        pollRef.current = null;
        setPendingPlat(null);
        showToast(t("magent.igConnected", lang, { name: username || "" }), "success");
      } else {
        showToast(t("magent.igConnectPendingHint", lang), "info");
      }
    } finally {
      setBusyPlat(null);
    }
  };
  const cancelPending = (platform: string) => {
    if (pollRef.current === platform) pollRef.current = null;
    setPendingPlat((cur) => (cur === platform ? null : cur));
  };
  const disconnectChannel = async (platform: string) => {
    if (busyPlat || !window.confirm(t("magent.igDisconnectConfirm", lang))) return;
    pollRef.current = null;
    setBusyPlat(platform);
    try {
      await fetch(api("/api/marketing/disconnect"), {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ storeId, platform }),
      });
      showToast(t("magent.igDisconnected", lang), "info");
    } catch {
      showToast(t("magent.igConnectFail", lang), "error");
    } finally {
      setBusyPlat(null);
    }
  };

  // OAuth 후 Zernio 가 ?connected={platform}&accountId=... 로 이 페이지에 복귀시킴 → 우리 DB 에 저장(detectConnected) + URL 정리.
  const connectHandled = useRef(false);
  useEffect(() => {
    if (connectHandled.current || !storeId) return;
    const search = window.location.search || (window.location.hash.includes("?") ? "?" + window.location.hash.split("?")[1] : "");
    const connected = new URLSearchParams(search).get("connected");
    if (!connected) return;
    connectHandled.current = true;
    if (PLATFORMS.some((p) => p.key === connected)) {
      detectConnected(connected).then(({ connected: ok, username }) => {
        if (ok) showToast(t("magent.igConnected", lang, { name: username || "" }), "success");
      });
    }
    window.history.replaceState({}, "", window.location.href.split("?")[0]); // 새로고침 시 재실행 방지
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);
  // 페이지 이탈 시 OAuth 자동감지 폴링 중단(언마운트 후 백그라운드 fetch·토스트 방지)
  useEffect(() => () => { pollRef.current = null; }, []);

  // 금지어 목록 (가드레일) — 콘텐츠에 들어가면 안 되는 표현. 승인·발행 전 검사.
  const bannedList = useMemo(
    () => (cfg?.bannedWords ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    [cfg?.bannedWords]
  );

  const saveProfile = async () => {
    if (savingProfile) return;
    setSavingProfile(true);
    try {
      await updateStoreConfig(storeId, {
        marketingAgent: {
          enabled,
          tone: tone.trim(),
          target: target.trim(),
          keywords: keywords.trim(),
          bannedWords: banned.trim(),
          autoPublish: false, // 골격 단계 — 자동 발행은 항상 막음(승인 필수)
          dailyPublishLimit: Math.max(0, Math.min(100, Number(dailyLimit) || 0)),
        },
      });
      showToast(t("magent.saved", lang), "success");
    } catch (e: any) {
      showToast(e?.message ?? "save failed", "error");
    } finally {
      setSavingProfile(false);
    }
  };

  // ----- 수동 초안 추가 (AI 생성 7-2 자리) -----
  const [draftChannel, setDraftChannel] = useState<MarketingDraft["channel"]>("instagram");
  const [draftKind, setDraftKind] = useState<MarketingDraft["kind"]>("post");
  const [draftContent, setDraftContent] = useState("");
  const [addingDraft, setAddingDraft] = useState(false);
  // AI 생성 (7-2) — 주제를 받아 프로필 기반 초안 생성 → 'draft'(source:agent)로 승인 큐에 추가
  const [aiTopic, setAiTopic] = useState("");
  const [generating, setGenerating] = useState(false);

  const generateDraft = async () => {
    if (generating) return;
    setGenerating(true);
    try {
      const res = await fetch(api("/api/marketing/generate"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storeId, channel: draftChannel, kind: draftKind, topic: aiTopic.trim() || undefined, lang }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as any));
        if (res.status === 403 && d?.error === "marketing_disabled") showToast(t("magent.notEnabled", lang), "error");
        else if (res.status === 503) showToast(t("magent.aiNotConfigured", lang), "error");
        else if (res.status === 429) showToast(t("magent.rateLimit", lang), "error");
        else showToast(t("magent.genFail", lang), "error");
        return;
      }
      const d = (await res.json()) as { title?: string; content?: string; bannedHit?: string[] };
      if (!d.content) { showToast(t("magent.genFail", lang), "error"); return; }
      await addMarketingDraft(storeId, { channel: draftChannel, kind: draftKind, content: d.content, title: d.title, source: "agent" });
      setAiTopic("");
      if (Array.isArray(d.bannedHit) && d.bannedHit.length) {
        showToast(t("magent.bannedWarn", lang, { words: d.bannedHit.join(", ") }), "info");
      } else {
        showToast(t("magent.genDone", lang), "success");
      }
    } catch {
      showToast(t("magent.genFail", lang), "error");
    } finally {
      setGenerating(false);
    }
  };

  const addDraft = async () => {
    if (!draftContent.trim() || addingDraft) return;
    setAddingDraft(true);
    try {
      await addMarketingDraft(storeId, {
        channel: draftChannel,
        kind: draftKind,
        content: draftContent.trim(),
        source: "manual",
      });
      setDraftContent("");
      showToast(t("magent.draftAdded", lang), "success");
    } catch (e: any) {
      showToast(e?.message ?? "add failed", "error");
    } finally {
      setAddingDraft(false);
    }
  };

  const myDrafts = useMemo(
    () => marketingDrafts.filter((d) => d.storeId === storeId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [marketingDrafts, storeId]
  );
  const pending = myDrafts.filter((d) => d.status === "draft");
  const history = myDrafts.filter((d) => d.status !== "draft");

  // ----- 7-5 리뷰 응대 초안 -----
  const unansweredReviews = useMemo(
    () =>
      photos
        .filter((p) => p.storeId === storeId && p.type === "review" && !!p.reviewText?.trim() && !p.ownerReply)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 10),
    [photos, storeId]
  );
  const [replyingId, setReplyingId] = useState<string | null>(null);

  const generateReply = async (review: (typeof photos)[number]) => {
    if (replyingId) return;
    setReplyingId(review.id);
    try {
      const res = await fetch(api("/api/marketing/generate"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storeId, channel: "general", kind: "reply", reviewText: review.reviewText, rating: review.rating, lang }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({} as any));
        if (res.status === 403 && d?.error === "marketing_disabled") showToast(t("magent.notEnabled", lang), "error");
        else if (res.status === 503) showToast(t("magent.aiNotConfigured", lang), "error");
        else if (res.status === 429) showToast(t("magent.rateLimit", lang), "error");
        else showToast(t("magent.genFail", lang), "error");
        return;
      }
      const d = (await res.json()) as { content?: string; bannedHit?: string[] };
      if (!d.content) { showToast(t("magent.genFail", lang), "error"); return; }
      const snippet = `${review.rating ? `★${review.rating} · ` : ""}${(review.reviewText ?? "").slice(0, 80)}`;
      await addMarketingDraft(storeId, {
        channel: "general",
        kind: "reply",
        content: d.content,
        source: "agent",
        targetId: review.id,
        targetSummary: snippet,
      });
      if (Array.isArray(d.bannedHit) && d.bannedHit.length) showToast(t("magent.bannedWarn", lang, { words: d.bannedHit.join(", ") }), "info");
      else showToast(t("magent.replyDrafted", lang), "success");
    } catch {
      showToast(t("magent.genFail", lang), "error");
    } finally {
      setReplyingId(null);
    }
  };

  // 최근 24시간 발행 수 — 하루 발행 한도(가드레일) 판정용
  const publishedLast24h = useMemo(
    () => myDrafts.filter((d) => d.status === "published" && d.publishedAt && Date.now() - new Date(d.publishedAt).getTime() < 86_400_000).length,
    [myDrafts]
  );
  const publishLimit = cfg?.dailyPublishLimit ?? 0; // 0 = 무제한
  const publishingRef = useRef(0); // 진행 중 발행 수 — 연타 시 onSnapshot 왕복 전이라도 한도 정확 판정
  const [publishTarget, setPublishTarget] = useState<MarketingDraft | null>(null); // 사진/영상 선택 대기 중인 게시물 초안
  const [pubMode, setPubMode] = useState<"photo" | "reel">("photo"); // 발행 모달 탭: 사진(단일/캐러셀) vs 릴스(영상)
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<string[]>([]); // 캐러셀용 다중선택 (1장=단일, 2~10장=캐러셀)
  const [reelUrl, setReelUrl] = useState(""); // 릴스 영상 공개 URL

  // 발행에 쓸 매장 사진(메뉴·리뷰 등 imageData 있는 것). 인스타는 이미지 필수라 여기서 골라 게시.
  const storePhotos = useMemo(
    () => photos.filter((p) => p.storeId === storeId && !!p.imageData).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30),
    [photos, storeId]
  );

  // 발행 — ① 게시물(post): 채널 연결돼야만 사진/영상 모달 → 실제 발행. 미연결이면 "채널 먼저 연결" 안내(가짜 발행 금지).
  //        ② 응대(reply): 실제 동작(해당 리뷰에 사장님 답글 기록) → published.
  const handlePublish = async (d: MarketingDraft) => {
    if (publishLimit > 0 && publishedLast24h + publishingRef.current >= publishLimit) {
      showToast(t("magent.limitReached", lang, { n: publishLimit }), "error");
      return;
    }
    if (d.kind === "post") {
      if (!anyChannelConnected) {
        // 발행 채널이 없으면 어디에도 안 올라간다 — "발행됨"으로 속이지 말고 연결을 요구.
        showToast(t("magent.connectFirst", lang), "error");
        return;
      }
      setPubMode("photo"); setSelectedPhotoIds([]); setReelUrl(""); // 모달 상태 초기화
      setPublishTarget(d); // 사진/영상 선택 모달 → doPublish (연결된 모든 채널에 발행)
      return;
    }
    // kind === "reply" — 리뷰 답글 기록(실제 동작)
    publishingRef.current += 1;
    try {
      await reviewMarketingDraft(d.id, "publish");
      if (d.targetId) {
        await updatePhoto(d.targetId, { ownerReply: { text: unwrapAiContent(d.content), repliedAt: new Date().toISOString() } });
      }
      showToast(t("magent.publishDone", lang), "success");
    } catch (e: any) {
      showToast(e?.message ?? t("magent.genFail", lang), "error");
    } finally {
      publishingRef.current -= 1;
    }
  };

  // 실제 발행 — 단일/캐러셀(photoIds)·릴스(videoUrl). 서버가 사진을 공개 URL로 서빙 → Zernio로 게시.
  const doPublish = async (payload: { photoIds?: string[]; videoUrl?: string }) => {
    const d = publishTarget;
    if (!d) return;
    // 모달을 연 뒤 한도에 도달했을 수 있어 발행 직전 재검증(가드레일 우회 방지)
    if (publishLimit > 0 && publishedLast24h + publishingRef.current >= publishLimit) {
      showToast(t("magent.limitReached", lang, { n: publishLimit }), "error");
      setPublishTarget(null);
      return;
    }
    setPublishTarget(null);
    publishingRef.current += 1;
    try {
      const res = await fetch(api("/api/marketing/publish"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ storeId, content: unwrapAiContent(d.content), ...payload }),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({} as any));
        const msg = e?.error === "no_channel_connected" ? t("magent.igNotConnected", lang)
          : e?.error === "image_required" ? t("magent.imageInvalid", lang)
          : e?.error === "reel_needs_instagram" ? t("magent.reelGoogleSkip", lang)
          : e?.error === "carousel_needs_instagram" ? t("magent.carouselGoogleSkip", lang)
          : e?.error === "duplicate" ? t("magent.duplicate409", lang)
          : e?.error === "ZERNIO_NOT_CONFIGURED" ? t("magent.igNotConfigured", lang)
          : t("magent.publishFail", lang);
        showToast(msg, "error");
        return; // 초안은 approved 로 남겨 재시도 가능
      }
      await reviewMarketingDraft(d.id, "publish");
      showToast(t("magent.igPublished", lang), "success");
    } catch (e: any) {
      showToast(e?.message ?? t("magent.publishFail", lang), "error");
    } finally {
      publishingRef.current -= 1;
    }
  };

  // ----- 7-6 주간 성과 요약 -----
  const week = useMemo(() => {
    const cutoff = Date.now() - 7 * 86_400_000;
    const inWeek = (iso?: string) => !!iso && new Date(iso).getTime() >= cutoff;
    // 매출 = 결제완료(paid)만 — Settlement 의 정의와 일치. 미결제·환불 주문 과대계상 방지.
    const revenue = orders
      .filter((o) => o.storeId === storeId && o.paymentStatus === "paid" && inWeek(o.createdAt))
      .reduce((s, o) => s + o.totalAmount, 0);
    // 성사된 예약 = confirmed + completed (방문 완료 전이 누락 방지). 취소·노쇼 제외.
    const reservationCount = reservations.filter(
      (r) => r.storeId === storeId && (r.status === "confirmed" || r.status === "completed") && inWeek(r.createdAt)
    ).length;
    const weekReviews = photos.filter((p) => p.storeId === storeId && p.type === "review" && inWeek(p.createdAt));
    const ratings = weekReviews.map((r) => r.rating).filter((n): n is number => typeof n === "number" && n > 0);
    const avgRating = ratings.length ? ratings.reduce((s, n) => s + n, 0) / ratings.length : 0;
    const published = myDrafts.filter((d) => d.status === "published" && inWeek(d.publishedAt ?? d.createdAt)).length;
    return { revenue, reservationCount, reviewCount: weekReviews.length, avgRating, published };
  }, [orders, reservations, photos, myDrafts, storeId]);

  const [summary, setSummary] = useState("");
  const [summarizing, setSummarizing] = useState(false);

  const getWeeklySummary = async () => {
    if (summarizing) return;
    setSummarizing(true);
    setSummary("");
    try {
      const storeName = currentUser?.role === "owner" ? currentUser.restaurantName : users.find((u) => u.id === storeId)?.restaurantName;
      const context = buildContext({ storeId, storeName, orders, visits, users });
      const answer = await askInsight({
        storeId,
        question:
          "이번 주 우리 가게 성과를 사장님이 이해하기 쉽게 3~4줄로 요약하고, 다음 주에 SNS에 올리면 좋을 마케팅 콘텐츠 아이디어 2가지를 제안해줘.",
        context,
        lang,
      });
      setSummary(answer);
    } catch (e: any) {
      showToast(String(e?.message).includes("AI_NOT_CONFIGURED") ? t("magent.aiNotConfigured", lang) : t("magent.weekly.fail", lang), "error");
    } finally {
      setSummarizing(false);
    }
  };

  const field =
    "w-full px-3 py-2.5 rounded-xl border border-[var(--color-line)] text-[14px] bg-white focus:outline-none focus:border-[var(--color-navy-700)]";

  return (
    <OwnerShell title={t("magent.title", lang)}>
      <div className="max-w-[820px] mx-auto pb-16 space-y-5">
        {/* 안내 — 자동발행 금지 명시 */}
        <div className="flex items-start gap-2.5 p-3.5 rounded-2xl bg-[var(--color-navy-50)] text-[var(--color-navy-800)]">
          <ShieldCheck className="w-5 h-5 shrink-0 mt-0.5 text-[var(--color-navy-700)]" />
          <p className="text-[12.5px] leading-relaxed">{t("magent.autoPublishNote", lang)}</p>
        </div>

        {/* ===== 7-6 주간 성과 요약 ===== */}
        <section className="rounded-2xl bg-white border border-[var(--color-line)] p-5">
          <h2 className="text-[16px] font-extrabold text-[var(--color-navy-900)] mb-3 inline-flex items-center gap-1.5">
            <BarChart3 className="w-4 h-4 text-[var(--color-navy-700)]" />
            {t("magent.weekly.title", lang)}
          </h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
            <Metric label={t("magent.weekly.revenue", lang)} value={fmtKRW(week.revenue, lang)} />
            <Metric label={t("magent.weekly.reservations", lang)} value={String(week.reservationCount)} />
            <Metric
              label={t("magent.weekly.reviews", lang)}
              value={week.reviewCount ? `${week.reviewCount} · ★${week.avgRating.toFixed(1)}` : "0"}
            />
            <Metric label={t("magent.weekly.published", lang)} value={String(week.published)} />
          </div>
          <button
            onClick={getWeeklySummary}
            disabled={summarizing}
            className="h-10 px-4 rounded-xl bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)] font-bold inline-flex items-center gap-2 disabled:opacity-60"
          >
            {summarizing ? (
              <><Loader2 className="w-4 h-4 animate-spin" />{t("magent.weekly.summarizing", lang)}</>
            ) : (
              <><Sparkles className="w-4 h-4" />{t("magent.weekly.getSummary", lang)}</>
            )}
          </button>
          {summary && (
            <p className="mt-3 text-[13.5px] text-[var(--color-ink-700)] whitespace-pre-wrap leading-relaxed bg-[var(--color-navy-50)] rounded-xl p-3.5">
              {summary}
            </p>
          )}
        </section>

        {/* ===== 7-1 마케팅 프로필 ===== */}
        <section className="rounded-2xl bg-white border border-[var(--color-line)] p-5">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-[16px] font-extrabold text-[var(--color-navy-900)]">{t("magent.profile.title", lang)}</h2>
            <label className="inline-flex items-center gap-2 cursor-pointer select-none">
              <span className="text-[12.5px] font-bold text-[var(--color-ink-600)]">{t("magent.enable", lang)}</span>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="w-5 h-5 accent-[var(--color-navy-700)]" />
            </label>
          </div>
          <p className="text-[12px] text-[var(--color-ink-500)] mb-4 leading-relaxed">{t("magent.profileDesc", lang)}</p>

          <div className="space-y-3">
            <div>
              <label className="text-[12px] font-bold text-[var(--color-ink-600)] mb-1 block">{t("magent.tone", lang)}</label>
              <input value={tone} onChange={(e) => setTone(e.target.value)} placeholder={t("magent.tonePh", lang)} className={field} />
            </div>
            <div>
              <label className="text-[12px] font-bold text-[var(--color-ink-600)] mb-1 block">{t("magent.target", lang)}</label>
              <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t("magent.targetPh", lang)} className={field} />
            </div>
            <div>
              <label className="text-[12px] font-bold text-[var(--color-ink-600)] mb-1 block">{t("magent.keywords", lang)}</label>
              <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder={t("magent.keywordsPh", lang)} className={field} />
            </div>
            <div>
              <label className="text-[12px] font-bold text-[var(--color-ink-600)] mb-1 block">{t("magent.banned", lang)}</label>
              <input value={banned} onChange={(e) => setBanned(e.target.value)} placeholder={t("magent.bannedPh", lang)} className={field} />
            </div>
            <div>
              <label className="text-[12px] font-bold text-[var(--color-ink-600)] mb-1 block">{t("magent.dailyLimit", lang)}</label>
              <input
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value.replace(/\D/g, ""))}
                inputMode="numeric"
                placeholder="0"
                className={field}
              />
              <p className="text-[11px] text-[var(--color-ink-500)] mt-1">{t("magent.dailyLimitHint", lang)}</p>
            </div>
          </div>

          {/* 소셜 채널 연결 (셀프) — 인스타 + 구글 비즈니스 */}
          <div className="mt-4 pt-4 border-t border-[var(--color-line-soft)]">
            <label className="text-[12px] font-bold text-[var(--color-ink-600)] mb-2 block">{t("magent.channels", lang)}</label>
            <div className="space-y-2.5">
              {PLATFORMS.map((p) => {
                const connected = isChannelConnected(p.key);
                const uname = channelUsername(p.key);
                const busy = busyPlat === p.key;
                const pending = pendingPlat === p.key;
                return (
                  <div key={p.key} className="flex items-center gap-2 flex-wrap">
                    <span className="text-[12.5px] font-bold text-[var(--color-ink-700)] w-[116px] shrink-0">{t(p.labelKey, lang)}</span>
                    {connected ? (
                      <>
                        <span className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[var(--color-mint-50)] text-[var(--color-mint-700)] text-[12.5px] font-bold">
                          <Check className="w-4 h-4" />{uname ? `@${uname}` : t("magent.igConnectedShort", lang)}
                        </span>
                        <button onClick={() => disconnectChannel(p.key)} disabled={busy} className="h-9 px-3 rounded-lg bg-[var(--color-bg)] text-[var(--color-ink-600)] text-[12.5px] font-bold disabled:opacity-50">
                          {t("magent.igDisconnect", lang)}
                        </button>
                      </>
                    ) : pending ? (
                      <div className="flex gap-2 flex-wrap">
                        <button onClick={() => finishChannel(p.key)} disabled={busy} className="h-9 px-3 rounded-lg bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)] text-[12.5px] font-bold inline-flex items-center gap-1.5 disabled:opacity-60">
                          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}{t("magent.igConnectConfirm", lang)}
                        </button>
                        <button onClick={() => cancelPending(p.key)} className="h-9 px-3 rounded-lg bg-[var(--color-bg)] text-[var(--color-ink-600)] text-[12.5px] font-bold">{t("magent.cancel", lang)}</button>
                      </div>
                    ) : (
                      <button onClick={() => connectChannel(p.key)} disabled={busy} className="h-9 px-3 rounded-lg bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)] text-[12.5px] font-bold inline-flex items-center gap-1.5 disabled:opacity-60">
                        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}{t("magent.connectBtn", lang, { ch: t(p.labelKey, lang) })}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[11px] text-[var(--color-ink-500)] mt-2.5 leading-relaxed">
              {plan === "pro" ? t("magent.planPro", lang) : t("magent.planBeta", lang)}
            </p>
          </div>
          <button
            onClick={saveProfile}
            disabled={savingProfile}
            className="mt-4 h-11 px-5 rounded-xl bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)] font-bold disabled:opacity-50"
          >
            {t("magent.save", lang)}
          </button>
        </section>

        {/* ===== 수동 초안 추가 (AI 생성 7-2 자리) ===== */}
        <section className="rounded-2xl bg-white border border-[var(--color-line)] p-5">
          <h2 className="text-[16px] font-extrabold text-[var(--color-navy-900)] mb-1 inline-flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-[var(--color-mint-600)]" />
            {t("magent.addDraft", lang)}
          </h2>
          <p className="text-[12px] text-[var(--color-ink-500)] mb-3 leading-relaxed">{t("magent.addDraftHint", lang)}</p>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {CHANNELS.map((c) => (
              <button
                key={c}
                onClick={() => setDraftChannel(c)}
                aria-pressed={draftChannel === c}
                className={`h-8 px-3 rounded-full text-[12px] font-bold ${draftChannel === c ? "bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)]" : "bg-[var(--color-bg)] text-[var(--color-ink-600)]"}`}
              >
                {t(`magent.channel.${c}`, lang)}
              </button>
            ))}
            <span className="w-px bg-[var(--color-line)] mx-1" />
            {KINDS.map((k) => (
              <button
                key={k}
                onClick={() => setDraftKind(k)}
                aria-pressed={draftKind === k}
                className={`h-8 px-3 rounded-full text-[12px] font-bold ${draftKind === k ? "bg-[var(--color-mint-600)] text-white" : "bg-[var(--color-bg)] text-[var(--color-ink-600)]"}`}
              >
                {t(`magent.kind.${k}`, lang)}
              </button>
            ))}
          </div>
          {/* AI 생성 (7-2) */}
          <input
            value={aiTopic}
            onChange={(e) => setAiTopic(e.target.value)}
            placeholder={t("magent.aiTopicPh", lang)}
            className={`${field} mb-2`}
          />
          <button
            onClick={generateDraft}
            disabled={generating}
            className="w-full h-11 rounded-xl bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)] font-bold inline-flex items-center justify-center gap-2 disabled:opacity-60"
          >
            {generating ? (
              <><Loader2 className="w-4 h-4 animate-spin" />{t("magent.generating", lang)}</>
            ) : (
              <><Sparkles className="w-4 h-4" />{t("magent.genBtn", lang)}</>
            )}
          </button>

          {/* 또는 직접 작성 */}
          <div className="flex items-center gap-2 my-3">
            <span className="flex-1 h-px bg-[var(--color-line)]" />
            <span className="text-[11px] text-[var(--color-ink-400)] font-bold">{t("magent.or", lang)}</span>
            <span className="flex-1 h-px bg-[var(--color-line)]" />
          </div>
          <textarea
            value={draftContent}
            onChange={(e) => setDraftContent(e.target.value)}
            placeholder={t("magent.contentPh", lang)}
            rows={3}
            className={`${field} resize-y`}
          />
          <button
            onClick={addDraft}
            disabled={!draftContent.trim() || addingDraft}
            className="mt-2 h-10 px-4 rounded-xl bg-[var(--color-bg)] text-[var(--color-ink-700)] font-bold disabled:opacity-50"
          >
            {t("magent.addDraftBtn", lang)}
          </button>
        </section>

        {/* ===== 7-5 리뷰 응대 초안 ===== */}
        {unansweredReviews.length > 0 && (
          <section className="rounded-2xl bg-white border border-[var(--color-line)] p-5">
            <h2 className="text-[16px] font-extrabold text-[var(--color-navy-900)] mb-1 inline-flex items-center gap-1.5">
              <Sparkles className="w-4 h-4 text-[var(--color-mint-600)]" />
              {t("magent.reviews.title", lang)}
            </h2>
            <p className="text-[12px] text-[var(--color-ink-500)] mb-3 leading-relaxed">{t("magent.reviews.hint", lang)}</p>
            <div className="space-y-2">
              {unansweredReviews.map((r) => (
                <div key={r.id} className="flex items-start gap-2 p-3 rounded-xl bg-[var(--color-bg)]">
                  <div className="flex-1 min-w-0">
                    {!!r.rating && (
                      <span className="text-[12px] text-[var(--color-mint-700)] font-bold" aria-label={t("magent.ratingAria", lang, { n: r.rating })}>
                        <span aria-hidden="true">{"★".repeat(r.rating)}</span>
                      </span>
                    )}
                    <p className="text-[13px] text-[var(--color-ink-700)] leading-relaxed line-clamp-3">{r.reviewText}</p>
                    {r.customerName && <p className="text-[11px] text-[var(--color-ink-400)] mt-0.5">{r.customerName}</p>}
                  </div>
                  <button
                    onClick={() => generateReply(r)}
                    disabled={!!replyingId}
                    className="shrink-0 h-9 px-3 rounded-lg bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)] text-[12px] font-bold inline-flex items-center gap-1 disabled:opacity-60"
                  >
                    {replyingId === r.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    {t("magent.replyDraftBtn", lang)}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ===== 7-3 승인 대기 큐 ===== */}
        <section>
          <h2 className="text-[15px] font-extrabold text-[var(--color-navy-900)] mb-2">
            {t("magent.queue.title", lang)} {pending.length > 0 && <span className="text-[var(--color-mint-700)]">({pending.length})</span>}
          </h2>
          {pending.length === 0 ? (
            <p className="text-[13px] text-[var(--color-ink-500)] text-center py-8 rounded-2xl bg-white border border-dashed border-[var(--color-line)]">
              {t("magent.queue.empty", lang)}
            </p>
          ) : (
            <div className="space-y-2.5">
              {pending.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  onApprove={(note) => reviewMarketingDraft(d.id, "approve", note)}
                  onReject={(note) => reviewMarketingDraft(d.id, "reject", note)}
                  onPublish={() => handlePublish(d)}
                  onEdit={(content) => updateMarketingDraftContent(d.id, content, d.title)}
                  onDelete={() => deleteMarketingDraft(d.id)}
                  bannedWords={bannedList}
                />
              ))}
            </div>
          )}
        </section>

        {/* ===== 기록 ===== */}
        {history.length > 0 && (
          <section>
            <h2 className="text-[15px] font-extrabold text-[var(--color-navy-900)] mb-2">{t("magent.history", lang)}</h2>
            <div className="space-y-1.5">
              {history.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  onApprove={(note) => reviewMarketingDraft(d.id, "approve", note)}
                  onReject={(note) => reviewMarketingDraft(d.id, "reject", note)}
                  onPublish={() => handlePublish(d)}
                  onEdit={(content) => updateMarketingDraftContent(d.id, content, d.title)}
                  onDelete={() => deleteMarketingDraft(d.id)}
                  bannedWords={bannedList}
                  compact
                />
              ))}
            </div>
          </section>
        )}
      </div>

      {/* 발행 — 사진(단일/캐러셀) / 릴스(영상) 선택 모달 */}
      {publishTarget && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center sm:p-4" onClick={() => setPublishTarget(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={t("magent.pickPhoto", lang)}
            className="w-full max-w-[480px] bg-white rounded-t-[24px] sm:rounded-2xl p-5 pb-[max(env(safe-area-inset-bottom),20px)] max-h-[88vh] overflow-y-auto"
          >
            <h2 className="text-[16px] font-extrabold text-[var(--color-navy-900)] mb-3">{t("magent.pickPhoto", lang)}</h2>
            {/* 사진 / 릴스 탭 */}
            <div className="flex gap-1.5 mb-3 p-1 bg-[var(--color-bg)] rounded-xl">
              {(["photo", "reel"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setPubMode(m)}
                  className={`flex-1 h-9 rounded-lg text-[13px] font-bold transition-colors ${pubMode === m ? "bg-white text-[var(--color-navy-900)] shadow-sm" : "text-[var(--color-ink-500)]"}`}
                >
                  {t(m === "photo" ? "magent.tabPhoto" : "magent.tabReel", lang)}
                </button>
              ))}
            </div>
            {pubMode === "photo" ? (
              <>
                <p className="text-[12px] text-[var(--color-ink-500)] mb-3 leading-relaxed">{t("magent.pickPhotosHint", lang)}</p>
                {storePhotos.length === 0 ? (
                  <p className="text-[13px] text-[var(--color-ink-500)] text-center py-8">{t("magent.noPhotos", lang)}</p>
                ) : (
                  <div className="grid grid-cols-3 gap-2">
                    {storePhotos.map((p) => {
                      const idx = selectedPhotoIds.indexOf(p.id);
                      const sel = idx >= 0;
                      return (
                        <button
                          key={p.id}
                          onClick={() =>
                            setSelectedPhotoIds((cur) =>
                              cur.includes(p.id) ? cur.filter((x) => x !== p.id) : cur.length >= 10 ? cur : [...cur, p.id]
                            )
                          }
                          aria-pressed={sel}
                          className={`relative aspect-square rounded-xl overflow-hidden border transition-shadow ${sel ? "ring-2 ring-[var(--color-navy-700)] border-[var(--color-navy-700)]" : "border-[var(--color-line)]"}`}
                          aria-label={t("magent.pickPhoto", lang)}
                        >
                          <img src={p.imageData} alt="" className="w-full h-full object-cover" />
                          {sel && (
                            <span className="absolute top-1 right-1 w-5 h-5 rounded-full bg-[var(--color-navy-700)] text-white text-[11px] font-bold flex items-center justify-center">{idx + 1}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
                {selectedPhotoIds.length > 1 && (
                  <p className="text-[11px] text-[var(--color-ink-500)] mt-2 leading-relaxed">{t("magent.carouselGoogleSkip", lang)}</p>
                )}
                <button
                  disabled={selectedPhotoIds.length === 0}
                  onClick={() => doPublish({ photoIds: selectedPhotoIds })}
                  className="mt-3 h-11 w-full rounded-xl bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)] font-bold disabled:opacity-50"
                >
                  {selectedPhotoIds.length > 1 ? t("magent.publishCarousel", lang, { n: selectedPhotoIds.length }) : t("magent.publishBtn", lang)}
                </button>
              </>
            ) : (
              <>
                <p className="text-[12px] text-[var(--color-ink-500)] mb-2 leading-relaxed">{t("magent.reelUrlHint", lang)}</p>
                <input
                  value={reelUrl}
                  onChange={(e) => setReelUrl(e.target.value)}
                  placeholder="https://....mp4"
                  inputMode="url"
                  className="w-full h-11 px-3 rounded-xl border border-[var(--color-line)] bg-white text-[14px] outline-none focus:border-[var(--color-navy-700)]"
                />
                <p className="text-[11px] text-[var(--color-ink-500)] mt-2 leading-relaxed">{t("magent.reelGoogleSkip", lang)}</p>
                <button
                  disabled={!/^https:\/\/.+/.test(reelUrl.trim())}
                  onClick={() => doPublish({ videoUrl: reelUrl.trim() })}
                  className="mt-3 h-11 w-full rounded-xl bg-[var(--color-navy-700)] text-[var(--color-on-primary,white)] font-bold disabled:opacity-50"
                >
                  {t("magent.publishReel", lang)}
                </button>
              </>
            )}
            <button onClick={() => setPublishTarget(null)} className="mt-2 h-10 w-full rounded-xl bg-[var(--color-bg)] text-[var(--color-ink-600)] font-bold">
              {t("magent.cancel", lang)}
            </button>
          </div>
        </div>
      )}
    </OwnerShell>
  );
}
