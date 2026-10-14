import { common } from "./common"
import { portalHome } from "./portal-home"
import { portalLabels } from "./portal-labels"
import { portalShell } from "./portal-shell"
import { websiteHome } from "./website-home"
import { websiteShell } from "./website-shell"

/** The English catalogue: the source of truth for every key (lib/i18n/catalog.ts). */
export const en = {
  common,
  portalHome,
  portalLabels,
  portalShell,
  websiteHome,
  websiteShell,
} as const
