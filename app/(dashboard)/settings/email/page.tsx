import Link from "next/link"
import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getResolvedTenantId } from "@/lib/tenant"
import { EmailConfigForm } from "@/components/email/EmailConfigForm"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { SAST_TIME_ZONE } from "@/lib/utils"

export default async function EmailSettingsPage() {
  // Every endpoint this page drives (/api/email/config, /test, /test-imap,
  // /inbox) is ADMIN-only. The page must match so a LOAN_ADMIN doesn't see mail
  // configuration they cannot act on.
  await requireMinRole("ADMIN")

  const tenantId = await getResolvedTenantId()
  // Poll bookkeeping ONLY. Naming a secret column here would put it in the
  // server-rendered payload; the form fetches the masked config over the API.
  const pollStatus = await prisma.emailConfig.findUnique({
    where: { tenantId },
    select: { lastPollAt: true, lastPollOk: true, lastPollError: true },
  })

  // The inbound poll runs unattended every few minutes. Its outcome is a
  // factual claim: "never" when nothing has run, and the stored provider
  // error when it failed. Printing "OK" for an absent or failed poll is
  // exactly the lie that hid 1,966 consecutive IMAP failures.
  const pollAt = pollStatus?.lastPollAt
  const pollOk = pollStatus?.lastPollOk === true
  const pollWhen = pollAt ? new Date(pollAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE }) : null

  return (
    <div className="p-6 lg:p-8 max-w-3xl">
      <Breadcrumbs
        className="mb-1"
        items={[
          { label: "Settings", href: "/settings" },
          { label: "Email" },
        ]}
      />
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-[#1b1d24]">Email Configuration</h1>
        <Link href="/settings/email/logs" className="text-sm text-[#4F46E5] hover:underline font-medium">View Email Log →</Link>
      </div>
      <p className="text-sm text-gray-500 mb-6">
        Configure outgoing email for Section 129 notices, statements, and client communication.
        Supports Microsoft 365 (MS Graph) and any IMAP/SMTP provider.
      </p>

      {pollWhen === null ? (
        <div className="mb-4 p-3 rounded-lg text-sm bg-gray-50 text-gray-600">
          Last poll: never — the inbound reply poll has not run for this tenant yet.
        </div>
      ) : (
        <div className={`mb-4 p-3 rounded-lg text-sm ${pollOk ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
          {pollOk
            ? `Last poll: ${pollWhen} — OK`
            : `Last poll: ${pollWhen} — FAILED: ${pollStatus?.lastPollError ?? "no error recorded"}`}
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm p-6">
        <EmailConfigForm />
      </div>
    </div>
  )
}
