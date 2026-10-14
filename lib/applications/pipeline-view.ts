import {
  DISBURSEMENT_PRECONDITION_ORDER,
  type DisbursementPrecondition,
} from "@/lib/disbursement/preconditions"
import { READY_LABELS, type ApplicationReadiness } from "@/lib/applications/readiness-view"
import { borrowerDisplayName } from "@/lib/borrower"

/**
 * The statuses the Kanban board renders as lanes, in pipeline order.
 *
 * DECLINED and CANCELLED are deliberately absent. They are terminal — a
 * cancelled application is a record, not work — and they can outnumber the open
 * ones, which would make the board two lanes wider and every card narrower for
 * rows nobody acts on. They are reached through the table view instead, which
 * is why the board shows a closed count that links there.
 */
export const PIPELINE_COLUMNS = [
  { key: "DRAFT", label: "Draft" },
  { key: "SUBMITTED", label: "Submitted" },
  { key: "UNDER_REVIEW", label: "Under Review" },
  { key: "APPROVED", label: "Approved" },
  { key: "DISBURSED", label: "Disbursed" },
] as const

export const CLOSED_STATUSES = ["DECLINED", "CANCELLED"] as const

export type PipelineStatus =
  | (typeof PIPELINE_COLUMNS)[number]["key"]
  | (typeof CLOSED_STATUSES)[number]

/** A refused payout attempt, read from the AuditLog rather than recomputed. */
export interface PayoutRefusal {
  /** A `DisbursementPrecondition`, or any string a future refusal writes. */
  reason: string
  refusedAt: Date
  attempts: number
}

export interface PipelineApplication {
  id: string
  reference: string
  status: string
  appliedAmount: number
  createdAt: Date
  submittedAt: Date | null
  approvedAt: Date | null
  disbursedAt: Date | null
  updatedAt: Date
  client: { firstName: string; lastName: string } | null
  entity?: { legalName: string } | null
  product: { name: string; productType: string }
  branch: { name: string } | null
  assignedTo: { name: string | null } | null
  payoutRefusal: PayoutRefusal | null
  /**
   * What still blocks this application's next transition, computed server-side
   * once for the whole board. Null on the statuses that draw no chip — DRAFT,
   * DISBURSED and the terminal ones — and never a claim that the API will say
   * yes; see `lib/applications/readiness.ts`.
   */
  readiness: ApplicationReadiness | null
}

/**
 * Staff-facing wording for each refusal reason.
 *
 * Keyed off `DISBURSEMENT_PRECONDITION_ORDER` so the two cannot drift: the
 * board would otherwise keep rendering a precondition's raw snake_case name
 * after it is renamed, or silently lose one that is added.
 * `pipeline-view.test.ts` fails if a precondition has no label here.
 */
export const PAYOUT_BLOCK_LABELS: Record<DisbursementPrecondition, string> = {
  acknowledged_pasq: "PASQ not acknowledged",
  signed_agreement: "Agreement not signed",
  provider_countersign: "Not countersigned",
  composite_kyc: "KYC incomplete",
  unchanged_affordability: "Affordability changed",
  verified_banking: "Banking not verified",
  signed_debit_mandate: "Mandate not signed",
  insurance_election: "Credit life unresolved",
}

export interface PayoutBlock {
  reason: string
  label: string
  attempts: number
  refusedAt: Date
}

/**
 * Why this application's last payout attempt was refused, or null.
 *
 * DELIBERATELY LAGGING. It reports what happened, not what would happen now:
 * deciding the latter means running `assertDisbursementPreconditions`, which
 * reads document bytes to check their sha256, and that is not something to do
 * once per card on every board render. An application nobody has tried to pay
 * out therefore shows nothing — which is a different state from "clear", and
 * the board must not draw it as a clean card.
 *
 * The staleness window is closed by `updatedAt`: any write to the application
 * after the refusal drops the badge, because the evidence it refused on may
 * have changed. Refusals themselves cannot trigger that suppression — the
 * disburse route's only write to the application is inside the transaction that
 * succeeds, so a refused attempt leaves `updatedAt` alone: it moves only when
 * the payout finally goes through.
 */
export function payoutBlock(app: PipelineApplication): PayoutBlock | null {
  const refusal = app.payoutRefusal
  if (!refusal) return null
  if (app.updatedAt.getTime() > refusal.refusedAt.getTime()) return null
  return {
    reason: refusal.reason,
    // An unmapped reason still beats silence — staff can quote the code.
    label:
      PAYOUT_BLOCK_LABELS[refusal.reason as DisbursementPrecondition]
      ?? refusal.reason,
    attempts: refusal.attempts,
    refusedAt: refusal.refusedAt,
  }
}

