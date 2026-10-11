"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
// Same ceiling the server validates against. commission-rate-input has no
// imports of its own, so a client component can share it rather than keep a
// second copy that drifts.
import { REFERRAL_COMMISSION_BPS_MAX as BPS_MAX } from "@/lib/referral-agents/commission-rate-input"

/**
 * Tenant-default referral commission rate. Agents with no per-agent override
 * inherit this; setting it to 0 turns commission off for all of them.
 *
 * Rendered only for ADMIN — a per-agent override prices one agent, this prices
 * every agent without one. The API route enforces the same floor independently.
 */
export function TenantCommissionRateEditor({ initialBps }: { initialBps: number }) {
  const router = useRouter()
  const [pct, setPct] = useState(String(initialBps / 100))
  const [saved, setSaved] = useState(initialBps)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)

  const trimmed = pct.trim()
  const numeric = Number(trimmed)
  const bps = Math.round(numeric * 100)
  const invalid =
    trimmed === "" ||
    !Number.isFinite(numeric) ||
    numeric < 0 ||
    bps > BPS_MAX ||
    // A rate finer than 0.01% cannot be stored — refuse rather than round it away.
    Math.abs(numeric * 100 - bps) > 1e-9
  const dirty = !invalid && bps !== saved

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch("/api/settings/referral-commission", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ referralCommissionBps: bps }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || `Save failed (${res.status})`)
      setSaved(bps)
      setMessage({
        tone: "ok",
        text: bps === 0
          ? "Saved — commission is now OFF. No agent will earn on new disbursements."
          : `Saved — agents without their own rate now earn ${(bps / 100).toFixed(2)}% of principal.`,
      })
      // The "commission is switched off" banner is server-rendered from the same
      // value this just changed. Without a refresh it keeps claiming commission
      // is off directly above the message saying it was switched on — which reads
      // as a failed save and invites a second click.
      router.refresh()
    } catch (e) {
      setMessage({ tone: "error", text: e instanceof Error ? e.message : "Save failed" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-5">
      <h2 className="font-semibold text-[var(--cf-text)]">Default commission rate</h2>
      <p className="mt-1 max-w-2xl text-xs text-gray-500">
        Applies to every agent who has no rate of their own. Commission accrues when a
        referred loan is <strong>disbursed</strong>, as a pending event a LOAN_ADMIN then
        approves. Changing this does not re-price commission already accrued.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="text-xs font-bold uppercase tracking-wide text-gray-500">Rate %</span>
          <input
            value={pct}
            onChange={(e) => { setPct(e.target.value); setMessage(null) }}
            inputMode="decimal"
            aria-label="Default commission rate percent"
            className="w-24 rounded border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-2 py-1 text-sm text-[var(--cf-text)] outline-none focus:border-amber-500"
          />
        </label>
        <span className="text-xs text-gray-500">= {invalid ? "—" : `${bps} bps`}</span>
        <button
          type="button"
          disabled={busy || invalid || !dirty}
          onClick={save}
          className="rounded-md border border-amber-500/30 px-3 py-1.5 text-xs font-semibold text-[var(--cf-warning)] hover:bg-amber-500/10 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save rate"}
        </button>
      </div>

      {invalid && trimmed !== "" ? (
        <p className="mt-2 text-xs text-[var(--cf-danger)]">
          Enter a percentage between 0 and 100, to at most two decimals.
        </p>
      ) : null}

      {/* A silent 0% disables commission and leaves the ledger empty. */}
      {!invalid && bps === 0 ? (
        <p className="mt-2 text-xs text-[var(--cf-danger)]">
          0% switches commission OFF. Referred loans will disburse and no agent will earn
          anything — with no warning anywhere else in the system.
        </p>
      ) : null}

      {message ? (
        <p className={`mt-2 text-xs ${message.tone === "ok" ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"}`}>
          {message.text}
        </p>
      ) : null}
    </section>
  )
}
