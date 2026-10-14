import { common } from "./common"
import { portalApplications } from "./portal-applications"
import { portalDocuments } from "./portal-documents"
import { portalHome } from "./portal-home"
import { portalLabels } from "./portal-labels"
import { portalLoans } from "./portal-loans"
import { portalNotifications } from "./portal-notifications"
import { portalPayment } from "./portal-payment"
import { portalProfile } from "./portal-profile"
import { portalShell } from "./portal-shell"
import { portalStatement } from "./portal-statement"
import { websiteHome } from "./website-home"
import { websiteShell } from "./website-shell"

/** The English catalogue: the source of truth for every key (lib/i18n/catalog.ts). */
export const en = {
  common,
  portalApplications,
  portalDocuments,
  portalHome,
  portalLabels,
  portalLoans,
  portalNotifications,
  portalPayment,
  portalProfile,
  portalShell,
  portalStatement,
  websiteHome,
  websiteShell,
} as const
