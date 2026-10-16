import { redirect } from "next/navigation"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { getSession } from "@/lib/auth-session"
import { redirectStaleSession } from "@/lib/auth-guards"
import { AppShell } from "@/components/app-shell/AppShell"
import { EnrolmentShell } from "@/components/app-shell/EnrolmentShell"
import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import { prisma } from "@/lib/prisma"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { countUnansweredConversations } from "@/lib/inbox/unanswered"
import { lacksLoanBook } from "@/lib/security/loan-book-scope"

async function getSidebarData(tenantId: string) {
  const [pendingApplications, collectionsCount, opportunitiesCount, newLeadsCount, unansweredInbox] = await Promise.all([
    prisma.loanApplication.count({
      where: {
        tenantId,
        status: { in: ["SUBMITTED", "UNDER_REVIEW"] },
      },
    }),
    prisma.loan.count({
      // Match the collections queue + dashboard count (the collectible book,
      // actually in arrears) — the badge previously disagreed, and
      // a settled R0 loan with stale DPD must not inflate it. The
      // population moves with COLLECTIBLE_STATUSES so the badge cannot drift
      // from the queue it counts.
      where: {
        tenantId,
        status: { in: [...COLLECTIBLE_STATUSES] },
        daysInArrears: { gt: 0 },
        arrearsAmount: { gt: 0 },
      },
    }),
    prisma.crossSellOpportunity.count({
      where: { tenantId, status: { in: ["PENDING", "CONTACTED"] } },
    }),
    // New leads awaiting first contact — still in the NEW stage, not yet
    // contacted or moved forward. Matches the Leads pipeline "NEW" column.
    prisma.lead.count({
      where: { tenantId, status: "NEW" },
    }),
    // Customers waiting on a reply. See lib/inbox/unanswered.ts for why this
    // is "nobody replied" rather than "nobody opened it".
    countUnansweredConversations(tenantId),
  ])
  return { pendingApplications, collectionsCount, opportunitiesCount, newLeadsCount, unansweredInbox }
}

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await getSession()

  if (!session?.user) {
    // Reached only when edge middleware trusted the JWT but node-side
    // revalidation rejected it (stale principal). Clear the cookie via the
    // route handler instead of bouncing to /login, which would loop. See
    // app/api/auth/expired/route.ts.
    redirectStaleSession()
  }
  // Clients who land in the staff workspace accidentally bounce to the portal.
  if (session.user.role === "CLIENT") {
    redirect("/portal")
  }
  const tenantId = session.user.tenantId
  if (!tenantId) {
    redirectStaleSession()
  }

  // Held at TOTP enrolment (proxy.ts): a bare shell, with none of the sidebar's
  // counts or navigation.
  if (session.user.totpEnrolmentRequired === true) {
    return (
      <TenantThemeProvider config={await getTenantConfig(tenantId)}>
        <EnrolmentShell>{children}</EnrolmentShell>
      </TenantThemeProvider>
    )
  }

  const user = {
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
  }

  // A role without the loan book (INSURANCE_OFFICER) is neither shown nor
  // sent the loan-book counts; its inbox count stays.
  const loanBook = !lacksLoanBook(session.user.role)
  const [sidebar, inboxOnly, tenantConfig] = await Promise.all([
    loanBook ? getSidebarData(tenantId) : null,
    loanBook ? null : countUnansweredConversations(tenantId),
    getTenantConfig(tenantId),
  ])
  const badges = sidebar
    ? {
        applications: sidebar.pendingApplications,
        collections: sidebar.collectionsCount,
        opportunities: sidebar.opportunitiesCount,
        leads: sidebar.newLeadsCount,
        inbox: sidebar.unansweredInbox,
      }
    : { inbox: inboxOnly ?? 0 }
  const features = resolveFeatureFlags(tenantConfig)
  const { featureCrm, featureIms, featureBureauSubmission, featureAssetFinance } = features

  return (
    <TenantThemeProvider config={tenantConfig}>
      <AppShell
        user={user}
        badges={badges}
        featureCrm={featureCrm}
        featureIms={featureIms}
        featureBureauSubmission={featureBureauSubmission}
        featureAssetFinance={featureAssetFinance}
      >
        {children}
      </AppShell>
    </TenantThemeProvider>
  )
}
