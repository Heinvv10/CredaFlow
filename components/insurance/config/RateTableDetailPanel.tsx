"use client"

import { useState } from "react"
import { toast } from "@/lib/toast"
import Link from "next/link"
import {
  readApiError,
  toRands,
  type EligibilityRuleRow,
  type RateTableDetail,
} from "@/lib/settings-insurance-config"
import { entryAgeMismatches } from "@/lib/insurance/rating/entry-age-coverage"
import { RateBandEditor } from "./RateBandEditor"
import type { RateBasis } from "@prisma/client"

const inputCls =
  "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"

const BASES: { value: RateBasis; label: string; hint: string }[] = [
  { value: "AGE_BANDED", label: "Age banded", hint: "An age band per cover tier." },
  { value: "FLAT", label: "Flat", hint: "One premium per cover tier; age is not a rating factor." },
  {
    value: "PER_MILLE",
    label: "Per mille",
    hint: "A rate per R1 000 of cover, applying across cover amounts.",
  },
]

/** `<input type="date">` wants YYYY-MM-DD; the API sends an ISO instant. */
function toDateInput(iso: string): string {
  return iso.slice(0, 10)
}

/**
 * One rate table.
 *
 * A DRAFT is editable. An ACTIVE or RETIRED one is NOT — it is what in-force
 * policies were priced from, and the API answers 409 to every write against it.
 * So the frozen view offers "Create new version" where the draft view offers an
 * edit control: a rate change is a new version that retires the old one, and in
 * -force policies keep the rate they were sold at. Rendering an edit button the
 * server will refuse would be an invitation to a 409.
 */
