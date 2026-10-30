"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { RuleDef } from "@/lib/decisioning/types"
import { ChangeRequestsPanel } from "./ChangeRequestsPanel"
import { EngineSettings } from "./EngineSettings"
import { RuleSetEditor } from "./RuleSetEditor"
import { ActivityCard, RuleSetList } from "./RuleSetList"
import type { ChangeRow, Overview, RuleSetPayload } from "./types"

const today = () => new Date().toISOString().slice(0, 10)
const blank = (): RuleSetPayload => ({
  productId: null, name: "New rule set", effectiveFrom: today(), challengerOnly: false, scorecard: null,
  rules: [{ id: "rule-1", name: "Rule 1", outcome: "REFER", reasonCode: "RULE_1", when: { all: [{ field: "bureauScore", op: "lt", value: 0 }] } } satisfies RuleDef],
})

interface Editing {
  initial: RuleSetPayload
  request?: ChangeRow
}

/** The decision-rules settings: rule sets with a form-based builder, engine settings, approvals and activity. */
export function DecisionRulesWorkspace({ overview }: { overview: Overview }) {
  const router = useRouter()
  const [editing, setEditing] = useState<Editing | null>(null)
  const [tab, setTab] = useState("rules")
  const refresh = () => router.refresh()
  const waiting = overview.requests.filter((r) => r.status === "SUBMITTED" || r.status === "DRAFT").length

  if (editing) {
    return <RuleSetEditor overview={overview} initial={editing.initial} request={editing.request} onCancel={() => setEditing(null)} onDone={() => { refresh() }} />
  }
  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <TabsList>
        <TabsTrigger value="rules">Rule sets</TabsTrigger>
        <TabsTrigger value="engine">Engine</TabsTrigger>
        <TabsTrigger value="approvals">Approvals{waiting > 0 ? ` (${waiting})` : ""}</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
      </TabsList>
      <TabsContent value="rules" className="space-y-4">
        {overview.canManage && <Button onClick={() => setEditing({ initial: blank() })}>New rule set</Button>}
        <RuleSetList overview={overview} onUse={(initial) => setEditing({ initial })} />
      </TabsContent>
      <TabsContent value="engine"><EngineSettings overview={overview} onDone={refresh} /></TabsContent>
      <TabsContent value="approvals">
        <ChangeRequestsPanel
          requests={overview.requests}
          onDone={refresh}
          onEdit={(row) => setEditing({ initial: row.payload as RuleSetPayload, request: row })}
        />
      </TabsContent>
      <TabsContent value="activity"><ActivityCard stats={overview.stats} /></TabsContent>
    </Tabs>
  )
}
