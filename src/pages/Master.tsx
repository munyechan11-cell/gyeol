import { useEffect, useMemo, useState } from "react";
import { Shield, Lock, LogOut, Trash2, Users, Store, Search, Briefcase, KeyRound } from "lucide-react";
import type { Role } from "../lib/types";
import { MobileShell } from "../components/layout/MobileShell";
import { TopBar } from "../components/ui/TopBar";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useStore } from "../store/store";
import { showToast } from "../lib/toast";
import { useLanguage, t } from "../lib/i18n";
import { resetPasswordFor } from "../lib/phoneAuth";
import { masterListUsers, type MasterUser } from "../lib/masterApi";

export default function Master() {
  const { isMaster, loginMaster, logoutMaster, deleteUser, setMasterPassword, masterPassword } = useStore();

  // 전 계정 목록은 서버에서. 마스터가 어느 계정으로 로그인해 있든 RLS 는 그 계정 범위만
  // 보여 주므로(사장님 계정으로도 다른 사장님은 안 보인다), 목록은 마스터 비밀번호로 서버에 묻는다.
  const [users, setUsersList] = useState<MasterUser[]>([]);
  const [listVersion, setListVersion] = useState(0);
  useEffect(() => {
    if (!isMaster || !masterPassword) return;
    let cancelled = false;
    masterListUsers(masterPassword)
      .then((rows) => { if (!cancelled) setUsersList(rows); })
      .catch((e: any) => showToast(e?.message ?? "", "error"));
    return () => { cancelled = true; };
  }, [isMaster, masterPassword, listVersion]);

  // 비밀번호를 잊은 사람은 스스로 되찾을 길이 없다(문자 발송 없음). 마스터가 대신 바꿔 준다.
  // 서버는 x-master-password 를 앱 설정의 값과 대조한다 — 이 화면의 삭제와 같은 신뢰 모델이다.
  const handleReset = async (id: string, name: string) => {
    const pw = prompt(t("auth.phone.resetPrompt", lang, { name }));
    if (!pw) return;
    try {
      await resetPasswordFor(id, pw, { masterPassword });
      showToast(t("auth.phone.resetDone", lang), "success");
    } catch (e: any) {
      showToast(e?.message ?? t("auth.phone.resetFailed", lang), "error");
    }
  };
  const lang = useLanguage();
  const [pw, setPw] = useState("");
  const [tab, setTab] = useState<"owners" | "staff" | "customers" | "settings">("owners");
  const [newPw, setNewPw] = useState("");
  const [search, setSearch] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const matched = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.name?.toLowerCase().includes(q) ||
        u.phone?.includes(q) ||
        u.restaurantName?.toLowerCase().includes(q)
    );
  }, [users, search]);

  const handleDelete = async (id: string, role: Role, label: string) => {
    if (!confirm(t("master.deleteConfirm", lang, { label }))) return;
    setDeletingId(id);
    try {
      await deleteUser(id, role);
      setListVersion((v) => v + 1);
    } catch (e: any) {
      showToast(t("master.deleteFail", lang, { msg: e?.message ?? "" }), "error");
    } finally {
      setDeletingId(null);
    }
  };

  if (!isMaster) {
    return (
      <MobileShell>
        <TopBar title={t("master.title", lang)} back />
        <div className="px-6 pt-12 text-center">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-[var(--color-navy-700)] items-center justify-center mb-6 shadow-[var(--shadow-navy)]">
            <Shield className="w-8 h-8 text-white" />
          </div>
          <h1 className="headline-section mb-1">{t("master.authTitle", lang)}</h1>
          <p className="body-md text-[var(--color-ink-500)] mb-8">
            {t("master.authDesc", lang)}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loginMaster(pw);
            }}
            className="space-y-4 text-left"
          >
            <Input
              type="password"
              label={t("master.field.password", lang)}
              placeholder={t("master.field.passwordPh", lang)}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              leftSlot={<Lock className="w-4 h-4" />}
            />
            <Button block type="submit" disabled={!pw}>
              {t("master.btn.login", lang)}
            </Button>
          </form>
        </div>
      </MobileShell>
    );
  }

  const owners = matched.filter((u) => u.role === "owner");
  const staff = matched.filter((u) => u.role === "staff");
  const customers = matched.filter((u) => u.role === "customer");

  return (
    <MobileShell>
      <TopBar
        title={t("master.title", lang)}
        back
        right={
          <button
            onClick={logoutMaster}
            className="w-10 h-10 rounded-full hover:bg-[var(--color-navy-50)] inline-flex items-center justify-center"
          >
            <LogOut className="w-4 h-4 text-[var(--color-navy-800)]" />
          </button>
        }
      />
      <div className="px-5 pt-2">
        <div className="grid grid-cols-4 gap-2 mb-4">
          <StatCard icon={<Store className="w-4 h-4" />} label={t("master.stat.owners", lang)} value={owners.length} />
          <StatCard icon={<Briefcase className="w-4 h-4" />} label={t("master.stat.staff", lang)} value={staff.length} />
          <StatCard icon={<Users className="w-4 h-4" />} label={t("master.stat.customers", lang)} value={customers.length} />
          <StatCard label={t("master.stat.deleted", lang)} value={users.filter((u) => u.status === "deleted").length} />
        </div>

        <div className="grid grid-cols-4 p-1 bg-white border border-[var(--color-line)] rounded-[14px] mb-4">
          {(["owners", "staff", "customers", "settings"] as const).map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={
                "h-11 rounded-[10px] text-[13px] font-bold transition-all " +
                (tab === tabKey
                  ? "bg-[var(--color-navy-700)] text-white"
                  : "text-[var(--color-ink-500)]")
              }
            >
              {tabKey === "owners" ? t("master.tab.owners", lang) : tabKey === "staff" ? t("master.tab.staff", lang) : tabKey === "customers" ? t("master.tab.customers", lang) : t("master.tab.settings", lang)}
            </button>
          ))}
        </div>

        {(tab === "owners" || tab === "customers" || tab === "staff") && (
          <Input
            placeholder={t("master.searchPh", lang)}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leftSlot={<Search className="w-4 h-4" />}
            className="mb-3"
          />
        )}

        {tab === "owners" && (
          <div className="space-y-2">
            {owners.length === 0 && <EmptyText>{search ? t("master.empty.searchOwners", lang) : t("master.empty.owners", lang)}</EmptyText>}
            {owners.map((u) => (
              <UserRow
                key={u.id}
                title={u.restaurantName || u.name}
                subtitle={`${u.name} · ${u.phone || "—"}`}
                deleted={u.status === "deleted"}
                deleting={deletingId === u.id}
                onDelete={() => handleDelete(u.id, "owner", u.restaurantName || u.name)}
                onResetPassword={() => handleReset(u.id, u.restaurantName || u.name)}
              />
            ))}
          </div>
        )}

        {tab === "staff" && (
          <div className="space-y-2">
            {staff.length === 0 && <EmptyText>{search ? t("master.empty.searchOwners", lang) : t("master.empty.staff", lang)}</EmptyText>}
            {staff.map((u) => {
              const emp = u.employerStoreId ? users.find((x) => x.id === u.employerStoreId) : null;
              const statusKr =
                u.employerStatus === "approved"
                  ? t("master.staff.status.approved", lang)
                  : u.employerStatus === "pending"
                  ? t("master.staff.status.pending", lang)
                  : u.employerStatus === "rejected"
                  ? t("master.staff.status.rejected", lang)
                  : t("master.staff.status.none", lang);
              return (
                <UserRow
                  key={u.id}
                  title={`${u.name}${u.position ? ` · ${u.position}` : ""}`}
                  subtitle={`${u.phone || "—"} · ${emp?.restaurantName ?? t("master.staff.notMember", lang)} · ${statusKr}`}
                  deleted={u.status === "deleted"}
                  deleting={deletingId === u.id}
                  onDelete={() => handleDelete(u.id, "staff", u.name)}
                  onResetPassword={() => handleReset(u.id, u.name)}
                />
              );
            })}
          </div>
        )}

        {tab === "customers" && (
          <div className="space-y-2">
            {customers.length === 0 && <EmptyText>{search ? t("master.empty.searchOwners", lang) : t("master.empty.customers", lang)}</EmptyText>}
            {customers.map((u) => (
              <UserRow
                key={u.id}
                title={u.name}
                subtitle={`${u.phone || "—"} · ${u.authType ?? "phone"}`}
                deleted={u.status === "deleted"}
                deleting={deletingId === u.id}
                onDelete={() => handleDelete(u.id, "customer", u.name)}
                onResetPassword={() => handleReset(u.id, u.name)}
              />
            ))}
          </div>
        )}

        {tab === "settings" && (
          <Card padding="lg">
            <h3 className="text-[15px] font-extrabold text-[var(--color-navy-900)] mb-1">
              {t("master.settings.pwTitle", lang)}
            </h3>
            <p className="text-[13px] text-[var(--color-ink-500)] mb-4">
              {t("master.settings.pwDesc", lang)}
            </p>
            <Input
              type="password"
              placeholder={t("master.settings.pwNewPh", lang)}
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
            <Button
              block
              className="mt-4"
              disabled={!newPw}
              onClick={async () => {
                await setMasterPassword(newPw);
                setNewPw("");
              }}
            >
              {t("master.settings.pwSave", lang)}
            </Button>
          </Card>
        )}
      </div>
    </MobileShell>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <Card padding="sm" className="text-center">
      <div className="flex items-center justify-center gap-1 text-[var(--color-ink-500)] text-[11px] font-semibold mb-1">
        {icon}
        {label}
      </div>
      <div className="text-[20px] font-extrabold text-[var(--color-navy-900)]">{value}</div>
    </Card>
  );
}