export function RateTableDetailPanel({
  table,
  productId,
  rules,
  canWrite,
  onChanged,
  onCreateVersionFrom,
  creatingVersion,
}: {
  table: RateTableDetail
  productId: string
  /**
   * The product's eligibility rules, for the cross-check below. Empty when they
   * could not be loaded — the check then reports nothing, which is the right
   * failure direction: it must never invent a disagreement from data it does
   * not have.
   */
  rules: EligibilityRuleRow[]
  canWrite: boolean
  onChanged: () => void
  onCreateVersionFrom: (table: RateTableDetail) => void
  creatingVersion: boolean
}) {
  const frozen = table.status !== "DRAFT"
  const [name, setName] = useState(table.name)
  const [basis, setBasis] = useState<RateBasis>(table.basis)
  const [effectiveFrom, setEffectiveFrom] = useState(toDateInput(table.effectiveFrom))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The panel is reused across selections, so the fields have to follow the
  // table it is showing. Without this, selecting version 2 leaves version 1's
  // name in the box and a save would rename the wrong card. Adjusted while
  // rendering, keyed on the table's id and editable fields rather than the
  // `table` object: the manager hands over a fresh object on every refresh.
  const tableKey = JSON.stringify([table.id, table.name, table.basis, table.effectiveFrom])
  const [prevTableKey, setPrevTableKey] = useState(tableKey)
  if (tableKey !== prevTableKey) {
    setPrevTableKey(tableKey)
    setName(table.name)
    setBasis(table.basis)
    setEffectiveFrom(toDateInput(table.effectiveFrom))
    setError(null)
  }

  async function send(url: string, method: string, body?: unknown, success?: string) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(url, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      })
      if (!res.ok) {
        setError(await readApiError(res))
        return false
      }
      if (success) toast.success(success)
      onChanged()
      return true
    } catch {
      setError("The request could not be sent. Check the connection and try again.")
      return false
    } finally {
      setBusy(false)
    }
  }

  const saveMeta = () =>
    send(
      `/api/insurance/rate-tables/${table.id}`,
      "PATCH",
      { name, basis, effectiveFrom: new Date(effectiveFrom).toISOString() },
      "Rate table updated"
    )

  function activate() {
    // The copy states what the transaction does, because activating is not an
    // isolated act: it retires whatever this product currently sells on, in the
    // same transaction, and there is no undo that restores the old card as
    // ACTIVE — a correction is another new version.
    if (
      !confirm(
        `Activate "${table.name}" (version ${table.version})?\n\n` +
          `Any rate table currently ACTIVE for this product is RETIRED in the same transaction, ` +
          `and this card becomes what every new quote is priced from. Policies already in force ` +
          `keep the rate they were sold at. This cannot be undone — a correction is another new version.`
      )
    ) {
      return
    }
    void send(`/api/insurance/rate-tables/${table.id}/activate`, "POST", undefined, "Rate table activated")
  }

  function retire() {
    if (
      !confirm(
        `Retire "${table.name}" (version ${table.version})?\n\n` +
          `The product is then left with NO rate table in force and cannot be quoted or sold ` +
          `until another version is activated.`
      )
    ) {
      return
    }
    void send(`/api/insurance/rate-tables/${table.id}/retire`, "POST", undefined, "Rate table retired")
  }

  function destroy() {
    if (!confirm(`Delete draft "${table.name}" (version ${table.version}) and all of its bands?`)) return
    void send(`/api/insurance/rate-tables/${table.id}`, "DELETE", undefined, "Draft deleted")
  }

  const entryAgeWarnings = entryAgeMismatches(
    table.basis,
    table.bands.map((band) => ({
      id: band.id,
      lifeType: band.lifeType,
      minAge: band.minAge,
      maxAge: band.maxAge,
      sumAssured: toRands(band.sumAssured),
      premiumAmount: toRands(band.premiumAmount),
    })),
    rules
  )

  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-5 space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-[#1b1d24]">
            {`Version ${table.version} — ${table.name}`}
          </h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {`${table.bands.length} band${table.bands.length === 1 ? "" : "s"} · ${table.status}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 justify-end">
          {canWrite && !frozen && (
            <>
              <button
                type="button"
                onClick={activate}
                disabled={busy}
                className="px-3 py-1.5 bg-[#4F46E5] hover:bg-[#4338CA] disabled:opacity-50 text-white text-xs font-semibold rounded-lg"
              >
                Activate
              </button>
              <button
                type="button"
                onClick={destroy}
                disabled={busy}
                className="px-3 py-1.5 border border-gray-200 hover:border-red-300 hover:text-red-600 disabled:opacity-50 text-xs font-semibold rounded-lg"
              >
                Delete draft
              </button>
            </>
          )}
          {canWrite && frozen && (
            <>
              <button
                type="button"
                onClick={() => onCreateVersionFrom(table)}
                disabled={creatingVersion}
                className="px-3 py-1.5 bg-[#4F46E5] hover:bg-[#4338CA] disabled:opacity-50 text-white text-xs font-semibold rounded-lg"
              >
                {creatingVersion ? "Creating…" : "Create new version"}
              </button>
              {table.status === "ACTIVE" && (
                <button
                  type="button"
                  onClick={retire}
                  disabled={busy}
                  className="px-3 py-1.5 border border-gray-200 hover:border-red-300 hover:text-red-600 disabled:opacity-50 text-xs font-semibold rounded-lg"
                >
                  Retire
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {frozen && (
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          {table.status === "ACTIVE"
            ? "This card is in force and cannot be edited. To change a rate, create a new version — activating it retires this one, and policies already sold keep this rate."
            : "This card is retired. It is kept as the record of what policies sold under it were priced at, and cannot be edited."}
        </p>
      )}

      {canWrite && !frozen && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
          <label className="block md:col-span-2">
            <span className="block text-xs font-semibold text-gray-500 mb-1">Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-gray-500 mb-1">Basis</span>
            <select
              value={basis}
              onChange={(e) => setBasis(e.target.value as RateBasis)}
              className={inputCls}
            >
              {BASES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-gray-500 mb-1">Effective from</span>
            <input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
              className={inputCls}
            />
          </label>
          <div className="md:col-span-4 flex items-center gap-3">
            <button
              type="button"
              onClick={saveMeta}
              disabled={busy}
              className="px-3 py-1.5 border border-gray-200 hover:border-[#4F46E5] disabled:opacity-50 text-xs font-semibold rounded-lg"
            >
              Save details
            </button>
            <p className="text-xs text-gray-400">
              {BASES.find((b) => b.value === basis)?.hint}
              {" Activation stamps the effective date with the moment it happens."}
            </p>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
          {error}
        </p>
      )}

      {/*
        The cross-check between two screens. The card and the entry-age rules
        are edited in different places and stored in different tables, and
        nothing compared them: a card banded 18-65 under a MAX_ENTRY_AGE of 70
        is valid on both screens and strands every 66-to-70-year-old — eligible
        by the screen, unpriceable by the card. Neither side is wrong on its
        own, so the warning names the DISAGREEMENT and links to the other half.
      */}
      {entryAgeWarnings.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 space-y-1">
          <p className="font-semibold">
            The entry ages this product accepts do not match what this card prices.
          </p>
          {entryAgeWarnings.map((mismatch) => (
            <p key={`${mismatch.lifeType}-${mismatch.ruleType}`} className="text-xs">
              {mismatch.detail}
            </p>
          ))}
          <p className="text-xs">
            {"Widen the card, or narrow the rule under "}
            <Link
              href={`/settings/products/insurance/${productId}/eligibility`}
              className="underline font-medium"
            >
              Eligibility rules
            </Link>
            {"."}
          </p>
        </div>
      )}

      <RateBandEditor
        tableId={table.id}
        basis={table.basis}
        bands={table.bands}
        canWrite={canWrite}
        frozen={frozen}
        onChanged={onChanged}
      />
    </div>
  )
}
