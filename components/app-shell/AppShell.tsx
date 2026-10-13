import type { StaffBadgeKey } from "@/lib/navigation"
import { AppSidebar } from "./AppSidebar"
import { AppTopbar } from "./AppTopbar"
import type { UserRole } from "@/lib/permissions"



type AppShellProps = {
  user: {
    name: string | null
    email: string
    role: UserRole
  }
  badges?: Partial<Record<StaffBadgeKey, number>>
  featureCrm?: boolean
  featureIms?: boolean
  featureBureauSubmission?: boolean
  /** The session is held at TOTP enrolment: the sidebar offers only that page. */
  enrolmentOnly?: boolean
  children: React.ReactNode
}

export function AppShell({ user, badges, featureCrm, featureIms, featureBureauSubmission, enrolmentOnly, children }: AppShellProps) {
  return (
    <div className="min-h-screen cf-app-surface">
      <AppTopbar user={user} />
      <AppSidebar
        badges={badges}
        featureCrm={featureCrm}
        featureIms={featureIms}
        featureBureauSubmission={featureBureauSubmission}
        role={user.role}
        enrolmentOnly={enrolmentOnly}
      />
      <main className="min-h-screen overflow-x-hidden pt-14 lg:pl-[248px]">
        {children}
      </main>
    </div>
  )
}