/**
 * When the application entered the state it is in now — the clock a work queue
 * actually cares about. Sorting Approved by `createdAt` answers "which was
 * applied for first", when the question at that lane is "which has been waiting
 * to be paid out longest".
 */
export function statusEnteredAt(app: PipelineApplication): Date {
  switch (app.status) {
    case "DISBURSED":
      return app.disbursedAt ?? app.approvedAt ?? app.submittedAt ?? app.createdAt
    case "APPROVED":
      return app.approvedAt ?? app.submittedAt ?? app.createdAt
    case "SUBMITTED":
    case "UNDER_REVIEW":
      return app.submittedAt ?? app.createdAt
    default:
      return app.createdAt
  }
}

export function ageInDays(app: PipelineApplication, now: Date): number {
  const ms = now.getTime() - statusEnteredAt(app).getTime()
  return Math.floor(ms / 86_400_000)
}

export const SORT_KEYS = [
  "oldest",
  "newest",
  "ready_first",
  "amount_desc",
  "amount_asc",
  "client",
] as const
export type SortKey = (typeof SORT_KEYS)[number]

/**
 * A sort key from an untrusted source — a hand-edited or bookmarked query
 * string — falling back to `fallback` rather than reaching the comparator.
 *
 * Without this, `?sort_APPROVED=garbage` reached `sortApplications`, whose
 * `switch` returned undefined for every pair (no ordering at all) while the
 * lane's `<select>` had no matching option and so displayed the FIRST one. The
 * board then claimed an order it was not applying. The amount and age filters
 * already fell back this way; sort keys did not.
 */
export function toSortKey(value: string | null | undefined, fallback: SortKey): SortKey {
  return (SORT_KEYS as readonly string[]).includes(value ?? "")
    ? (value as SortKey)
    : fallback
}

/**
 * The statuses whose cards carry a readiness chip — the same set
 * `ReadinessChip` draws for, sourced from `READY_LABELS` so the two cannot
 * drift apart.
 */
export const READY_FIRST_STATUSES: readonly string[] = Object.keys(READY_LABELS)

/**
 * Which sort keys a lane's `<select>` should offer.
 *
 * "Ready first" only makes sense where readiness is computed at all — Draft
 * and Disbursed cards never carry a chip (see `PipelineApplication.readiness`),
 * so the option would either silently behave like "oldest" or, worse, exist
 * with no card ever moving under it. Rather than ship that unexplained no-op,
 * the option is absent from those lanes' menus entirely.
 */
export function sortOptionsForColumn(columnKey: string): readonly SortKey[] {
  if (READY_FIRST_STATUSES.includes(columnKey)) return SORT_KEYS
  return SORT_KEYS.filter((key) => key !== "ready_first")
}

/**
 * `toSortKey`, plus the column-specific menu: a value that is a real sort key
 * in general but not offered on THIS column (chiefly `ready_first` on Draft or
 * Disbursed, reached via a hand-edited `?sort_DRAFT=ready_first`) falls back
 * rather than being handed to the `<select>` as a `value` with no matching
 * `<option>` — the fallback that trap silently applies is the FIRST option,
 * not this one.
 */
export function toColumnSortKey(
  value: string | null | undefined,
  columnKey: string,
  fallback: SortKey,
): SortKey {
  const key = toSortKey(value, fallback)
  return sortOptionsForColumn(columnKey).includes(key) ? key : fallback
}

export const SORT_LABELS: Record<SortKey, string> = {
  oldest: "Oldest first",
  newest: "Newest first",
  ready_first: "Ready first",
  amount_desc: "Amount, high to low",
  amount_asc: "Amount, low to high",
  client: "Client name",
}

/**
 * Per-lane default order.
 *
 * The working lanes default to OLDEST first. Newest-first — the single order
 * this board used everywhere — buries the application that has been waiting
 * longest, which is the one at risk, under everything that arrived since.
 * Disbursed is the exception: it is a record rather than a queue, and the
 * recent payout is what anyone opening it is looking for.
 */
export const DEFAULT_COLUMN_SORT: Record<string, SortKey> = {
  DRAFT: "oldest",
  SUBMITTED: "oldest",
  UNDER_REVIEW: "oldest",
  APPROVED: "oldest",
  DISBURSED: "newest",
  DECLINED: "newest",
  CANCELLED: "newest",
}

function clientName(app: PipelineApplication): string {
  return borrowerDisplayName(app)
}

