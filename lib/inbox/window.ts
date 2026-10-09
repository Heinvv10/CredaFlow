// Display-only: the eligibility engine does NOT enforce the WhatsApp 24h
// session window in Slice 0 (OUTSIDE_WA_SESSION_WINDOW is declared but never
// returned). This drives the UI indicator only. Enforcement becomes real at
// the official-provider cutover.
export const WA_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000

export type WaWindowState = { open: boolean; expiresAt: Date | null }

export function computeWaWindow(lastInboundAt: Date | null, now: Date): WaWindowState {
  if (!lastInboundAt) return { open: false, expiresAt: null }
  const expiresAt = new Date(lastInboundAt.getTime() + WA_SESSION_WINDOW_MS)
  return { open: now.getTime() < expiresAt.getTime(), expiresAt }
}
