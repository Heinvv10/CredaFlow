"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { Columns3, LayoutGrid, Plus, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ApplicationKanban } from "@/components/applications/ApplicationKanban"
import { ApplicationTable } from "@/components/applications/ApplicationTable"
import {
  AGE_BUCKETS,
  AMOUNT_BANDS,
  ANY,
  applyFilters,
  CLOSED_STATUSES,
  DEFAULT_COLUMN_SORT,
  distinctValues,
  filtersAreActive,
  PIPELINE_COLUMNS,
  optionsIncludingValue,
  presentBlockReasons,
  statusSelectValue,
  toColumnSortKey,
  toSortKey,
  UNASSIGNED,
  type AgeBucketKey,
  type AmountBandKey,
  type PipelineApplication,
  type PipelineFilters,
  type SortKey,
} from "@/lib/applications/pipeline-view"

const BOARD_STATUSES: readonly string[] = PIPELINE_COLUMNS.map((c) => c.key)

/**
 * Filter state lives in the URL, not in component state.
 *
 * Three reasons, in order of how often they bite: a filtered view is then a
 * link you can send someone; switching between the board and the table cannot
 * silently drop what you filtered to, because both read the same place; and a
 * refresh after opening an application keeps the queue you were working.
 */
function useUrlState() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  const set = useCallback((changes: Record<string, string | null>) => {
    // Built from the LIVE query string, not from the `params` of the last
    // completed render. `router.replace` does not update `useSearchParams()`
    // synchronously, so two changes fired before the first navigation resolves
    // would both start from the same stale snapshot and the second would drop
    // the first.
    const live = typeof window === "undefined"
      ? (params?.toString() ?? "")
      : window.location.search
    const next = new URLSearchParams(live)
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === "") next.delete(key)
      else next.set(key, value)
    }
    const query = next.toString()
    // `replace`, not `push`: adjusting a filter should not stack history
    // entries that Back then has to walk through one at a time.
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [params, pathname, router])

  return { params, set }
}

