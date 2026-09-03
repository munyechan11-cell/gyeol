import { AlertTriangle } from "lucide-react";
import { useLanguage, t } from "../../lib/i18n";
import { useStore } from "../../store/store";

/**
 * 데이터베이스 연결 실패 배너.
 *
 * 왜 필요한가:
 *   결의 로그인·회원가입은 Firestore `users` 컬렉션 매칭에 전적으로 의존한다.
 *   그래서 Firestore 가 막히면(결제 미설정·보안규칙 미배포·DB 미생성) 증상이
 *   "회원가입·로그인이 안 됨" 하나로만 나타나고, 계정 문제처럼 보인다.
 *   store 는 이미 dbStatus/dbError 로 실패를 알고 있었지만
 *   그 값을 화면에 쓰는 곳이 한 군데도 없어서, 장애가 조용히 묻혔다.
 *   → 실패를 눈에 보이게 만들어 오진을 막는다.
 *
 * 표시 조건: dbStatus === "error" (리스너가 실제로 거부·실패한 경우)
 *   "offline"(Firebase 미설정 → 로컬 전용 모드)은 의도된 동작이라 표시하지 않는다.
 */
export function DbStatusBanner() {
  const lang = useLanguage();
  const { dbStatus, dbError } = useStore();

  if (dbStatus !== "error") return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[60] bg-red-600 px-4 py-2 text-white shadow-lg"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <div className="mx-auto flex max-w-3xl items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div className="min-w-0 text-xs leading-relaxed">
          <p className="font-bold">{t("db.bannerTitle", lang)}</p>
          <p className="opacity-90">{t("db.bannerDesc", lang)}</p>
          {dbError && (
            // 원문 에러를 그대로 노출 — 사장님이 스크린샷 한 장으로 원인을 전달할 수 있게.
            // (Firestore 에러 메시지에는 개인정보가 없고, 결제 미설정 같은 원인이 그대로 들어 있다)
            <p className="mt-1 break-words font-mono text-[10px] opacity-75">{dbError}</p>
          )}
        </div>
      </div>
    </div>
  );
}
