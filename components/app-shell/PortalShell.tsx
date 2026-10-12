import { PortalSidebar } from "./PortalSidebar"
import { ThemeToggle } from "@/components/ThemeToggle"
import { WhatsAppLauncher } from "@/components/support/WhatsAppLauncher"
import { PORTAL_INTENTS } from "@/lib/support/whatsapp-intents"
import { getLenderIdentity } from "@/lib/config/identity"
import { getResolvedTenantId } from "@/lib/tenant"

type PortalShellProps = {
  userName: string
  userEmail: string
  children: React.ReactNode
}

export async function PortalShell({ userName, userEmail, children }: PortalShellProps) {
  const firstName = userName.split(" ")[0] || "there"
  // Throws LenderIdentityError when the lender is unconfigured: the portal
  // refuses to render rather than show another lender's contact line.
  const identity = await getLenderIdentity(await getResolvedTenantId())

  return (
    <div className="min-h-screen cf-app-surface">
      <PortalSidebar
        userName={userName}
        userEmail={userEmail}
        brandName={identity.tradingName}
        whatsappE164={identity.publicWhatsappE164}
      />

      <header className="sticky top-[var(--cf-demo-banner-h)] z-30 flex items-center justify-between border-b border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] px-4 py-3 backdrop-blur md:hidden">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">
            Client Portal
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--cf-text)]">Hi {firstName}</p>
        </div>
        <ThemeToggle />
      </header>

      <main className="min-h-screen pb-20 md:ml-60 md:pb-0">
        {children}
      </main>

      <WhatsAppLauncher
        intents={PORTAL_INTENTS}
        whatsappE164={identity.publicWhatsappE164}
        className="bottom-20 md:bottom-6"
      />
    </div>
  )
}
