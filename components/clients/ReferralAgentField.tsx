"use client"

import { useEffect, useState } from "react"
import { Label } from "@/components/ui/label"
// The UI-channel formatter (non-breaking space, so "R" never wraps away from
// the amount). lib/utils.ts keeps the plain-space one for SMS and NCA documents.
import { formatZAR } from "@/lib/loan-calculator"
import { toReferralCodeOptions, type ReferralCodeOption } from "./referral-agent-options"

// Manual referral-agent attribution for the client Edit form.
//
// Lives in its own component (rather than inline in ClientFormLegacy) for two
// reasons: ClientFormLegacy is already over the 300-line cap, and the
// load-failure semantics below are easier to keep honest in isolation.
//
// LOAD-FAILURE CONTRACT: the <select> — and therefore the
// `referralCodeId` FormData key — is rendered ONLY once the agent list
// has actually loaded AND the caller passed a defined current value. While
// loading, after a failed fetch, or when the field is read-only, this
// contributes NOTHING to the submitted payload, so the PUT handler's
// key-presence gate leaves the stored attribution untouched. Rendering an empty
// select in any of those states would post `null` and silently erase an agent's
// commission trail on any unrelated edit (a phone-number change, say).
//
// The IMPACT PREVIEW below is held to the WEAKER half of that contract on
// purpose: a failed impact fetch says so and still allows the save. The accrual
// is computed server-side from the same planner regardless, so blocking an
// unrelated client edit on a failed preview would be worse than saving without
// one. Only a real blocker returned by the server disables the save.

type ImpactLine = { loanReference: string; principalCents: number; commissionCents: number }
/** `commissionCents` is null when the row never recorded an amount. */
type ReverseLine = { loanReference: string; agentName: string; commissionCents: number | null }
type SkipLine = { loanReference: string; reason: string }
type Blocker = { kind: string; loanReference: string; agentName: string }

