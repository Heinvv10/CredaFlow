// Client-safe event tracking for Matomo's `window._paq.push(['trackEvent', ...])`
// API. Analytics must never break a funnel: every helper here is a silent
// no-op on the server, when analytics is disabled, or if pushing fails.

type MatomoCommand = Array<string | number>

declare global {
  interface Window {
    _paq?: MatomoCommand[]
  }
}

const FUNNEL_CATEGORY = "funnel"

/**
 * Pushes a Matomo `trackEvent` command. No-ops on the server and when
 * `window._paq` is not an array (analytics disabled/blocked) — this
 * function must never throw.
 */
export function trackEvent(category: string, action: string, name?: string, value?: number): void {
  if (typeof window === "undefined") return
  if (!Array.isArray(window._paq)) return

  const command: MatomoCommand = ["trackEvent", category, action]
  if (name !== undefined) command.push(name)
  if (value !== undefined) command.push(value)

  try {
    window._paq.push(command)
  } catch {
    // Analytics must never break the funnel.
  }
}

export function trackApplyStart(): void {
  trackEvent(FUNNEL_CATEGORY, "apply_start")
}

export function trackApplySubmit(): void {
  trackEvent(FUNNEL_CATEGORY, "apply_submit")
}

export function trackQualifyResult(outcome: string): void {
  trackEvent(FUNNEL_CATEGORY, "qualify_result", outcome)
}

// Portal account-activation ("register") funnel. Two-step OTP flow, so the
// middle event isolates the drop-off between requesting a code and using it.
export function trackRegisterStart(): void {
  trackEvent(FUNNEL_CATEGORY, "register_start")
}

export function trackRegisterCodeSent(): void {
  trackEvent(FUNNEL_CATEGORY, "register_code_sent")
}

export function trackRegisterActivated(): void {
  trackEvent(FUNNEL_CATEGORY, "register_activated")
}
