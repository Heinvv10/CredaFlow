import { PortalSidebar } from "./PortalSidebar"
import { ThemeToggle } from "@/components/ThemeToggle"
import { WhatsAppLauncher } from "@/components/support/WhatsAppLauncher"
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher"
import { PORTAL_INTENTS } from "@/lib/support/whatsapp-intents"
import { getLenderIdentity } from "@/lib/config/identity"
import { publicLenderLogoSrc } from "@/lib/config/lender-logo"
import { getPortalTenantId } from "@/lib/session-tenant"
import { getLocale, getT } from "@/lib/i18n/server"
import type { Locale } from "@/lib/i18n/locales"

type PortalShellProps = {
  userName: string
  userEmail: string
  showBusiness?: boolean
  /** The tenant's enabled languages; fewer than two hides the switcher. */
  enabledLocales?: readonly Locale[]
  children: React.ReactNode
}

export async function PortalShell({ userName, userEmail, showBusiness = false, enabledLocales = [], children }: PortalShellProps) {
  const firstName = userName.split(" ")[0]
  // Throws LenderIdentityError when the lender is unconfigured: the portal
  // refuses to render rather than show another lender's contact line.
  const tenantId = await getPortalTenantId()
  const identity = await getLenderIdentity(tenantId)
  const [locale, t, logoSrc] = await Promise.all([getLocale(), getT("portalShell"), publicLenderLogoSrc(tenantId)])

  return (
    <div lang={locale} className="min-h-screen cf-app-surface">
      <PortalSidebar
        userName={userName}
        userEmail={userEmail}
        brandName={identity.tradingName}
        logoSrc={logoSrc}
        whatsappE164={identity.publicWhatsappE164}
        showBusiness={showBusiness}
        enabledLocales={enabledLocales}
      />

      <header className="sticky top-[var(--cf-demo-banner-h)] z-30 flex items-center justify-between border-b border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] px-4 py-3 backdrop-blur md:hidden">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">
            {t("clientPortal")}
          </p>
          <p className="mt-1 text-sm font-medium text-[var(--cf-text)]">{firstName ? t("hi", { name: firstName }) : t("hiThere")}</p>
        </div>
        <div className="flex items-center gap-2 text-[var(--cf-text-secondary)]">
          <LanguageSwitcher enabled={enabledLocales} />
          <ThemeToggle />
        </div>
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
