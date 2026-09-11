import type { Tab } from "./types";
import { Ticket, Home as HomeIcon, User as UserIcon, UtensilsCrossed } from "lucide-react";
import { useLanguage, t } from "../../../lib/i18n";
import { cn } from "../../../lib/cn";


export function BottomNav({ tab, setTab, couponBadge = 0 }: { tab: Tab; setTab: (t: Tab) => void; couponBadge?: number }) {
  const lang = useLanguage();
  const items: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "home", label: t("nav.home", lang), icon: <HomeIcon className="w-5 h-5" /> },
    { id: "menu", label: t("nav.menu", lang), icon: <UtensilsCrossed className="w-5 h-5" /> },
    { id: "coupons", label: t("nav.coupons", lang), icon: <Ticket className="w-5 h-5" /> },
    { id: "profile", label: t("nav.profile", lang), icon: <UserIcon className="w-5 h-5" /> },
  ];
  return (
    <div className="grid grid-cols-4">
      {items.map((it) => (
        <button
          key={it.id}
          onClick={() => setTab(it.id)}
          className={cn(
            "h-16 flex flex-col items-center justify-center gap-1 transition-colors",
            tab === it.id ? "text-[var(--color-navy-700)]" : "text-[var(--color-ink-500)]"
          )}
        >
          <span className="relative">
            {it.icon}
            {it.id === "coupons" && couponBadge > 0 && (
              <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-[var(--color-danger)] text-white text-[10px] font-extrabold flex items-center justify-center tabular-nums">
                {couponBadge > 9 ? "9+" : couponBadge}
              </span>
            )}
          </span>
          <span className="text-[12px] font-bold tracking-tight">{it.label}</span>
        </button>
      ))}
    </div>
  );
}