export function sortApplications(
  applications: readonly PipelineApplication[],
  key: SortKey,
): PipelineApplication[] {
  // Sorted on a copy: the caller's array is React state in the board and
  // mutating it in place skips a re-render.
  const sorted = [...applications]
  sorted.sort((a, b) => {
    switch (key) {
      case "oldest":
        return statusEnteredAt(a).getTime() - statusEnteredAt(b).getTime()
      case "newest":
        return statusEnteredAt(b).getTime() - statusEnteredAt(a).getTime()
      case "ready_first": {
        // READY above everything else. A missing chip (Draft/Disbursed shape,
        // or a status this board never computes readiness for) is NOT ready —
        // it groups with an explicit MISSING blocker, not above it — and both
        // tiers tiebreak oldest-first, same as the default lane order.
        const rankA = a.readiness?.stage === "READY" ? 0 : 1
        const rankB = b.readiness?.stage === "READY" ? 0 : 1
        if (rankA !== rankB) return rankA - rankB
        return statusEnteredAt(a).getTime() - statusEnteredAt(b).getTime()
      }
      case "amount_desc":
        return b.appliedAmount - a.appliedAmount
      case "amount_asc":
        return a.appliedAmount - b.appliedAmount
      case "client":
        return clientName(a).localeCompare(clientName(b), "en-ZA")
      default:
        // Unreachable for a `SortKey`, and the second line of defence behind
        // `toSortKey` for a value that arrived from a URL. Returning undefined
        // here — which is what a switch with no default does — is a comparator
        // that silently applies no ordering.
        return 0
    }
  })
  return sorted
}

export const AGE_BUCKETS = [
  { key: "any", label: "Any age", minDays: 0 },
  { key: "3d", label: "3+ days", minDays: 3 },
  { key: "7d", label: "7+ days", minDays: 7 },
  { key: "30d", label: "30+ days", minDays: 30 },
] as const
export type AgeBucketKey = (typeof AGE_BUCKETS)[number]["key"]

export const AMOUNT_BANDS = [
  { key: "any", label: "Any amount", minCents: 0, maxCents: Number.MAX_SAFE_INTEGER },
  { key: "lt2k", label: "Under R2 000", minCents: 0, maxCents: 200_000 },
  { key: "2k_10k", label: "R2 000 – R10 000", minCents: 200_000, maxCents: 1_000_000 },
  { key: "gt10k", label: "Over R10 000", minCents: 1_000_000, maxCents: Number.MAX_SAFE_INTEGER },
] as const
export type AmountBandKey = (typeof AMOUNT_BANDS)[number]["key"]

export const ANY = "all" as const

export interface PipelineFilters {
  search: string
  product: string
  branch: string
  assignee: string
  amountBand: AmountBandKey
  ageBucket: AgeBucketKey
  /** `ANY`, a precondition reason, or "blocked" for any refusal at all. */
  blocked: string
  /** Statuses to include. Empty means every status. */
  statuses: readonly string[]
  /**
   * Show only the applications with no readiness blocker.
   *
   * An application with no chip at all (DRAFT, DISBURSED, terminal) is NOT
   * ready — it is un-assessed. Treating "no chip" as ready would fill a
   * "ready only" board with the two lanes that have nothing to be ready for.
   */
  readyOnly: boolean
}

export const EMPTY_FILTERS: PipelineFilters = {
  search: "",
  product: ANY,
  branch: ANY,
  assignee: ANY,
  amountBand: "any",
  ageBucket: "any",
  blocked: ANY,
  statuses: [],
  readyOnly: false,
}

export function filtersAreActive(filters: PipelineFilters): boolean {
  return filters.search.trim().length > 0
    || filters.product !== ANY
    || filters.branch !== ANY
    || filters.assignee !== ANY
    || filters.amountBand !== "any"
    || filters.ageBucket !== "any"
    || filters.blocked !== ANY
    || filters.statuses.length > 0
    || filters.readyOnly
}

export const UNASSIGNED = "__unassigned__"

function matchesSearch(app: PipelineApplication, search: string): boolean {
  const query = search.trim().toLocaleLowerCase("en-ZA")
  if (!query) return true
  if (
    clientName(app).toLocaleLowerCase("en-ZA").includes(query)
    || app.reference.toLocaleLowerCase("en-ZA").includes(query)
    || app.product.name.toLocaleLowerCase("en-ZA").includes(query)
  ) {
    return true
  }
  // Staff search the rand figure they can see on the card, not the cents the
  // record holds.
  const digits = search.replace(/\D/g, "")
  if (!digits) return false
  return Math.round(app.appliedAmount / 100).toString().includes(digits)
}

