import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Header } from "@/components/layout/Header"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { TotpSetupClient } from "./TotpSetupClient"

export default async function SecuritySettingsPage() {
  const session = await auth()
  if (!session?.user) redirect("/login")

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { totpEnabled: true, email: true, name: true },
  })
  const tenantId = session.user.tenantId
  const required = tenantId ? await isStaffTotpRequired(tenantId) : true

  return (
    <>
      <Header
        title="Settings"
        subtitle="Security & Two-Factor Authentication"
        breadcrumbs={[
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