export function ApplicationsWorkspace({
  applications,
  monthlyCount,
}: {
  applications: PipelineApplication[]
  monthlyCount?: number
}) {
  const { params, set } = useUrlState()
  // One clock for the whole render. Calling `new Date()` per card would let two
  // cards in the same paint disagree about what "2 days" means.
  const [now] = useState(() => new Date())

  const view = params?.get("view") === "table" ? "table" : "board"

  // The search box is the one control that fires per keystroke, and every URL
  // write re-runs the page's server component — which reads every application
  // and the whole refusal audit log. Typing five characters must not be five
  // database round-trips, so the input is local and settles into the URL.
  const urlSearch = params?.get("q") ?? ""
  const [searchDraft, setSearchDraft] = useState(urlSearch)
  const lastPushedSearch = useRef(urlSearch)

  // A search cleared from anywhere else — the Clear button, a link someone
  // sent — has to reach the input, which owns its own text. Adjusted during
  // render rather than in an effect: React re-renders before painting, so the
  // box never shows the stale text, and an effect here is a cascading render.
  if (urlSearch !== lastPushedSearch.current) {
    lastPushedSearch.current = urlSearch
    setSearchDraft(urlSearch)
  }

  // Filtering uses the DRAFT, so results move with the typing; only the URL
  // waits. A debounce that also delayed the rows would make the box feel broken.
  const filters: PipelineFilters = useMemo(() => ({
    search: searchDraft,
    product: params?.get("product") ?? ANY,
    branch: params?.get("branch") ?? ANY,
    assignee: params?.get("assignee") ?? ANY,
    amountBand: (params?.get("amount") as AmountBandKey) ?? "any",
    ageBucket: (params?.get("age") as AgeBucketKey) ?? "any",
    blocked: params?.get("blocked") ?? ANY,
    statuses: params?.get("status")?.split(",").filter(Boolean) ?? [],
    readyOnly: params?.get("ready") === "1",
  }), [params, searchDraft])

  const columnSort = useMemo(() => {
    const sort: Record<string, SortKey> = { ...DEFAULT_COLUMN_SORT }
    for (const col of PIPELINE_COLUMNS) {
      const fromUrl = params?.get(`sort_${col.key}`)
      if (fromUrl) {
        sort[col.key] = toColumnSortKey(fromUrl, col.key, DEFAULT_COLUMN_SORT[col.key] ?? "newest")
      }
    }
    return sort
  }, [params])

  const tableSort = toSortKey(params?.get("tsort"), "newest")

  // The board shows only the five pipeline lanes; the table shows whatever the
  // status filter says, defaulting to everything. Terminal applications are
  // therefore reachable — before this they were on no surface at all.
  const scope = view === "board"
    ? applications.filter((app) => BOARD_STATUSES.includes(app.status))
    : applications

  const visible = applyFilters(scope, filters, now)
  const active = filtersAreActive(filters)

  const closedCount = applications.filter(
    (app) => (CLOSED_STATUSES as readonly string[]).includes(app.status),
  ).length

  const products = distinctValues(applications, (a) => a.product.name)
  const branches = distinctValues(applications, (a) => a.branch?.name ?? null)
  const assignees = distinctValues(applications, (a) => a.assignedTo?.name ?? null)
  const blockReasons = presentBlockReasons(applications)

  useEffect(() => {
    if (searchDraft === lastPushedSearch.current) return
    const timer = setTimeout(() => {
      lastPushedSearch.current = searchDraft
      set({ q: searchDraft || null })
    }, 300)
    return () => clearTimeout(timer)
  }, [searchDraft, set])

  const clearFilters = () => set({
    q: null, product: null, branch: null, assignee: null,
    amount: null, age: null, blocked: null, status: null, ready: null,
  })

  const CLOSED_VALUE = CLOSED_STATUSES.join(",")

  const showClosed = () => set({ view: "table", status: CLOSED_VALUE })

  return (
    <div className="flex h-full min-h-0 flex-col gap-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">
            Origination Pipeline
          </p>
          <h1 className="text-2xl font-semibold text-[var(--cf-text)]">Loan Applications</h1>
          {active ? (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[var(--cf-text-muted)]">
              <span>{visible.length} of {scope.length} applications match</span>
              <button
                type="button"
                onClick={clearFilters}
                className="inline-flex items-center gap-1 text-[var(--cf-brand-soft)] hover:underline"
              >
                <X className="h-3 w-3" />
                Clear
              </button>
            </p>
          ) : (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[var(--cf-text-muted)]">
              <span>
                {scope.length} application{scope.length === 1 ? "" : "s"}
                {typeof monthlyCount === "number" ? ` · ${monthlyCount} new this month` : ""}
              </span>
              {view === "board" && closedCount > 0 ? (
                // The board has no lane for these. Without this they are not
                // reachable from this page at all.
                <button
                  type="button"
                  onClick={showClosed}
                  className="text-[var(--cf-brand-soft)] hover:underline"
                >
                  · {closedCount} closed
                </button>
              ) : null}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--cf-text-muted)]" />
            <input
              type="text"
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              aria-label="Search applications"
              placeholder="Search name, reference, product, amount…"
              className="h-10 w-56 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] pl-9 pr-8 text-sm text-[var(--cf-text-secondary)] outline-none transition-colors placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-border-strong)] focus:ring-2 focus:ring-[rgba(79,70,229,0.22)] sm:w-64"
            />
            {searchDraft && (
              <button
                type="button"
                onClick={() => setSearchDraft("")}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text-secondary)]"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <div className="inline-flex overflow-hidden rounded-md border border-[var(--cf-border-subtle)]">
            <ViewButton active={view === "board"} onClick={() => set({ view: null })} label="Board">
              <Columns3 className="h-4 w-4" />
            </ViewButton>
            <ViewButton active={view === "table"} onClick={() => set({ view: "table" })} label="Table">
              <LayoutGrid className="h-4 w-4" />
            </ViewButton>
          </div>

          <Button asChild>
            <Link href="/applications/new">
              <Plus className="h-4 w-4" />
              New Application
            </Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          value={filters.product}
          onChange={(v) => set({ product: v === ANY ? null : v })}
          options={[{ value: ANY, label: "All products" }, ...products.map((p) => ({ value: p, label: p }))]}
          label="Product"
        />
        <FilterSelect
          value={filters.branch}
          onChange={(v) => set({ branch: v === ANY ? null : v })}
          options={[
            { value: ANY, label: "All branches" },
            ...branches.map((b) => ({ value: b, label: b })),
            { value: UNASSIGNED, label: "No branch" },
          ]}
          label="Branch"
        />
        <FilterSelect
          value={filters.assignee}
          onChange={(v) => set({ assignee: v === ANY ? null : v })}
          options={[
            { value: ANY, label: "Anyone" },
            ...assignees.map((a) => ({ value: a, label: a })),
            { value: UNASSIGNED, label: "Unassigned" },
          ]}
          label="Assigned to"
        />
        <FilterSelect
          value={filters.amountBand}
          onChange={(v) => set({ amount: v === "any" ? null : v })}
          options={AMOUNT_BANDS.map((b) => ({ value: b.key, label: b.label }))}
          label="Amount"
        />
        <FilterSelect
          value={filters.ageBucket}
          onChange={(v) => set({ age: v === "any" ? null : v })}
          options={AGE_BUCKETS.map((b) => ({ value: b.key, label: b.label }))}
          label="Waiting"
        />
        {blockReasons.length > 0 ? (
          <FilterSelect
            value={filters.blocked}
            onChange={(v) => set({ blocked: v === ANY ? null : v })}
            options={[
              { value: ANY, label: "Any payout state" },
              { value: "blocked", label: "Blocked at payout" },
              ...blockReasons.map((r) => ({ value: r.reason, label: `${r.label} (${r.count})` })),
            ]}
            label="Payout"
          />
        ) : null}
        <label className="inline-flex items-center gap-2 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-2.5 py-1.5">
          <input
            type="checkbox"
            checked={filters.readyOnly}
            onChange={(e) => set({ ready: e.target.checked ? "1" : null })}
            className="h-3.5 w-3.5 accent-[var(--cf-brand-soft)]"
          />
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">
            Ready only
          </span>
        </label>
        {view === "table" ? (
          <FilterSelect
            // The joined value is an OPTION, not just a URL state. Rendering
            // the two closed statuses as `ANY` made the control read "All
            // statuses" immediately after the one link that sets it — the
            // select claiming no filter while a filter was applied.
            value={statusSelectValue(filters.statuses)}
            onChange={(v) => set({ status: v === ANY ? null : v })}
            options={[
              { value: ANY, label: "All statuses" },
              ...PIPELINE_COLUMNS.map((c) => ({ value: c.key, label: c.label })),
              { value: CLOSED_VALUE, label: "Closed (declined + cancelled)" },
              ...CLOSED_STATUSES.map((s) => ({ value: s, label: s === "DECLINED" ? "Declined" : "Cancelled" })),
            ]}
            label="Status"
          />
        ) : null}
      </div>

      {view === "board" ? (
        <ApplicationKanban
          applications={visible}
          columnSort={columnSort}
          onColumnSortChange={(status, key) => set({ [`sort_${status}`]: key })}
          isFiltered={active}
          now={now}
        />
      ) : (
        <ApplicationTable
          applications={visible}
          sort={tableSort}
          onSortChange={(key) => set({ tsort: key })}
          now={now}
        />
      )}
    </div>
  )
}

function ViewButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean
  onClick: () => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`${label} view`}
      className={`inline-flex h-10 items-center gap-1.5 px-3 text-sm transition-colors ${
        active
          ? "bg-[var(--cf-bg-raised)] text-[var(--cf-text)]"
          : "bg-[var(--cf-bg-subtle)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text-secondary)]"
      }`}
    >
      {children}
      {label}
    </button>
  )
}

function FilterSelect({
  value,
  onChange,
  options,
  label,
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  label: string
}) {
  // `optionsIncludingValue` keeps the control from displaying option[0] when
  // the persisted value is no longer in the data — see its comment.
  const rendered = optionsIncludingValue(value, options)

  return (
    <label className="inline-flex items-center gap-1.5 rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-subtle)] px-2.5 py-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        className="bg-transparent text-sm text-[var(--cf-text-secondary)] outline-none"
      >
        {rendered.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}
