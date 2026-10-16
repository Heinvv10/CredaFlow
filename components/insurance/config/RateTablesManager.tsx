"use client"

import { useEffect, useState } from "react"
import { toast } from "@/lib/toast"
import {
  loadEligibilityRules,
  loadRateTable,
  loadRateTables,
  readApiError,
  type EligibilityRuleRow,
  type RateTableDetail,
  type RateTableSummary,
} from "@/lib/settings-insurance-config"
import { copyBandsOrDiscard } from "@/lib/insurance/rate-card-copy"
import { RateTableDetailPanel } from "./RateTableDetailPanel"

const STATUS_STYLES: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  ACTIVE: "bg-green-100 text-green-700",
  RETIRED: "bg-amber-100 text-amber-800",
}

interface RateTablesSnapshot {
  tables: RateTableSummary[]
  selectedId: string | null
  detail: RateTableDetail | null
  /** Set when the list loaded but the chosen table's detail did not. */
  detailError: string | null
}

async function fetchRateTables(productId: string, selectId: string | null): Promise<RateTablesSnapshot> {
  const tables = await loadRateTables(productId)
  const chosen = tables.find((t) => t.id === selectId) ?? tables[0]
  if (!chosen) return { tables, selectedId: null, detail: null, detailError: null }
  try {
    return { tables, selectedId: chosen.id, detail: await loadRateTable(chosen.id), detailError: null }
  } catch (err) {
    return { tables, selectedId: chosen.id, detail: null, detailError: (err as Error).message }
  }
}

export function RateTablesManager({
  productId,
  productName,
  canWrite,
}: {
  productId: string
  productName: string
  canWrite: boolean
}) {
  const [tables, setTables] = useState<RateTableSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<RateTableDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [rules, setRules] = useState<EligibilityRuleRow[]>([])

  // The eligibility rules are loaded here only to cross-check the card's age
  // coverage against them. A failure is SWALLOWED on purpose: the rules are not
  // this screen's subject, and an eligibility read that fails must not stop a
  // rate card being entered. The cross-check simply reports nothing, which is
  // the safe direction — it must never invent a disagreement from missing data.
  useEffect(() => {
    loadEligibilityRules(productId)
      .then(setRules)
      .catch(() => setRules([]))
  }, [productId])

  function applySnapshot(snap: RateTablesSnapshot) {
    setTables(snap.tables)
    setSelectedId(snap.selectedId)
    // A failed detail read leaves the previous detail on screen, as it always did.
    if (snap.detailError === null) setDetail(snap.detail)
    setLoadError(snap.detailError)
  }

  async function refresh(selectId?: string) {
    try {
      applySnapshot(await fetchRateTables(productId, selectId ?? selectedId))
    } catch (err) {
      setLoadError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // First load per product. A response that arrives after `productId` moved is
  // ignored. `selectedId` is null here: a selection from another product could
  // never be found in this one's list, so the first table is chosen either way.
  useEffect(() => {
    let ignore = false
    fetchRateTables(productId, null)
      .then((snap) => { if (!ignore) applySnapshot(snap) })
      .catch((err: Error) => { if (!ignore) setLoadError(err.message) })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [productId])

  async function select(id: string) {
    setSelectedId(id)
    setActionError(null)
    try {
      setDetail(await loadRateTable(id))
    } catch (err) {
      setLoadError((err as Error).message)
    }
  }

  /**
   * A new DRAFT, optionally carrying the bands of an existing card.
   *
   * Copying is done here, one POST per band, rather than by a bulk route: no
   * new API surface is in scope for this task, and every band goes through the
   * same overlap and money validation a hand-entered one does. A refusal stops
   * the copy and is reported verbatim, with the draft left in place holding
   * whatever copied — the alternative, deleting the partial draft, would throw
   * away work over one bad row.
   */
  async function createDraft(source?: RateTableDetail) {
    setCreating(true)
    setActionError(null)
    try {
      const res = await fetch("/api/insurance/rate-tables", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId,
          name: source ? source.name : `${productName} rates`,
          basis: source?.basis ?? "AGE_BANDED",
          insurerId: source?.insurerId ?? undefined,
        }),
      })
      if (!res.ok) {
        setActionError(await readApiError(res))
        return
      }
      const created = (await res.json()) as RateTableSummary

      if (source) {
        const result = await copyBandsOrDiscard(
          created.id,
          source.bands,
          (url, body) =>
            fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
          (url) => fetch(url, { method: "DELETE" })
        )

        if (result.failure) {
          // How partial it was, in numbers, on BOTH paths. "Copying a band
          // failed" left the operator counting rows against the source card to
          // learn whether one row went missing or twenty.
          const extent = `only ${result.copied} of ${result.total} bands copied`
          const refused = `The server refused band ${result.failure.index + 1}: ${result.failure.error}`

          setActionError(
            result.cleanup === "orphaned"
              ? // The cleanup failed too, so a half-written draft IS still
                // there and can be activated. This must never read like the
                // discard succeeded — it names the version so a human can
                // remove it by hand.
                `Version ${created.version} was left INCOMPLETE (${extent}) and could NOT be removed automatically. Delete version ${created.version} by hand before activating anything on this product. ${refused} The cleanup also failed: ${result.cleanupError}`
              : `No new version was created — ${extent}, so the incomplete draft was discarded. A part-copied rate card would price differently from the one it was cloned from. ${refused}`
          )
          await refresh(created.id)
          return
        }
      }

      toast.success(`Draft version ${created.version} created`)
      await refresh(created.id)
    } catch {
      setActionError("The request could not be sent. Check the connection and try again.")
    } finally {
      setCreating(false)
    }
  }

  if (loading) {
    return <div className="p-12 text-center text-gray-400 text-sm">Loading rate tables…</div>
  }

  return (
    <div className="space-y-6">
      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
          {loadError}
        </div>
      )}
      {actionError && (
        <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
          {actionError}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[16rem_1fr] gap-6 items-start">
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              Versions
            </span>
            {canWrite && (
              <button
                type="button"
                onClick={() => void createDraft()}
                disabled={creating}
                className="text-xs font-semibold text-[#4F46E5] hover:underline disabled:opacity-50"
              >
                {creating ? "…" : "+ New draft"}
              </button>
            )}
          </div>
          {tables.length === 0 ? (
            <p className="p-6 text-center text-xs text-gray-400">
              No rate table yet. This product cannot be quoted until one is entered and activated.
            </p>
          ) : (
            <ul>
              {tables.map((table) => (
                <li key={table.id}>
                  <button
                    type="button"
                    onClick={() => void select(table.id)}
                    className={`w-full text-left px-4 py-3 border-b border-gray-50 hover:bg-amber-50/30 ${
                      table.id === selectedId ? "bg-amber-50/60" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[#1b1d24]">{`v${table.version}`}</span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                          STATUS_STYLES[table.status] ?? "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {table.status}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 truncate">{table.name}</p>
                    <p className="text-[11px] text-gray-400">
                      {`${table._count.bands} band${table._count.bands === 1 ? "" : "s"}`}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {detail ? (
          <RateTableDetailPanel
            table={detail}
            productId={productId}
            rules={rules}
            canWrite={canWrite}
            onChanged={() => void refresh(detail.id)}
            onCreateVersionFrom={(source) => void createDraft(source)}
            creatingVersion={creating}
          />
        ) : (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-12 text-center text-sm text-gray-400">
            {canWrite
              ? "Create a draft version to start entering this product's rate card."
              : "No rate table has been entered for this product."}
          </div>
        )}
      </div>
    </div>
  )
}
