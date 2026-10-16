"use client"

import { useState } from "react"
import { Smartphone } from "lucide-react"
import { Button } from "@/components/ui/button"

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; url: string; qr: string; replacedEarlierLink: boolean }
  | { kind: "error"; message: string }

/**
 * For a borrower whose device has no usable camera: a one-time capture link
 * (POST /api/portal/selfie-link) shown as a QR code to scan with their phone,
 * and as a link to open there.
 */
export function ContinueOnPhone() {
  // Asking for a link cancels any earlier one (one live link per application),
  // so the button says so before the client presses it.
  const [state, setState] = useState<State>({ kind: "idle" })

  async function start() {
    setState({ kind: "loading" })
    try {
      const res = await fetch("/api/portal/selfie-link", { method: "POST" })
      const body = await res.json().catch(() => ({})) as { url?: string; qr?: string; error?: string; replacedEarlierLink?: boolean }
      if (!res.ok || !body.url || !body.qr) {
        setState({ kind: "error", message: body.error ?? "We couldn't create a link. Please try again." })
        return
      }
      setState({ kind: "ready", url: body.url, qr: body.qr, replacedEarlierLink: body.replacedEarlierLink === true })
    } catch {
      setState({ kind: "error", message: "Network error — please try again." })
    }
  }

  if (state.kind === "ready") {
    return (
      <div className="w-full rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4 text-center">
        <p className="text-sm font-semibold text-[var(--cf-text)]">Scan this with your phone&apos;s camera</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- a generated data: URL */}
        <img src={state.qr} alt="QR code for the selfie link" className="mx-auto mt-3 h-48 w-48 rounded bg-white p-2" />
        <p className="mt-3 text-xs text-[var(--cf-text-muted)]">
          Or open this link on your phone: <a href={state.url} className="break-all font-medium text-[var(--cf-brand-soft)] underline">{state.url}</a>
        </p>
        <p className="mt-2 text-xs text-[var(--cf-text-muted)]">
          The link works once and expires in 24 hours. Come back to this page when you&apos;re done.
        </p>
        {state.replacedEarlierLink && (
          <p role="status" className="mt-2 text-xs font-semibold text-[var(--cf-warning)]">
            The selfie link we sent you earlier no longer works. Use this one instead.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button type="button" variant="secondary" size="sm" onClick={start} disabled={state.kind === "loading"}>
        <Smartphone className="mr-2 h-4 w-4" />
        {state.kind === "loading" ? "Creating your link…" : "Continue on your phone"}
      </Button>
      <p className="text-xs text-[var(--cf-text-muted)]">This replaces any selfie link we sent you before.</p>
      {state.kind === "error" && <p role="alert" className="text-xs text-[var(--cf-danger)]">{state.message}</p>}
    </div>
  )
}
