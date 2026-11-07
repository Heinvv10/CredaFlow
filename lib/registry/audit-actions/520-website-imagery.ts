import { defineAuditActions } from "../define"

// The lender's public-website photos (lib/config/website-imagery.ts): the slot, the file's sha256 and the alt text, never the bytes.
export default defineAuditActions({
  WEBSITE_IMAGE_UPDATED: "WEBSITE_IMAGE_UPDATED",
  WEBSITE_IMAGE_REMOVED: "WEBSITE_IMAGE_REMOVED",
} as const)
