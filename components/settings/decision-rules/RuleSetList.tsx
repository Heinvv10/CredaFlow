"use client"

import Link from "next/link"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { describeNode } from "./describe"
import { SimulationPanel } from "./SimulationPanel"
import type { Overview, RuleSetPayload, VersionRow } from "./types"

const today = () => new Date().toISOString().slice(0, 10)

export function payloadFrom(version: VersionRow): RuleSetPayload {
  return {
    productId: version.productId, name: version.name, effectiveFrom: today(),
    challengerOnly: version.challengerOnly, rules: structuredClone(version.rules), scorecard: structuredClone(version.scorecard),
  }
}

function VersionCard({ version, overview, onUse }: { version: VersionRow; overview: Overview; onUse: (p: RuleSetPayload) => void }) {
  const [open, setOpen] = useState(false)
  const isChallenger = overview.config.challengerVersionId === version.id
  return (
    <div className="space-y-2 rounded-lg border border-[var(--cf-border-subtle)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{version.name}</span>
        <Badge variant="outline">v{version.version}</Badge>
        {version.challengerOnly && <Badge variant="info">challenger only</Badge>}
        {isChallenger && <Badge variant="warning">current challenger ({overview.config.challengerPercent}%)</Badge>}
        <span className="text-xs text-[var(--cf-text-muted)]">effective {version.effectiveFrom} · {version.rules.length} rule{version.rules.length === 1 ? "" : "s"}{version.scorecard ? ` · scorecard, grades ${version.scorecard.bands.map((b) => b.grade).join("/")}` : ""}</span>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Hide rules" : "Show rules"}</Button>
        {overview.canManage && <Button size="sm" variant="outline" onClick={() => onUse(payloadFrom(version))}>New version from this</Button>}
      </div>
      {open && (
        <div className="space-y-3 text-sm">
          <ol className="list-decimal space-y-1 pl-5">
            {version.rules.map((r) => (
              <li key={r.id}><strong>{r.name}</strong> ({r.reasonCode}): {r.outcome === "KNOCK_OUT" ? "decline" : r.outcome === "REFER" ? "refer" : `cap at ${r.limitCapCents} cents`} when {describeNode(r.when, overview.facts)}</li>
            ))}
          </ol>
          {version.scorecard && (
            <p>Scorecard: base {version.scorecard.baseScore}; {version.scorecard.characteristics.map((c) => overview.facts.find((f) => f.name === c.field)?.label ?? c.field).join(", ")}; bands {version.scorecard.bands.map((b) => `${b.grade} from ${b.minScore} (${b.action.toLowerCase()}${b.pricingTier ? `, ${b.pricingTier}` : ""})`).join("; ")}.</p>
          )}
          {overview.canManage && <SimulationPanel source={{ versionId: version.id }} label="Simulate this version" />}
        </div>
      )}
    </div>
  )
}

/** The approved versions, newest first within each scope. Versions never change: a new one is drafted from an old one. */
export function RuleSetList({ overview, onUse }: { overview: Overview; onUse: (p: RuleSetPayload) => void }) {
  const scopes = [...new Set(overview.versions.map((v) => v.scopeKey))]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Approved rule sets</CardTitle>
        <CardDescription>The highest version already in effect decides for its product; a product&apos;s own set outranks the all-products set.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {scopes.length === 0 && <p className="text-sm text-[var(--cf-text-muted)]">No rule set has been approved yet.</p>}
        {scopes.map((scope) => (
          <section key={scope} className="space-y-2" aria-label={scope === "ALL" ? "All products" : "Product rule sets"}>
            <h3 className="text-sm font-semibold">{scope === "ALL" ? "All products" : (overview.products.find((p) => p.id === scope)?.name ?? scope)}</h3>
            {overview.versions.filter((v) => v.scopeKey === scope).map((v) => <VersionCard key={v.id} version={v} overview={overview} onUse={onUse} />)}
          </section>
        ))}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return <div><dt className="text-xs uppercase text-[var(--cf-text-muted)]">{label}</dt><dd className="text-lg font-semibold">{value}</dd></div>
}

/** What the engine did over the last 30 days, and how quickly. */
export function ActivityCard({ stats }: { stats: Overview["stats"] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity, last {stats.sinceDays} days</CardTitle>
        <CardDescription>Every run is recorded with the version that decided; the decision latency target is under 60 seconds. <Link className="underline" href="/applications/automated-decisions">Automated declines to review</Link></CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Runs" value={stats.total} />
          <Stat label="Approved" value={stats.byExecution.APPROVED ?? 0} />
          <Stat label="Declined" value={stats.byExecution.DECLINED ?? 0} />
          <Stat label="Referred to staff" value={stats.byExecution.REFERRED ?? 0} />
          <Stat label="Shadow (no action)" value={stats.byExecution.NOT_ACTED ?? 0} />
          <Stat label="By challenger" value={stats.byRole.CHALLENGER ?? 0} />
          <Stat label="Latency avg / p95 (ms)" value={stats.latencyMs ? `${stats.latencyMs.avg} / ${stats.latencyMs.p95}` : "—"} />
          <Stat label="Slowest (ms)" value={stats.latencyMs?.max ?? "—"} />
          <Stat label="Submission to decision avg / p95 (ms)" value={stats.submissionLatencyMs ? `${stats.submissionLatencyMs.avg} / ${stats.submissionLatencyMs.p95}` : "—"} />
        </dl>
      </CardContent>
    </Card>
  )
}
