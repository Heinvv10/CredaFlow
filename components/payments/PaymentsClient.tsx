"use client"

import { useMemo, useState } from "react"
import { VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS } from "@/lib/loan/value-date-limits"
import { reconcileBody, requiresOverride } from "@/lib/payments/reconcile-payload"
import { useRouter } from "next/navigation"
import { Download, RotateCcw, Upload, CheckCircle, AlertTriangle } from "lucide-react"
import { FilterSelect, FilterSummary, SearchInput } from "@/components/ui/list-filters"
import { BulkUpload } from "./BulkUpload"
import { matchesCentsAmount } from "@/lib/list-search"
import { displayPaymentMethod } from "@/lib/payments/waiver"

interface Payment {
  id: string
  loanId: string
  amount: number
  paymentMethod: string
  reference?: string | null
  notes?: string | null
  capturedBy?: string | null
  /** Value date — when the money reached us, which is what the client's
   *  statement and the loan ledger show. */
  receivedAt: string
  reversed: boolean
  reversedAt?: string | null
  reversalReason?: string | null
  allocationStatus: "ALLOCATED" | "UNAPPLIED" | "REFUNDED"
  reconciliationReason?: string | null
  reconciliationReference?: string | null
  reconciledAt?: string | null
  createdAt: string
  loan: {
    id: string
    reference: string
    outstandingPrincipal: number
    client: { firstName: string; lastName: string }
  }
}

const METHOD_STYLES: Record<string, string> = {
  EFT:          "bg-blue-100 text-blue-700",
  CASH:         "bg-green-100 text-green-700",
  DEBIT_ORDER:  "bg-purple-100 text-purple-700",
  CARD:         "bg-amber-100 text-amber-700",
  // Non-cash: a balance written off, not money received.
  WAIVER:       "bg-red-100 text-red-700",
}

// Why a receipt is waiting in the queue, in words staff can act on.
const RECONCILIATION_REASON_LABELS: Record<string, string> = {
  charges_refused: "Held: default charges could not be booked — allocate once resolved",
}
const reconciliationReasonLabel = (reason: string | null | undefined) =>
  (reason && RECONCILIATION_REASON_LABELS[reason]) || reason?.replaceAll("_", " ") || "Manual review required"

