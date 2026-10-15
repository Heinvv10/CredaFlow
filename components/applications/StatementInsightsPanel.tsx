"use client"

import { useEffect, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { isLiving, LIVING_CATEGORIES, MONTH_DAYS, type Category } from "@/lib/statement-analysis/categories"
import type { Insights } from "@/lib/statement-analysis/insights"
import { formatCents } from "@/lib/statement-analysis/money"

type Payload = Insights & { unreadStatements: number; modelLabelsEnabled?: boolean }

const LABEL: Record<Category, string> = {
  HOUSING: "Housing", TRANSPORT: "Transport", FOOD: "Food", EDUCATION: "Education", INSURANCE: "Insurance", CLOTHING: "Clothing",
  ENTERTAINMENT: "Entertainment", MEDICAL: "Medical", UTILITIES_TELECOM: "Utilities & telecom", SALARY_INCOME: "Salary",
  OTHER_INCOME: "Other income", TRANSFER_OWN: "Own transfers", SAVINGS_INVESTMENT: "Savings & investment", CASH_WITHDRAWAL: "Cash",
  CREDIT_INSTALMENT: "Credit instalments", GAMBLING: "Gambling", RETURNED_DEBIT: "Returned debits", BANK_FEES: "Bank fees",
  UNCATEGORISED: "Uncategorised",
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-md border border-[var(--cf-border-subtle)] p-3">
      <p className="text-xs text-[var(--cf-text-muted)]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[var(--cf-text)]">{value}</p>
      {note && <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">{note}</p>}
    </div>
  )
}

function Amounts({ title, rows }: { title: string; rows: Array<[string, number]> }) {
  if (rows.length === 0) return null
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">{title}</h3>
      <table className="mt-2 w-full text-xs">
        <tbody>
          {rows.map(([label, cents]) => (
            <tr key={label} className="border-t border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)]">
              <td className="py-1 pr-3">{label}</td>
              <td className="py-1 text-right whitespace-nowrap">{formatCents(cents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Living({ data }: { data: Payload }) {
  const { living, declaredCents, gapCents } = data
  const byCategory = LIVING_CATEGORIES.filter((c) => living.byCategoryMonthlyCents[c]).map((c): [string, number] => [LABEL[c], living.byCategoryMonthlyCents[c]!])
  const excluded = (Object.entries(living.excludedMonthlyCents) as Array<[Category, number]>).map(([c, v]): [string, number] => [LABEL[c], v])
  return (
    <div className="mt-4 space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Figure label="Living spend a month" value={formatCents(living.monthlyCents)} />
        <Figure label="Declared expenses a month" value={declaredCents === null ? "Not captured" : formatCents(declaredCents)} />
        <Figure label="Statement above declared" value={gapCents === null ? "—" : formatCents(gapCents)} />
      </div>
      {!data.enoughCoverage && (
        <p className="text-xs text-[var(--cf-text-muted)]">
          Under four weeks of reconciling statements: living spend is not compared with the declaration.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Amounts title="Living spend by category, a month" rows={byCategory} />
        <Amounts title="Not counted as living spend, a month" rows={excluded} />
      </div>
    </div>
  )
}

/** Rows the local model categorised (no rule did): totals, and the rows for the officer to check. */
function ModelAssigned({ data, used }: { data: Payload; used: Payload["statements"] }) {
  const m = data.modelAssigned
  const enabled = data.modelLabelsEnabled !== false
  const unlabelled = enabled ? used.filter((s) => !s.modelLabelled).length : 0
  const noModel = !enabled && (data.uncategorisedShare ?? 0) > 0
  if (m.rowCount === 0 && unlabelled === 0 && !noModel) return null
  return (
    <div data-testid="statement-model-assigned" className="mt-4 rounded-md border border-[var(--cf-border-subtle)] p-3 text-xs text-[var(--cf-text-secondary)]">
      {m.rowCount > 0 && (
        <details>
          <summary className="cursor-pointer">
            <span className="font-semibold text-[var(--cf-text)]">Model-assigned: </span>
            {m.rowCount} row{m.rowCount === 1 ? "" : "s"} ({formatCents(m.debitCents)} out, about {formatCents(m.livingMonthlyCents)} a month of the living spend)
            were categorised by the local model, not a rule. Check them.
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full" aria-label="Model-assigned rows">
              <thead>
                <tr className="text-left text-[var(--cf-text-muted)]">
                  <th scope="col" className="py-1 pr-3 font-medium">Date</th>
                  <th scope="col" className="py-1 pr-3 font-medium">Description</th>
                  <th scope="col" className="py-1 pr-3 text-right font-medium">Out</th>
                  <th scope="col" className="py-1 font-medium">Category</th>
                </tr>
              </thead>
              <tbody>
                {m.rows.map((r, i) => (
                  <tr key={`${r.documentId}-${r.date}-${i}`} className="border-t border-[var(--cf-border-subtle)]">
                    <td className="py-1 pr-3 whitespace-nowrap">{r.date}</td>
                    <td className="py-1 pr-3 break-all">{r.description}</td>
                    <td className="py-1 pr-3 text-right whitespace-nowrap">{formatCents(-r.amountCents)}</td>
                    <td className="py-1 whitespace-nowrap">{LABEL[r.category]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {m.rowCount > m.rows.length && <p className="mt-1">First {m.rows.length} of {m.rowCount} rows; the export lists them all.</p>}
          </div>
        </details>
      )}
      {unlabelled > 0 && (
        <p className={m.rowCount > 0 ? "mt-2" : ""}>
          The model has not labelled {unlabelled} statement{unlabelled === 1 ? "" : "s"} (it was unavailable or has not run yet):
          rows no rule categorises stay uncategorised and are not counted as living spend.
        </p>
      )}
      {noModel && <p>No local model is configured: rows no rule categorises stay uncategorised and are not counted as living spend.</p>}
    </div>
  )
}

function Months({ data }: { data: Payload }) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[var(--cf-text-muted)]">
            <th className="py-1 pr-3 font-medium">Month</th>
            <th className="py-1 pr-3 text-right font-medium">Money in</th>
            <th className="py-1 pr-3 text-right font-medium">Money out</th>
            <th className="py-1 pr-3 text-right font-medium">Living spend</th>
            <th className="py-1 pr-3 text-right font-medium">Uncategorised</th>
            <th className="py-1 text-right font-medium">Salary credits</th>
          </tr>
        </thead>
        <tbody>
          {data.months.map((m) => (
            <tr key={m.month} className="border-t border-[var(--cf-border-subtle)] text-[var(--cf-text-secondary)]">
              <td className="py-1 pr-3">{m.month}</td>
              <td className="py-1 pr-3 text-right whitespace-nowrap">{formatCents(m.inCents)}</td>
              <td className="py-1 pr-3 text-right whitespace-nowrap">{formatCents(m.outCents)}</td>
              <td className="py-1 pr-3 text-right whitespace-nowrap">
                {formatCents(Object.entries(m.byCategory).reduce((s, [c, v]) => s + (isLiving(c as Category) ? v ?? 0 : 0), 0))}
              </td>
              <td className="py-1 pr-3 text-right whitespace-nowrap">{formatCents(m.byCategory.UNCATEGORISED ?? 0)}</td>
              <td className="py-1 text-right">{m.salaryCredits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function StatementInsightsPanel({ applicationId }: { applicationId: string }) {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    fetch(`/api/applications/${applicationId}/statement-insights`, { cache: "no-store" })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null)
        if (!live) return
        if (res.ok) setData(body as Payload)
        else setError("Could not load statement insights.")
      })
      .catch(() => live && setError("Network error. Could not load statement insights."))
    return () => { live = false }
  }, [applicationId])

  const used = data?.statements.filter((s) => s.used) ?? []
  const lowest = used.map((s) => s.lowestBalanceCents).filter((v): v is number => v !== null)
  const months = data ? data.coverageDays / MONTH_DAYS : 0
  // Per month of coverage, as the server averages living spend.
  const perMonth = (key: "inCents" | "outCents") => (data && months > 0 ? Math.round(data.months.reduce((s, m) => s + m[key], 0) / months) : 0)

  return (
    <section data-testid="statement-insights-panel" className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[var(--cf-text)]">Statement insights</h2>
          <Badge variant="secondary">From statement — estimate</Badge>
        </div>
        <a
          href={`/api/applications/${applicationId}/statement-export`}
          className="rounded-md border border-[var(--cf-border-subtle)] px-3 py-1.5 text-xs font-medium text-[var(--cf-brand)] hover:bg-[var(--cf-surface)]"
        >
          Export to Excel
        </a>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-[var(--cf-danger)]">{error}</p>}
      {!error && !data && <p role="status" className="mt-3 text-sm text-[var(--cf-text-muted)]">Loading statement insights...</p>}
      {data && used.length === 0 && (
        <p className="mt-3 text-sm text-[var(--cf-text-muted)]">
          No statement that reconciles has been read yet{data.unreadStatements ? ` (${data.unreadStatements} not read)` : ""}.
        </p>
      )}
      {data && used.length > 0 && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Figure label="Months covered" value={months.toFixed(1)} note={`${data.coverageDays} days, ${used.length} statement${used.length === 1 ? "" : "s"}`} />
            <Figure label="Money in a month" value={formatCents(perMonth("inCents"))} />
            <Figure label="Money out a month" value={formatCents(perMonth("outCents"))} />
            <Figure label="Lowest end-of-day balance" value={lowest.length ? formatCents(Math.min(...lowest)) : "—"} />
            <Figure
              label="Salary credits"
              value={`${data.salary.payDays.length} month${data.salary.payDays.length === 1 ? "" : "s"}`}
              note={data.salary.daySpread === null ? "None found" : `Paid within ${data.salary.daySpread} days of each other`}
            />
            <Figure label="Uncategorised spend" value={data.uncategorisedShare === null ? "—" : `${Math.round(data.uncategorisedShare * 100)}%`} />
          </div>
          <Living data={data} />
          <ModelAssigned data={data} used={used} />
          <Months data={data} />
          {data.statements.length > used.length && (
            <p className="mt-3 text-xs text-[var(--cf-text-muted)]">
              {data.statements.length - used.length} read statement(s) do not reconcile and are left out of these figures.
            </p>
          )}
          <p className="mt-3 text-xs text-[var(--cf-text-muted)]">Categories by {data.categoriserVersion}; they never change the affordability figure.</p>
        </>
      )}
    </section>
  )
}