function UserRow({
  title,
  subtitle,
  deleted,
  deleting,
  onDelete,
  onResetPassword,
}: {
  title: string;
  subtitle: string;
  deleted?: boolean;
  deleting?: boolean;
  onDelete: () => void;
  onResetPassword?: () => void;
}) {
  return (
    <Card padding="md" className="flex items-center gap-3">
      <div className="flex-1 min-w-0">
        <p className="text-[15px] font-bold text-[var(--color-navy-900)] truncate">
          {title}
          {deleted && (
            <span className="ml-2 text-[10px] font-bold text-[var(--color-danger)] uppercase">
              deleted
            </span>
          )}
        </p>
        <p className="text-[12px] text-[var(--color-ink-500)] truncate">{subtitle}</p>
      </div>
      {onResetPassword && !deleted && (
        <button
          onClick={onResetPassword}
          className="w-9 h-9 rounded-full inline-flex items-center justify-center hover:bg-[var(--color-navy-700)]/10 text-[var(--color-navy-700)]"
          aria-label="Reset password"
        >
          <KeyRound className="w-4 h-4" />
        </button>
      )}
      <button
        onClick={onDelete}
        disabled={deleting}
        className="w-9 h-9 rounded-full inline-flex items-center justify-center hover:bg-[var(--color-danger)]/10 text-[var(--color-danger)] disabled:opacity-50"
        aria-label="Delete"
      >
        {deleting ? (
          <span className="w-3.5 h-3.5 border-2 border-[var(--color-danger)] border-t-transparent rounded-full animate-spin" />
        ) : (
          <Trash2 className="w-4 h-4" />
        )}
      </button>
    </Card>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <Card padding="lg" className="text-center">
      <p className="text-[14px] text-[var(--color-ink-500)] font-medium">{children}</p>
    </Card>
  );
}