function formatZAR(cents: number) {
  return `R ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDateTime(d: string) {
  // Explicit timeZone: without it this resolves to the JS runtime's local
  // zone, which differs between the server (SSR, typically UTC) and the
  // browser (SAST) — a text mismatch that trips React hydration (#418).
  return new Date(d).toLocaleString("en-ZA", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Johannesburg" })
}

type Tab = "recent" | "unapplied" | "bulk" | "resolved"

interface PaymentsClientProps {
  /** Allocated receipts inside the selected period, capped at `rowCap`. */
  allocated: Payment[]
  /** How many exist in the period, so a capped list can say what it omits. */
  allocatedCount: number
  /** ALL outstanding unapplied receipts — never period-scoped. See below. */
  unapplied: Payment[]
  /** Refunded or reversed receipts inside the selected period, capped. */
  resolved: Payment[]
  /** How many exist in the period — this tab is capped like Allocated is. */
  resolvedCount: number
  periodLabel: string
  /** Query string for the active period, so Export downloads what is on screen. */
  periodQuery: string
  rowCap: number
}

export function PaymentsClient({
  allocated,
  allocatedCount,
  unapplied,
  resolved,
  resolvedCount,
  periodLabel,
  periodQuery,
  rowCap,
}: PaymentsClientProps) {
  const router = useRouter()
  const [tab, setTab] = useState<Tab>("recent")
  // One search box shared across tabs so the query survives a tab switch;
  // it filters WITHIN whichever tab's rows are on screen, never across tabs.
  const [search, setSearch] = useState("")
  // Method only has visible meaning on the Allocated table (the only one that
  // renders a Method column), so it's applied there only — judgement call.
  const [method, setMethod] = useState("ALL")
  const [reversalTarget, setReversalTarget] = useState<string | null>(null)
  const [reversalReason, setReversalReason] = useState("")
  const [reversing, setReversing] = useState(false)
  const [reversalError, setReversalError] = useState<string | null>(null)
  const [reversalDone, setReversalDone] = useState<string | null>(null)
  const [reconciliationTarget, setReconciliationTarget] = useState<string | null>(null)
  const [reconciliationReason, setReconciliationReason] = useState("")
  const [reconciliationReference, setReconciliationReference] = useState("")
  const [reconciling, setReconciling] = useState(false)
  const [reconciliationError, setReconciliationError] = useState<string | null>(null)
  // Revealed only when the server refuses the rebate this receipt's value date
  // writes off. Without it a refused receipt can never be discharged, and this
  // screen is the only place unapplied money can be.
  const [valueDateOverrideReason, setValueDateOverrideReason] = useState("")
  const [needsValueDateOverride, setNeedsValueDateOverride] = useState(false)

  // Partitioning moved to the server. It cannot happen here any more: the tabs
  // no longer share one window — Allocated and Refunded/Reversed are scoped to
  // the selected period while Needs Reconciliation is deliberately all-time —
  // and a client-side split of a capped list would silently describe 200 rows
  // as the whole period.
  const truncated = Math.max(0, allocatedCount - allocated.length)
  const resolvedTruncated = Math.max(0, resolvedCount - resolved.length)

  // Options come from the rows actually on screen, so the select can never
  // offer a value that matches nothing.
  const methods = useMemo(
    () => Array.from(new Set(allocated.map((p) => p.paymentMethod))).sort(),
    [allocated]
  )

  const searchQuery = search.trim().toLowerCase()

  const matchesSearch = useMemo(() => {
    return (p: Payment) => {
      if (!searchQuery) return true
      const clientName = `${p.loan.client.firstName} ${p.loan.client.lastName}`.toLowerCase()
      if (
        clientName.includes(searchQuery) ||
        p.loan.reference.toLowerCase().includes(searchQuery) ||
        (p.reference ?? "").toLowerCase().includes(searchQuery)
      ) {
        return true
      }
      if (matchesCentsAmount(search, p.amount)) return true
      return false
    }
  }, [search, searchQuery])

  const filteredAllocated = useMemo(
    () => allocated.filter((p) => (method === "ALL" || p.paymentMethod === method) && matchesSearch(p)),
    [allocated, matchesSearch, method]
  )
  const filteredUnapplied = useMemo(
    () => unapplied.filter(matchesSearch),
    [unapplied, matchesSearch]
  )
  const filteredResolved = useMemo(
    () => resolved.filter(matchesSearch),
    [resolved, matchesSearch]
  )

  const activeIsFiltered = tab === "recent"
    ? searchQuery.length > 0 || method !== "ALL"
    : searchQuery.length > 0
  const activeMatched =
    tab === "recent" ? filteredAllocated.length
    : tab === "unapplied" ? filteredUnapplied.length
    : filteredResolved.length
  // "Total" here is the rows already loaded for the active tab (i.e. what's
  // rendered), not allocatedCount/resolvedCount — those describe the whole
  // period and may exceed what search can actually see, since search only
  // ever runs over rows already on screen.
  const activeTotal =
    tab === "recent" ? allocated.length
    : tab === "unapplied" ? unapplied.length
    : resolved.length
  const clearActiveFilters = () => {
    setSearch("")
    if (tab === "recent") setMethod("ALL")
  }

  async function submitReversal(id: string) {
    if (!reversalReason.trim()) { setReversalError("Reason required"); return }
    setReversing(true)
    setReversalError(null)
    try {
      const res = await fetch(`/api/payments/${id}/reverse`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reversalReason }),
      })
      if (!res.ok) {
        const d = await res.json() as { error?: string }
        setReversalError(d.error ?? "Failed")
        return
      }
      setReversalDone(id)
      setReversalTarget(null)
      setReversalReason("")
      setTimeout(() => { setReversalDone(null); router.refresh() }, 1500)
    } catch {
      setReversalError("Request failed")
    } finally {
      setReversing(false)
    }
  }

  async function submitReconciliation(
    id: string,
    action: "allocate" | "record_refund",
  ) {
    if (!reconciliationReason.trim() || !reconciliationReference.trim()) {
      setReconciliationError("Reason and bank/refund reference are required")
      return
    }
    // This screen submits from onClick, not a <form>, so `minLength` never
    // fires — without this the floor is only enforced by a server round trip.
    const override = valueDateOverrideReason.trim()
    if (
      needsValueDateOverride
      && override.length > 0
      && override.length < VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS
    ) {
      setReconciliationError(
        `The reason must be at least ${VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS} characters.`,
      )
      return
    }
    setReconciling(true)
    setReconciliationError(null)
    try {
      const res = await fetch(`/api/payments/${id}/reconcile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reconcileBody({
          action,
          reason: reconciliationReason,
          reference: reconciliationReference,
          valueDateOverrideReason,
        })),
      })
      if (!res.ok) {
        const data = await res.json() as {
          error?: string
          maxAmountCents?: number
          requiresValueDateOverride?: boolean
        }
        const max = data.maxAmountCents == null
          ? ""
          : ` Maximum allocatable: ${formatZAR(data.maxAmountCents)}.`
        // Open the override field rather than repeating the refusal forever:
        // the reason must go in `valueDateOverrideReason`, and staff typing it
        // into the ordinary Reason box would be refused identically every time.
        if (requiresOverride(data)) setNeedsValueDateOverride(true)
        setReconciliationError(`${data.error ?? "Failed"}.${max}`)
        return
      }
      setReconciliationTarget(null)
      setReconciliationReason("")
      setReconciliationReference("")
      setValueDateOverrideReason("")
      setNeedsValueDateOverride(false)
      router.refresh()
    } catch {
      setReconciliationError("Request failed")
    } finally {
      setReconciling(false)
    }
  }

  const TABS: { key: Tab; label: string; count?: number }[] = [
    { key: "recent", label: "Allocated", count: allocatedCount },
    { key: "unapplied", label: "Needs Reconciliation", count: unapplied.length },
    { key: "bulk",   label: "Bulk Upload" },
    { key: "resolved", label: "Refunded / Reversed", count: resolvedCount },
  ]

  return (
    <div className="bg-white rounded-lg shadow-sm overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center justify-between gap-3 overflow-x-auto border-b border-gray-100 px-5">
        <div className="flex shrink-0">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 px-4 py-3.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? "border-[#4338CA] text-[#4338CA]"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.label}
              {t.count !== undefined && (
                <span className={`ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                  tab === t.key ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-500"
                }`}>{t.count}</span>
              )}
            </button>
          ))}
        </div>
        {tab === "recent" && (
          <a
            href={`/api/reports/export?type=payments&${periodQuery}`}
            className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-gray-500 hover:text-gray-700"
          >
            <Download className="h-3.5 w-3.5" />
            Export all receipts · {periodLabel}
          </a>
        )}
      </div>

      {/* Search/filter bar — one query box shared by the three data tabs,
          filtering only the rows already loaded for whichever tab is active. */}
      {tab !== "bulk" && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <SearchInput
              value={search}
              onChange={setSearch}
              label="Search payments"
              placeholder="Search client, reference, amount…"
            />
            {tab === "recent" && (
              <FilterSelect
                value={method}
                onChange={setMethod}
                label="Filter by payment method"
                options={[
                  { value: "ALL", label: "All methods" },
                  ...methods.map((m) => ({ value: m, label: displayPaymentMethod(m, (method) => method.replace(/_/g, " ")) })),
                ]}
              />
            )}
          </div>
          {activeIsFiltered && (
            <FilterSummary matched={activeMatched} total={activeTotal} noun="payments" onClear={clearActiveFilters} />
          )}
        </div>
      )}

      {/* Recent payments */}
      {tab === "recent" && (
        <div className="overflow-x-auto">
          {allocated.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">
              <p>No allocated payments in {periodLabel}.</p>
              {/* The old copy said "recorded yet", which becomes a lie the
                  moment a period is selected — the receipts exist, they are
                  simply outside the window the reader chose. */}
              <a href="/payments?period=all" className="mt-1 inline-block text-[#4338CA] hover:underline">
                Show all time
              </a>
            </div>
          ) : filteredAllocated.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-400">
              <p>No payments match your search.</p>
              {/* The search only ever ran over the rows this page loaded. On a
                  truncated period, "no match" would otherwise read as "this
                  payment does not exist" — the very reading the truncation
                  banner below exists to prevent. */}
              {truncated > 0 && (
                <p className="mt-1">
                  Only the most recent {rowCap} of {allocatedCount} payments in {periodLabel} were
                  searched — narrow the period to search the other {truncated}.
                </p>
              )}
              <button onClick={clearActiveFilters} className="mt-1 text-[#4338CA] hover:underline">
                Clear filters
              </button>
            </div>
          ) : (
            <>
              {truncated > 0 && (
                /* Never let a cap read as completeness: 200 rows presented
                   without comment look exactly like "this is everything". */
                <p className="border-b border-gray-50 bg-gray-50/50 px-5 py-2 text-[11px] text-gray-500">
                  Showing the most recent {rowCap} of {allocatedCount} payments in {periodLabel} —
                  narrow the period to see the other {truncated}.
                </p>
              )}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-gray-50/50">
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Date</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Client</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Loan</th>
                  <th className="px-4 py-3 text-right text-[11px] font-semibold text-gray-400 uppercase">Amount</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Method</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Reference</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Notes</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filteredAllocated.map(p => (
                  <tr key={p.id} className={`border-b border-gray-50 hover:bg-gray-50/50 ${reversalDone === p.id ? "bg-green-50" : ""}`}>
                    <td className="px-4 py-3 text-[11px] text-gray-500">{formatDateTime(p.receivedAt)}</td>
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {p.loan.client.firstName} {p.loan.client.lastName}
                    </td>
                    <td className="px-4 py-3">
                      <a href={`/loans/${p.loanId}`} className="text-[#4338CA] hover:underline text-[12px]">{p.loan.reference}</a>
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-green-600">{formatZAR(p.amount)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${METHOD_STYLES[p.paymentMethod] ?? "bg-gray-100 text-gray-600"}`}>
                        {displayPaymentMethod(p.paymentMethod, (method) => method.replace("_", " "))}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-gray-500 font-mono">{p.reference || "—"}</td>
                    <td className="px-4 py-3 text-[11px] text-gray-400 max-w-[120px] truncate">{p.notes || "—"}</td>
                    <td className="px-4 py-3">
                      {reversalDone === p.id ? (
                        <CheckCircle className="h-4 w-4 text-green-500" />
                      ) : reversalTarget === p.id ? (
                        <div className="flex items-center gap-2 min-w-[200px]">
                          <input
                            value={reversalReason}
                            onChange={e => setReversalReason(e.target.value)}
                            placeholder="Reason *"
                            className="border border-red-200 rounded px-2 py-1 text-xs flex-1 focus:outline-none focus:ring-1 focus:ring-red-300"
                            autoFocus
                          />
                          <button
                            onClick={() => submitReversal(p.id)}
                            disabled={reversing}
                            className="text-xs font-semibold text-white bg-red-500 px-2 py-1 rounded hover:bg-red-600 disabled:opacity-50"
                          >
                            {reversing ? "…" : "Void"}
                          </button>
                          <button onClick={() => { setReversalTarget(null); setReversalReason(""); setReversalError(null) }}
                            className="text-xs text-gray-400 hover:text-gray-600">✕</button>
                        </div>
                      ) : (
                        <button
                          onClick={() => { setReversalTarget(p.id); setReversalError(null) }}
                          className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-red-500 transition-colors"
                          title="Reverse payment"
                        >
                          <RotateCcw className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {reversalError && reversalTarget === p.id && (
                        <p className="text-[10px] text-red-500 mt-1">{reversalError}</p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </>
          )}
        </div>
      )}

      {/* Unapplied receipts are real money received but are not repayments
          until staff deliberately allocates them under the locked workflow. */}
      {tab === "unapplied" && (
        <div className="overflow-x-auto">
          {unapplied.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              No receipts need reconciliation
            </div>
          ) : filteredUnapplied.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              <p>No payments match your search.</p>
              <button onClick={clearActiveFilters} className="mt-1 text-[#4338CA] hover:underline">
                Clear filters
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-5 py-3 text-xs text-amber-800">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  These receipts have not reduced a loan balance. “Record refund”
                  records a refund already completed outside this system; it does
                  not send money. <strong>All time</strong> — unapplied money is a
                  live liability, so it is never hidden by the period filter.
                </p>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-50 bg-gray-50/50">
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase text-gray-400">Date</th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase text-gray-400">Client / Loan</th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase text-gray-400">Amount</th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase text-gray-400">Why held</th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase text-gray-400">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUnapplied.map((p) => (
                    <tr key={p.id} className="border-b border-gray-50 align-top">
                      <td className="px-4 py-3 text-[11px] text-gray-500">
                        {formatDateTime(p.receivedAt)}
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-800">
                          {p.loan.client.firstName} {p.loan.client.lastName}
                        </p>
                        <a href={`/loans/${p.loanId}`} className="text-[12px] text-[#4338CA] hover:underline">
                          {p.loan.reference}
                        </a>
                      </td>
                      <td className="px-4 py-3 text-right font-bold text-amber-700">
                        {formatZAR(p.amount)}
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">
                        {reconciliationReasonLabel(p.reconciliationReason)}
                      </td>
                      <td className="px-4 py-3">
                        {reconciliationTarget !== p.id ? (
                          <button
                            onClick={() => {
                              setReconciliationTarget(p.id)
                              setReconciliationReason("")
                              setReconciliationReference("")
                              setValueDateOverrideReason("")
                              setNeedsValueDateOverride(false)
                              setReconciliationError(null)
                            }}
                            className="rounded bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-200"
                          >
                            Reconcile
                          </button>
                        ) : (
                          <div className="min-w-[300px] space-y-2">
                            <input
                              value={reconciliationReason}
                              onChange={(e) => setReconciliationReason(e.target.value)}
                              placeholder="Documented reason *"
                              className="w-full rounded border border-gray-200 px-2 py-1 text-xs"
                              autoFocus
                            />
                            <input
                              value={reconciliationReference}
                              onChange={(e) => setReconciliationReference(e.target.value)}
                              placeholder="Bank / refund reference *"
                              className="w-full rounded border border-gray-200 px-2 py-1 text-xs"
                            />
                            {needsValueDateOverride && (
                              <input
                                value={valueDateOverrideReason}
                                onChange={(e) => setValueDateOverrideReason(e.target.value)}
                                placeholder={`Reason for the back-dated value date * (min ${VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS} characters)`}
                                className="w-full rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs"
                              />
                            )}
                            <div className="flex flex-wrap gap-2">
                              <button
                                onClick={() => submitReconciliation(p.id, "allocate")}
                                disabled={reconciling}
                                className="rounded bg-green-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                              >
                                Allocate
                              </button>
                              <button
                                onClick={() => submitReconciliation(p.id, "record_refund")}
                                disabled={reconciling}
                                className="rounded bg-gray-700 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50"
                              >
                                Record refund
                              </button>
                              <button
                                onClick={() => {
                                  setReconciliationTarget(null)
                                  setReconciliationError(null)
                                }}
                                className="px-2 py-1 text-xs text-gray-500"
                              >
                                Cancel
                              </button>
                            </div>
                            {reconciliationError && (
                              <p className="text-[11px] text-red-600">{reconciliationError}</p>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}

      {/* Bulk upload */}
      {tab === "bulk" && (
        <div className="p-5">
          <div className="mb-4">
            <h3 className="font-semibold text-gray-800 flex items-center gap-2">
              <Upload className="h-4 w-4 text-gray-500" />
              Bulk Payment Upload
            </h3>
            <p className="text-xs text-gray-500 mt-1">Upload a CSV with multiple payments. Each row maps to one loan via its reference number.</p>
          </div>
          <BulkUpload onComplete={() => router.refresh()} />
        </div>
      )}

      {/* Reversed payments */}
      {tab === "resolved" && (
        <div className="overflow-x-auto">
          {resolved.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              No refunded or reversed receipts in {periodLabel}
            </div>
          ) : filteredResolved.length === 0 ? (
            <div className="p-8 text-center text-gray-400 text-sm">
              <p>No payments match your search.</p>
              {resolvedTruncated > 0 && (
                <p className="mt-1">
                  Only the most recent {rowCap} of {resolvedCount} in {periodLabel} were searched —
                  narrow the period to search the other {resolvedTruncated}.
                </p>
              )}
              <button onClick={clearActiveFilters} className="mt-1 text-[#4338CA] hover:underline">
                Clear filters
              </button>
            </div>
          ) : (
            <>
              {resolvedTruncated > 0 && (
                <p className="border-b border-gray-50 bg-gray-50/50 px-5 py-2 text-[11px] text-gray-500">
                  Showing the most recent {rowCap} of {resolvedCount} in {periodLabel} —
                  narrow the period to see the other {resolvedTruncated}.
                </p>
              )}
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-50 bg-red-50/30">
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Original Date</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Client</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Loan</th>
                  <th className="px-4 py-3 text-right text-[11px] font-semibold text-gray-400 uppercase">Amount</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Resolution</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Reason</th>
                </tr>
              </thead>
              <tbody>
                {filteredResolved.map(p => (
                  <tr key={p.id} className="border-b border-gray-50 opacity-70">
                    <td className="px-4 py-3 text-[11px] text-gray-500">{formatDateTime(p.receivedAt)}</td>
                    <td className="px-4 py-3 text-gray-700">{p.loan.client.firstName} {p.loan.client.lastName}</td>
                    <td className="px-4 py-3 text-[12px] text-gray-500">{p.loan.reference}</td>
                    <td className="px-4 py-3 text-right font-bold text-gray-500">{formatZAR(p.amount)}</td>
                    <td className="px-4 py-3 text-[11px] text-gray-500">
                      {p.allocationStatus === "REFUNDED"
                        ? `Refund recorded${p.reconciledAt ? ` ${formatDateTime(p.reconciledAt)}` : ""}`
                        : p.reversedAt
                          ? `Reversed ${formatDateTime(p.reversedAt)}`
                          : "Reversed"}
                    </td>
                    <td className="px-4 py-3 text-[11px] text-gray-500 italic">
                      {p.allocationStatus === "REFUNDED"
                        ? `${p.reconciliationReason || "—"}${p.reconciliationReference ? ` (${p.reconciliationReference})` : ""}`
                        : p.reversalReason || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </>
          )}
        </div>
      )}
    </div>
  )
}
