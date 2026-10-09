import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { Activity, User, Clock } from "lucide-react"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { sastStartOfDay } from "@/lib/date/sast"

export const metadata = { title: "Sign-in Activity" }

async function getLogs(tenantId: string) {
  return prisma.loginLog.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      user: { select: { id: true, name: true, email: true, role: true } },
    },
  })
}

// Tinted pastels are unreadable on the espresso (#0b0d12) background, so the
// role tags use the same hue family but at ~20% opacity with a lighter text
// shade — same shape as other dark-surface badges across the dashboard.
const roleColors: Record<string, string> = {
  SUPER_ADMIN: "bg-red-500/20 text-red-300",
  ADMIN: "bg-orange-500/20 text-orange-300",
  LOAN_ADMIN: "bg-purple-500/20 text-purple-300",
  BRANCH_MANAGER: "bg-blue-500/20 text-blue-300",
  CREDIT_OFFICER: "bg-indigo-500/20 text-indigo-300",
  COLLECTIONS_OFFICER: "bg-amber-500/20 text-amber-300",
  COLLECTIONS_AGENT: "bg-yellow-500/20 text-yellow-300",
  INSURANCE_OFFICER: "bg-teal-500/20 text-teal-300",
  READONLY: "bg-[var(--cf-bg-subtle)] text-[var(--cf-text-secondary)]",
}

function roleLabel(r: string) {
  return r.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
}

function timeAgo(d: Date) {
  const s = Math.floor((Date.now() - d.getTime()) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s/60)}m ago`
  if (s < 86400) return `${Math.floor(s/3600)}h ago`
  return `${Math.floor(s/86400)}d ago`
}

function initials(name: string | null, email: string) {
  if (name) return name.split(" ").map(p => p[0]).join("").toUpperCase().slice(0, 2)
  return email.slice(0, 2).toUpperCase()
}

const COLORS = ["#4338CA","#047857","#1D4ED8","#6D28D9","#B91C1C","#B45309","#0F766E","#4338CA"]
function avatarColor(id: string) { return COLORS[id.charCodeAt(0) % COLORS.length] }

export default async function LoginLogPage() {
  // Matches /api/settings/login-log requireApiRole("LOAN_ADMIN"). If we
  // decide auth telemetry should be ADMIN-only, tighten both page and
  // API together — never let the page disagree with the API.
  await requireMinRole("LOAN_ADMIN")
  const tenantId = await getDefaultTenantId()
  const logs = await getLogs(tenantId)

  // Stats
  // SAST midnight. `setHours` is local, and the container is UTC, so "today"
  // began at 02:00 SAST — logins in the first two hours of the day were
  // counted as yesterday's.
  const today = sastStartOfDay(new Date())
  const todayCount = logs.filter(l => l.createdAt >= today).length
  const uniqueToday = new Set(logs.filter(l => l.createdAt >= today).map(l => l.userId)).size
  const uniqueTotal = new Set(logs.map(l => l.userId)).size

  return (
    <div className="p-4 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <Breadcrumbs
            className="mb-1"
            items={[
              { label: "Settings", href: "/settings" },
              { label: "Sign-in Activity" },
            ]}
          />
          <h1 className="text-2xl font-bold text-[var(--cf-text)]">Sign-in Activity</h1>
          <p className="text-sm text-[var(--cf-text-muted)] mt-1">Last 200 sign-in events across all staff accounts</p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-[var(--cf-bg-panel)] rounded-xl border border-[var(--cf-border-subtle)] px-5 py-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center">
            <Activity className="h-5 w-5 text-blue-300" />
          </div>
          <div>
            <p className="text-2xl font-bold text-[var(--cf-text)]">{todayCount}</p>
            <p className="text-xs text-[var(--cf-text-muted)]">Logins today</p>
          </div>
        </div>
        <div className="bg-[var(--cf-bg-panel)] rounded-xl border border-[var(--cf-border-subtle)] px-5 py-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-full bg-[var(--cf-success)]/20 flex items-center justify-center">
            <User className="h-5 w-5 text-[var(--cf-success)]" />
          </div>
          <div>
            <p className="text-2xl font-bold text-[var(--cf-text)]">{uniqueToday}</p>
            <p className="text-xs text-[var(--cf-text-muted)]">Unique users today</p>
          </div>
        </div>
        <div className="bg-[var(--cf-bg-panel)] rounded-xl border border-[var(--cf-border-subtle)] px-5 py-4 flex items-center gap-4">
          <div className="w-10 h-10 rounded-full bg-[var(--cf-brand)]/20 flex items-center justify-center">
            <Clock className="h-5 w-5 text-[var(--cf-brand)]" />
          </div>
          <div>
            <p className="text-2xl font-bold text-[var(--cf-text)]">{uniqueTotal}</p>
            <p className="text-xs text-[var(--cf-text-muted)]">Unique users total</p>
          </div>
        </div>
      </div>

      {/* Log table */}
      <div className="bg-[var(--cf-bg-panel)] rounded-xl border border-[var(--cf-border-subtle)] overflow-hidden">
        {logs.length === 0 ? (
          <div className="p-12 text-center text-[var(--cf-text-muted)] text-sm">No sign-in activity recorded yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)]">
                <th className="px-4 py-3 text-left text-[10px] font-semibold text-[var(--cf-text-muted)] uppercase">User</th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold text-[var(--cf-text-muted)] uppercase hidden md:table-cell">Role</th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold text-[var(--cf-text-muted)] uppercase">When</th>
                <th className="px-4 py-3 text-left text-[10px] font-semibold text-[var(--cf-text-muted)] uppercase hidden lg:table-cell">Exact time</th>
                <th className="px-4 py-3 text-center text-[10px] font-semibold text-[var(--cf-text-muted)] uppercase">Status</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="border-b border-[var(--cf-border-subtle)] hover:bg-[var(--cf-bg-subtle)]">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                        style={{ backgroundColor: avatarColor(log.userId) }}>
                        {initials(log.user.name, log.user.email)}
                      </div>
                      <div>
                        <p className="font-medium text-[var(--cf-text)] text-[12px]">{log.user.name ?? "—"}</p>
                        <p className="text-[10px] text-[var(--cf-text-muted)]">{log.user.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 hidden md:table-cell">
                    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${roleColors[log.user.role] ?? "bg-[var(--cf-bg-subtle)] text-[var(--cf-text-secondary)]"}`}>
                      {roleLabel(log.user.role)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-[12px] text-[var(--cf-text-secondary)]">{timeAgo(log.createdAt)}</td>
                  <td className="px-4 py-2.5 text-[11px] text-[var(--cf-text-muted)] hidden lg:table-cell">
                    {new Date(log.createdAt).toLocaleString("en-ZA", {
                      day: "2-digit", month: "short", year: "numeric",
                      hour: "2-digit", minute: "2-digit",
                      timeZone: SAST_TIME_ZONE
                    })}
                  </td>
                  <td className="px-4 py-2.5 text-center">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${log.success ? "bg-[var(--cf-success)]/20 text-[var(--cf-success)]" : "bg-[var(--cf-danger)]/20 text-[var(--cf-danger)]"}`}>
                      {log.success ? "Success" : "Failed"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
