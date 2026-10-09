import { notFound } from "next/navigation"

// Any /portal/* URL that matches no real portal route lands here (catch-all has
// the lowest routing priority, so real routes always win) and renders the
// portal-scoped not-found (app/(portal)/not-found.tsx) inside the portal shell —
// instead of bubbling up to the marketing 404 (Login / Apply Now), which is
// wrong for a signed-in client. See portal audit F-14 (2026-06-12).
export default function PortalCatchAll() {
  notFound()
}
