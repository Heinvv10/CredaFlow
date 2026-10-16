import { redirect } from "next/navigation"
import { countLoansInArrears } from "@/lib/reports/book-arrears"
import { getSession } from "@/lib/auth-session"
import { redirectStaleSession } from "@/lib/auth-guards"
import { AppShell } from "@/components/app-shell/AppShell"
import { EnrolmentShell } from "@/components/app-shell/EnrolmentShell"
import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import { prisma } from "@/lib/prisma"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { countUnansweredConversations } from "@/lib/inbox/unanswered"

async function getSidebarData(tenantId: string) {
  const [pendingApplications, collectionsCount, opportunitiesCount, newLeadsCount, unansweredInbox] = await Promise.all([
    prisma.loanApplication.count({
      where: {
        tenantId,
        status: { in: ["SUBMITTED", "UNDER_REVIEW"] },
      },
    }),
    // The dashboard's and collections page's "accounts in arrears", from the
    // one helper they read (lib/reports/book-arrears.ts).
    countLoansInArrears(tenantId),
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

  const [badges, tenantConfig] = await Promise.all([
    getSidebarData(tenantId),
    getTenantConfig(tenantId),
  ])
  const features = resolveFeatureFlags(tenantConfig)
  const { featureCrm, featureIms, featureBureauSubmission, featureAssetFinance } = features

  return (
    <TenantThemeProvider config={tenantConfig}>
      <AppShell
        user={user}
        badges={{
          applications: badges.pendingApplications,
          collections: badges.collectionsCount,
          opportunities: badges.opportunitiesCount,
          leads: badges.newLeadsCount,
          inbox: badges.unansweredInbox,
        }}
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
