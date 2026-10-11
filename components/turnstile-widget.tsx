"use client"

import { useEffect, useRef } from "react"

const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement | string,
        options: {
          sitekey: string
          callback: (token: string) => void
          "error-callback"?: () => void
          "expired-callback"?: () => void
          theme?: "light" | "dark" | "auto"
          size?: "normal" | "compact"
        },
      ) => string
      reset: (widgetId?: string) => void
      remove: (widgetId: string) => void
    }
  }
}

let scriptLoadingPromise: Promise<void> | null = null

const TURNSTILE_TEST_SITE_KEY_PREFIXES = ["1x000", "2x000", "3x000"]

function isTurnstileTestSiteKey(siteKey: string | undefined) {
  return Boolean(
    siteKey &&
      TURNSTILE_TEST_SITE_KEY_PREFIXES.some((prefix) => siteKey.startsWith(prefix)),
  )
}

function loadTurnstileScript(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve()
  if (window.turnstile) return Promise.resolve()
  if (scriptLoadingPromise) return scriptLoadingPromise

  scriptLoadingPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src^="${SCRIPT_SRC}"]`)
    if (existing) {
      // Another instance is already loading the script — wait for it.
      existing.addEventListener("load", () => resolve(), { once: true })
      existing.addEventListener("error", () => reject(new Error("turnstile script failed")), { once: true })
      return
    }
    const script = document.createElement("script")
    script.src = SCRIPT_SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error("turnstile script failed"))
    document.head.appendChild(script)
  })

  return scriptLoadingPromise
}

interface TurnstileWidgetProps {
  onToken: (token: string) => void
  onError?: () => void
  onExpired?: () => void
  theme?: "light" | "dark" | "auto"
}

/**
 * Renders the Cloudflare Turnstile challenge. Calls `onToken` with the
 * solved token; the parent submits that token alongside the form payload.
 *
 * If NEXT_PUBLIC_TURNSTILE_SITE_KEY is not set (local dev), the widget
 * renders a small placeholder and immediately fires onToken("dev-bypass")
 * so the form flow is testable. The server-side verifier matches this
 * behaviour — see lib/turnstile.ts.
 */
export function TurnstileWidget({
  onToken,
  onError,
  onExpired,
  theme = "auto",
}: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const widgetIdRef = useRef<string | null>(null)
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
  const isTestSiteKey = isTurnstileTestSiteKey(siteKey)

  useEffect(() => {
    if (!siteKey || isTestSiteKey) {
      // Dev fallback: keep the form flow usable without rendering
      // Cloudflare's public test widget on a client-facing page.
      onToken("dev-bypass")
      return
    }

    let cancelled = false

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !containerRef.current || !window.turnstile) return
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (token) => onToken(token),
          "error-callback": () => onError?.(),
          "expired-callback": () => onExpired?.(),
          theme,
        })
      })
      .catch(() => onError?.())

    return () => {
      cancelled = true
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current)
        } catch {
          // Widget may already be gone — fine.
        }
      }
    }
    // siteKey is read once at mount; callbacks are stable enough that
    // re-rendering on every change would just reset the widget unhelpfully.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!siteKey) {
    return (
      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        Turnstile is disabled (NEXT_PUBLIC_TURNSTILE_SITE_KEY not set). Set it before launch.
      </div>
    )
  }

  if (isTestSiteKey) {
    return null
  }

  return <div ref={containerRef} />
}
