"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ChangeRequestsPanel } from "@/components/settings/decision-rules/ChangeRequestsPanel"
import { describeRepayment, pct, rand } from "./labels"
import { PricingRuleForm } from "./PricingRuleForm"
import { VersionForm } from "./VersionForm"
import { api, type EngineOverview, type ProductRow, type RuleRow } from "./types"

const STATUS = { IN_EFFECT: ["In effect", "success"], SCHEDULED: ["Scheduled", "warning"], SUPERSEDED: ["Superseded", "neutral"] } as const

function ruleConditions(r: RuleRow, products: ProductRow[]): string {
  const parts = [
    r.productId ? `product ${products.find((p) => p.id === r.productId)?.code ?? "?"}` : "every product", r.segment && `segment ${r.segment}`, r.channel && `channel ${r.channel}`,
    r.riskRankMin !== null && `grade rank ${r.riskRankMin}${r.riskRankMax !== r.riskRankMin ? ` to ${r.riskRankMax}` : ""}`, r.campaignCode && `campaign ${r.campaignCode}`,
  ].filter(Boolean)
  return parts.join(" · ")
}

/** Product versions with effective dates, pricing rules and their approvals: every change needs a second person. */
export function ProductVersionsWorkspace({ overview }: { overview: EngineOverview }) {
  const router = useRouter()
  const [tab, setTab] = useState("versions")
  const [proposing, setProposing] = useState<ProductRow | null>(null)
  const [newRule, setNewRule] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const refresh = () => router.refresh()
  const waiting = overview.requests.filter((r) => r.status === "SUBMITTED" || (r.status === "DRAFT" && r.mine)).length

  async function retire(rule: RuleRow) {
    setError(null)
    const created = await api<{ request: { id: string } }>("/api/maker-checker", "POST", { kind: "PRODUCT_PRICING_RULE", title: `Retire pricing rule: ${rule.name}`, payload: { action: "RETIRE", ruleId: rule.id } })
    const submitted = created.ok && created.data ? await api(`/api/maker-checker/${created.data.request.id}/submit`, "POST", {}) : created
    if (!submitted.ok) setError(submitted.problems.join(" ") || submitted.error || "Could not propose the retirement.")
    else refresh()
  }

  if (proposing) return <VersionForm overview={overview} product={proposing} onCancel={() => setProposing(null)} onDone={refresh} />
  if (newRule) return <PricingRuleForm overview={overview} onCancel={() => setNewRule(false)} onDone={refresh} />

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="versions">Versions</TabsTrigger>
        <TabsTrigger value="pricing">Pricing rules</TabsTrigger>
        <TabsTrigger value="approvals">Approvals{waiting > 0 ? ` (${waiting})` : ""}</TabsTrigger>
      </TabsList>

      <TabsContent value="versions" className="space-y-4">
        {overview.products.length === 0 && <p className="text-sm text-[var(--cf-text-muted)]">No lending products yet.</p>}
        {overview.products.map((product) => {
          const versions = overview.versions.filter((v) => v.productId === product.id)
          return (
            <Card key={product.id}>
              <CardHeader>
                <CardTitle>{product.name} <span className="text-sm font-normal text-[var(--cf-text-muted)]">({product.code})</span></CardTitle>
                <CardDescription>
                  Now: {pct(product.interestRatePm)} a month, {rand(product.minAmount)} to {rand(product.maxAmount)}, {product.minTermDays} to {product.maxTermDays} days
                  {versions.length === 0 ? ". No versions yet: the product runs as configured, and a loan keeps no version." : `. ${versions.length} version${versions.length === 1 ? "" : "s"}.`}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {versions.length > 0 && (
                  <table className="w-full text-sm">
                    <thead><tr className="text-left text-xs text-[var(--cf-text-muted)]"><th className="py-1">Version</th><th>From</th><th>Rate</th><th>Repayment</th><th>Status</th></tr></thead>
                    <tbody>
                      {versions.map((v) => (
                        <tr key={v.id} className="border-t border-[var(--cf-border-subtle)] align-top">
                          <td className="py-2">v{v.version}</td><td>{v.effectiveFrom}</td><td>{pct(v.config.interestRatePm)} a month</td>
                          <td>{describeRepayment(v.config.repayment, v.config.interestModel)}<br /><span className="text-xs text-[var(--cf-text-muted)]">{v.reason}</span></td>
                          <td><Badge variant={STATUS[v.status][1]}>{STATUS[v.status][0]}</Badge></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {overview.canManage && <Button size="sm" onClick={() => setProposing(product)}>Propose a new version</Button>}
              </CardContent>
            </Card>
          )
        })}
      </TabsContent>

      <TabsContent value="pricing" className="space-y-4">
        {overview.canManage && <Button onClick={() => setNewRule(true)}>New pricing rule</Button>}
        {error && <p role="alert" className="text-sm text-[var(--cf-danger)]">{error}</p>}
        <Card>
          <CardHeader><CardTitle>Pricing rules</CardTitle><CardDescription>By customer segment, risk grade, channel and campaign. One rule prices an application: the most specific that matches.</CardDescription></CardHeader>
          <CardContent className="space-y-2">
            {overview.rules.length === 0 && <p className="text-sm text-[var(--cf-text-muted)]">No pricing rules: every application is priced at its product&apos;s rate.</p>}
            {overview.rules.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-[var(--cf-border-subtle)] p-3 text-sm">
                <Badge variant={r.retired ? "neutral" : "success"}>{r.retired ? "Retired" : "Active"}</Badge>
                <span className="font-medium">{r.name}</span>
                <span>{r.rate.mode === "SET" ? `rate ${pct(r.rate.value)}` : `${r.rate.value >= 0 ? "+" : ""}${pct(r.rate.value)}`} a month{r.initiationFeePct !== null ? `, fee ${pct(r.initiationFeePct)}` : ""}</span>
                <span className="text-[var(--cf-text-muted)]">{ruleConditions(r, overview.products)} · priority {r.priority} · {r.validFrom}{r.validTo ? ` to ${r.validTo}` : " onwards"}</span>
                {overview.canManage && !r.retired && <Button size="sm" variant="ghost" onClick={() => retire(r)}>Retire</Button>}
              </div>
            ))}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="approvals">
        <ChangeRequestsPanel requests={overview.requests} onDone={refresh} onEdit={() => undefined} description="Every product version and pricing rule needs a second person's approval. You cannot approve what you drafted." />
      </TabsContent>
    </Tabs>
  )
}