export function applyFilters(
  applications: readonly PipelineApplication[],
  filters: PipelineFilters,
  now: Date,
): PipelineApplication[] {
  const band = AMOUNT_BANDS.find((b) => b.key === filters.amountBand) ?? AMOUNT_BANDS[0]
  const bucket = AGE_BUCKETS.find((b) => b.key === filters.ageBucket) ?? AGE_BUCKETS[0]

  return applications.filter((app) => {
    if (filters.readyOnly && app.readiness?.stage !== "READY") return false
    if (filters.statuses.length > 0 && !filters.statuses.includes(app.status)) return false
    if (filters.product !== ANY && app.product.name !== filters.product) return false
    if (filters.branch !== ANY) {
      const branch = app.branch?.name ?? UNASSIGNED
      if (branch !== filters.branch) return false
    }
    if (filters.assignee !== ANY) {
      const assignee = app.assignedTo?.name ?? UNASSIGNED
      if (assignee !== filters.assignee) return false
    }
    if (app.appliedAmount < band.minCents || app.appliedAmount >= band.maxCents) return false
    if (ageInDays(app, now) < bucket.minDays) return false
    if (filters.blocked !== ANY) {
      const block = payoutBlock(app)
      if (!block) return false
      if (filters.blocked !== "blocked" && block.reason !== filters.blocked) return false
    }
    return matchesSearch(app, filters.search)
  })
}

/**
 * The reasons actually present in the current data, for the filter dropdown.
 * Listing all eight preconditions would offer staff seven dead options.
 */
export function presentBlockReasons(
  applications: readonly PipelineApplication[],
): { reason: string; label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number }>()
  for (const app of applications) {
    const block = payoutBlock(app)
    if (!block) continue
    const seen = counts.get(block.reason)
    if (seen) seen.count += 1
    else counts.set(block.reason, { label: block.label, count: 1 })
  }
  return [...counts.entries()]
    .map(([reason, { label, count }]) => ({ reason, label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "en-ZA"))
}

/** How many of these applications have a chip, and how many of those are ready. */
export function readyCount(applications: readonly PipelineApplication[]): number {
  return applications.filter((app) => app.readiness?.stage === "READY").length
}

export function distinctValues(
  applications: readonly PipelineApplication[],
  pick: (app: PipelineApplication) => string | null,
): string[] {
  const values = new Set<string>()
  for (const app of applications) {
    const value = pick(app)
    if (value) values.add(value)
  }
  return [...values].sort((a, b) => a.localeCompare(b, "en-ZA"))
}

/** Every precondition, for tests and for the filter's stable ordering. */
export const ALL_PAYOUT_BLOCK_REASONS: readonly DisbursementPrecondition[] =
  DISBURSEMENT_PRECONDITION_ORDER

/** One `LOAN_DISBURSEMENT_REFUSED` audit row, as stored. */
export interface RefusalAuditRow {
  /** Nullable on `AuditLog`. A row with no subject belongs to no application. */
  entityId: string | null
  createdAt: Date
  /** `AuditLog.newValue` — `{ reason, refused, httpStatus }`. */
  newValue: unknown
}

function refusalReason(newValue: unknown): string {
  if (typeof newValue !== "object" || newValue === null) return "unknown"
  const reason = (newValue as { reason?: unknown }).reason
  return typeof reason === "string" && reason.length > 0 ? reason : "unknown"
}

/**
 * Collapse the refusal audit rows into one entry per application: the LATEST
 * reason, and how many times the payout has been refused in total.
 *
 * The count is the part staff cannot get anywhere else: an application can be
 * refused many times before it goes through, and a board that shows only the
 * most recent reason reads a thirteenth attempt the same as a first.
 *
 * Rows must arrive NEWEST FIRST; the first row seen for an application wins.
 */
export function latestRefusalByApplication(
  rows: readonly RefusalAuditRow[],
): Map<string, PayoutRefusal> {
  const byApplication = new Map<string, PayoutRefusal>()
  for (const row of rows) {
    if (!row.entityId) continue
    const seen = byApplication.get(row.entityId)
    if (seen) {
      seen.attempts += 1
      continue
    }
    byApplication.set(row.entityId, {
      reason: refusalReason(row.newValue),
      refusedAt: row.createdAt,
      attempts: 1,
    })
  }
  return byApplication
}

export interface SelectOption {
  value: string
  label: string
}

/**
 * The option list to render for a `<select>` whose value may not be in it.
 *
 * A `<select>` whose `value` matches no option silently displays the FIRST
 * one — it does not render blank and it does not warn. These lists are derived
 * from the applications currently loaded, so a shared or bookmarked link
 * filtered to a product, branch or person no longer present would read "All
 * products" while the filter was still being applied, over an empty board.
 * Naming the orphan keeps the control honest and gives staff something to
 * clear.
 */
export function optionsIncludingValue(
  value: string,
  options: readonly SelectOption[],
): SelectOption[] {
  if (options.some((option) => option.value === value)) return [...options]
  return [{ value, label: `${value} (not in view)` }, ...options]
}

/**
 * The `<select>` value representing a status filter.
 *
 * The closed shortcut selects TWO statuses at once. Collapsing any multi-value
 * selection to `ANY` made the control read "All statuses" immediately after the
 * one link that sets it, so the joined value is an option in its own right.
 */
export function statusSelectValue(statuses: readonly string[]): string {
  return statuses.length > 0 ? statuses.join(",") : ANY
}
