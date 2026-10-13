import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Header } from "@/components/layout/Header"
import { getStaffTenantId } from "@/lib/session-tenant"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { TotpSetupClient } from "./TotpSetupClient"

export default async function SecuritySettingsPage() {
  const tenantId = await getStaffTenantId()
  const session = await auth()
  if (!session?.user) redirect("/login")

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { totpEnabled: true, email: true, name: true },
  })
  const required = await isStaffTotpRequired(tenantId)

  return (
    <>
      <Header
        title="Settings"
        subtitle="Security & Two-Factor Authentication"
        breadcrumbs={session.user.totpEnrolmentRequired === true ? undefined : [
          { label: "Settings", href: "/settings" },
          { label: "Security" },
        ]}
      />
      <div className="p-4 lg:p-8 max-w-2xl">
        <TotpSetupClient
          email={user?.email ?? session.user.email}
          totpEnabled={user?.totpEnabled ?? false}
          required={required}
          enrolmentForced={session.user.totpEnrolmentRequired === true}
        />
      </div>
    </>
  )
}
