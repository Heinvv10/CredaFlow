import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { requireMinRole } from "@/lib/auth-guards"
import Link from "next/link"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { SAST_TIME_ZONE } from "@/lib/utils"

const STATUS_STYLES: Record<string, string> = {
  SENT: "bg-green-100 text-green-700",
  FAILED: "bg-red-100 text-red-700",
  QUEUED: "bg-gray-100 text-gray-600",
  BOUNCED: "bg-orange-100 text-orange-700",
  OPENED: "bg-blue-100 text-blue-700",
  REPLIED: "bg-purple-100 text-purple-700",
  // Refused by this system before dispatch — a non-production environment
  // declining to mail a member of the public. Amber, not red: nothing failed,
  // we chose not to send. See lib/email/recipient-guard.ts.
  BLOCKED: "bg-amber-100 text-amber-700",
  AMBIGUOUS: "bg-yellow-100 text-yellow-700",
}

const CATEGORY_LABELS: Record<string, string> = {
  section129: "S.129 Notice",
  statement: "Statement",
  test: "Test",
  general: "General",
}

export default async function EmailLogsPage() {
  // The email hub this log belongs to is ADMIN-only; the log itself carries
  // customer addresses and Section 129 subjects, so it matches.
  await requireMinRole("ADMIN")

  // The session's tenant, not the request host's: staff of one lender on
  // another lender's host must not read that lender's email log.
  const tenantId = await getStaffTenantId()
  const logs = await prisma.emailLog.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    take: 200,
  })

  const sent = logs.filter(l => l.status === "SENT").length
  const failed = logs.filter(l => l.status === "FAILED").length
  const opened = logs.filter(l => l.status === "OPENED").length
  const blocked = logs.filter(l => l.status === "BLOCKED").length

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-1"
        items={[
          { label: "Settings", href: "/settings" },
          { label: "Email", href: "/settings/email" },
          { label: "Logs" },
        ]}
      />
      <h1 className="text-2xl font-bold text-[#1b1d24] mb-4">Email Log</h1>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <div className="bg-white rounded-xl shadow-sm p-4 text-center">
          <p className="text-2xl font-bold text-green-600">{sent}</p>
          <p className="text-xs text-gray-400 mt-1">Sent</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4 text-center">
          <p className="text-2xl font-bold text-red-600">{failed}</p>
          <p className="text-xs text-gray-400 mt-1">Failed</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4 text-center">
          <p className="text-2xl font-bold text-blue-600">{opened}</p>
          <p className="text-xs text-gray-400 mt-1">Opened</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm p-4 text-center">
          <p className="text-2xl font-bold text-amber-600">{blocked}</p>
          <p className="text-xs text-gray-400 mt-1">Blocked</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              <th className="px-5 py-3 text-left">To</th>
              <th className="px-5 py-3 text-left">Subject</th>
              <th className="px-5 py-3 text-center">Category</th>
              <th className="px-5 py-3 text-center">Status</th>
              <th className="px-5 py-3 text-right">Sent</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {logs.map(log => (
              <tr key={log.id} className="hover:bg-gray-50">
                <td className="px-5 py-3">
                  <p className="font-medium text-[#1b1d24] text-xs">{log.toName ?? log.toAddress}</p>
                  <p className="text-[11px] text-gray-400">{log.toAddress}</p>
                </td>
                <td className="px-5 py-3 text-xs text-gray-600 max-w-xs truncate">{log.subject}</td>
                <td className="px-5 py-3 text-center">
                  <span className="text-[11px] bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">
                    {CATEGORY_LABELS[log.category ?? ""] ?? log.category ?? "—"}
                  </span>
                </td>
                <td className="px-5 py-3 text-center">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_STYLES[log.status] ?? "bg-gray-100 text-gray-500"}`}>
                    {log.status}
                  </span>
                </td>
                <td className="px-5 py-3 text-right text-[11px] text-gray-400">
                  {log.sentAt ? new Date(log.sentAt).toLocaleString("en-ZA", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: SAST_TIME_ZONE }) : "—"}
                  {log.errorMessage && (
                    <p className="text-[10px] text-red-500 mt-0.5 max-w-xs truncate" title={log.errorMessage}>{log.errorMessage}</p>
                  )}
                </td>
              </tr>
            ))}
            {logs.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-12 text-gray-400 text-sm">
                  No emails sent yet. Configure email at{" "}
                  <Link href="/settings/email" className="text-[#4F46E5] hover:underline">Settings → Email</Link>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