type ReferralImpact = {
  accrue: ImpactLine[]
  reverse: ReverseLine[]
  skipped: SkipLine[]
  blockers: Blocker[]
  totalAccrueCents: number
  /** Sum of the KNOWN reversal amounts only. */
  totalReverseCents: number
  /** How many reversals that total cannot account for. */
  reverseUnknownCount: number
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

// An amount the row never recorded is stated as unknown, never rendered as
// R0.00 — the same refusal the current-value text above already makes about an
// attribution nobody supplied.
const money = (cents: number | null) => (cents === null ? "amount not recorded" : formatZAR(cents))

/** What the impact preview reports to the form around it. */
export type ReferralImpactSummary = {
  /** The server refuses this move outright; the referral change cannot be saved. */
  blocked: boolean
  totalAccrueCents: number
  /** Sum of the KNOWN reversal amounts only — the same figure the PUT rebuilds
   *  and compares against, so both sides exclude unrecorded amounts alike. */
  totalReverseCents: number
}

// Staff read these, not engineers. An unmapped reason still renders its raw
// value rather than nothing — an exclusion the operator cannot see is worse than
// one phrased awkwardly.
const SKIP_REASON_TEXT: Record<string, string> = {
  // Covers every LoanStatus outside the backfill allow-list — DEFAULTED,
  // WRITTEN_OFF, PENDING_WRITE_OFF and CANCELLED — so it must not name two of
  // them and imply the others cannot reach it.
  INELIGIBLE_LOAN_STATUS: "this loan's status does not earn commission",
  AGENT_NOT_ACTIVE: "agent is not active",
  CODE_NOT_ACTIVE: "referral code is not active",
  SELF_REFERRAL: "the agent is the borrower",
  ZERO_RATE: "commission rate is zero",
  ALREADY_ACCRUED: "commission already credited on this loan",
  WITHHELD_ROW_EXISTS: "commission on this loan is on hold — a loan admin must decide it first",
  UNKNOWN_ROW_STATUS: "an existing commission row is in an unrecognised state",
  CLAWED_BACK: "commission was clawed back when this loan defaulted",
  NO_CLAWBACK_PATH: "restructured loan — commission here cannot be reversed later",
}

const skipReasonText = (reason: string) => SKIP_REASON_TEXT[reason] ?? reason

export function ReferralAgentField({
  clientId,
  initialCodeId,
  initialCodeLabel,
  canEdit,
  onImpactChange,
}: {
  /** Whose commission ledger the impact preview is computed against. */
  clientId: string
  /** Current attribution. `undefined` means the caller did not supply it — the
   *  field then renders read-only rather than risking a wipe on save. */
  initialCodeId: string | null | undefined
  /** Human-readable current agent, so a retired code isn't an anonymous id. */
  initialCodeLabel?: string | null
  /** Re-pointing commission needs LOAN_ADMIN (see lib/clients/referral-update.ts). */
  canEdit: boolean
  /** The previewed impact, or null when there is no pending move (or no usable
   *  preview). The form binds the SAVE to these totals so the write cannot
   *  differ from what was approved, and reads `blocked` to refuse the referral
   *  change alone. Null after a failed preview — see the contract above. */
  onImpactChange?: (summary: ReferralImpactSummary | null) => void
}) {
  const [options, setOptions] = useState<ReferralCodeOption[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [pendingCodeId, setPendingCodeId] = useState<string | null | undefined>(undefined)
  const [impact, setImpact] = useState<ReferralImpact | null>(null)
  const [impactFailed, setImpactFailed] = useState(false)
  const editable = canEdit && initialCodeId !== undefined

  useEffect(() => {
    if (!editable) return
    let cancelled = false
    fetch("/api/agent-hub/agents")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((payload) => {
        if (!cancelled) setOptions(toReferralCodeOptions(payload))
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [editable])

  // Only a genuine move is previewed. Returning the select to its stored value
  // is not a change, and the server would plan nothing for it anyway.
  useEffect(() => {
    if (pendingCodeId === undefined) return
    let cancelled = false
    setImpact(null)
    setImpactFailed(false)
    onImpactChange?.(null)
    const query = pendingCodeId ? `?codeId=${encodeURIComponent(pendingCodeId)}` : ""
    fetch(`/api/clients/${clientId}/referral-impact${query}`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((payload: ReferralImpact) => {
        if (cancelled) return
        setImpact(payload)
        onImpactChange?.({
          blocked: payload.blockers.length > 0,
          totalAccrueCents: payload.totalAccrueCents,
          totalReverseCents: payload.totalReverseCents,
        })
      })
      .catch(() => {
        // Stays null: there are no approved totals to bind the write to, and the
        // save is deliberately NOT blocked.
        if (!cancelled) setImpactFailed(true)
      })
    return () => {
      cancelled = true
    }
    // onImpactChange is the parent's setter and is not part of the query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, pendingCodeId])

  // A client attributed to a code that has since been retired (or whose agent
  // was deactivated) must still round-trip its current value, otherwise saving
  // an unrelated field would drop the attribution. The API accepts an unchanged
  // value for exactly this reason. Name the agent so staff can see what they
  // would be discarding — moving off a retired code is one-way.
  const known = options?.some((o) => o.id === initialCodeId) ?? false
  const selectable: ReferralCodeOption[] =
    options && initialCodeId && !known
      ? [
          {
            id: initialCodeId,
            label: initialCodeLabel
              ? `${initialCodeLabel} — no longer active (keep, or change permanently)`
              : "Current agent — no longer active (keep, or change permanently)",
          },
          ...options,
        ]
      : options ?? []

  // Never assert "No referral agent" when the value simply wasn't supplied —
  // claiming a money field is empty when it may not be is worse than admitting
  // we don't know.
  const currentText =
    initialCodeLabel ||
    (initialCodeId ? "Assigned agent" : initialCodeId === null ? "No referral agent" : "Not shown")

  const incomingName = pendingCodeId
    ? selectable.find((o) => o.id === pendingCodeId)?.label ?? "this agent"
    : null

  return (
    <div className="mt-6 border-t border-gray-200 pt-4">
      <Label htmlFor="referralCodeId" className="text-gray-700">
        Referral agent
      </Label>
      {editable && options ? (
        <select
          id="referralCodeId"
          name="referralCodeId"
          defaultValue={initialCodeId ?? ""}
          onChange={(e) => {
            const next = e.target.value || null
            setPendingCodeId(next === (initialCodeId ?? null) ? undefined : next)
            if (next === (initialCodeId ?? null)) {
              setImpact(null)
              setImpactFailed(false)
              onImpactChange?.(null)
            }
          }}
          className="mt-1 flex h-10 w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-brand)] md:max-w-md"
        >
          <option value="">No referral agent</option>
          {selectable.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      ) : (
        <p className="mt-1 text-sm text-gray-700">
          {currentText}
          {editable && (
            <span className="ml-2 text-gray-500">
              {failed ? "(agent list unavailable — left unchanged)" : "(loading agents…)"}
            </span>
          )}
        </p>
      )}

      {impactFailed && (
        <p className="mt-2 text-sm text-amber-700">
          The commission impact of this change could not be calculated. Saving still applies it —
          the figures are computed on the server.
        </p>
      )}

      {impact && (
        <div className="mt-2 space-y-1 text-sm">
          {impact.blockers.map((blocker) => (
            <p key={blocker.loanReference} className="text-red-700">
              Commission on {blocker.loanReference} has already been paid to {blocker.agentName}.
              This change cannot be saved until that payout is reversed. Set the referral agent
              back to {currentText} to save your other changes.
            </p>
          ))}
          {impact.accrue.length > 0 && (
            <p className="text-gray-700">
              Crediting {incomingName} will accrue <strong>{formatZAR(impact.totalAccrueCents)}</strong>
              {" "}across {plural(impact.accrue.length, "past loan")} (
              {impact.accrue.map((line) => `${line.loanReference} ${formatZAR(line.commissionCents)}`).join(", ")}
              ).
            </p>
          )}
          {impact.reverse.length > 0 && (
            <p className="text-gray-700">
              Reversing{" "}
              <strong>
                {impact.reverseUnknownCount > 0 ? "at least " : ""}
                {formatZAR(impact.totalReverseCents)}
              </strong>{" "}
              across {plural(impact.reverse.length, "loan")}
              {impact.reverseUnknownCount > 0
                && ` (the total excludes ${plural(impact.reverseUnknownCount, "row")} with no recorded amount)`}
              {" ("}
              {/* Per ROW, not one label from reverse[0]: two agents' rows can sit
                  in the same set and labelling the list with the first
                  misattributes every other line. */}
              {impact.reverse
                .map((line) => `${line.loanReference} ${money(line.commissionCents)} from ${line.agentName}`)
                .join(", ")}
              ).
            </p>
          )}
          {impact.skipped.length > 0 && (
            <p className="text-gray-500">
              Not credited:{" "}
              {impact.skipped
                .map((line) => `${line.loanReference} (${skipReasonText(line.reason)})`)
                .join(", ")}.
            </p>
          )}
          {/* `skipped` counts: a move where every loan was excluded has plenty to
              say, and claiming "no changes" alongside the exclusions it just
              listed contradicts the line above it. */}
          {impact.blockers.length === 0
            && impact.accrue.length === 0
            && impact.reverse.length === 0
            && impact.skipped.length === 0 && (
            <p className="text-gray-500">No past loan commission changes with this move.</p>
          )}
        </div>
      )}

      <p className="mt-2 text-xs text-gray-500">
        {!canEdit
          ? "Credits this client's loans to a referral agent. Only a loan administrator can change it."
          : editable
            ? "Credits this client's loans to a referral agent. Set it here when an agent referred this client."
            : "Credits this client's loans to a referral agent. Not editable here — reopen this client from the clients list."}
      </p>
    </div>
  )
}
