"use client"

import { useEffect, useState } from "react"
import { Header } from "@/components/layout/Header"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatDateTime } from "@/lib/utils"
import { RefreshCw, PauseCircle, PlayCircle } from "lucide-react"
import { AutomationPausesTab, type Pause } from "@/components/settings/AutomationPausesTab"

interface Rule {
  id: string; name: string; description: string | null
  trigger: string; action: string; enabled: boolean; isBuiltIn: boolean
  createdAt: string
}

interface LogEntry {
  id: string; entityType: string; entityId: string; result: string; error: string | null
  createdAt: string; rule: { name: string; trigger: string; action: string }
  ruleId: string
}

const TRIGGER_LABELS: Record<string, string> = {
  LEAD_STALE: "Lead Stale",
  DPD_THRESHOLD: "DPD Threshold",
  PAYMENT_DUE: "Payment Due",
  LOAN_PAID_ON_TIME_N: "N On-Time Payments",
  LOAN_PAID_IN_FULL: "Loan Paid in Full",
}

const ACTION_LABELS: Record<string, string> = {
  CREATE_ACTIVITY: "Log Activity",
  CHANGE_COLLECTIONS_STAGE: "Change Stage",
  NOTIFY_AGENT: "Notify Agent",
  CREATE_OPPORTUNITY: "Create Opportunity",
  ISSUE_SECTION_129: "Issue Section 129 Task",
  CREATE_AGENT_TASK: "Create Agent Task",
}

const RESULT_COLORS: Record<string, string> = {
  success: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  skipped: "bg-gray-100 text-gray-700",
}

export default function AutomationPage() {
  const [rules, setRules] = useState<Rule[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [pauses, setPauses] = useState<Pause[]>([])
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)
  const [replaying, setReplaying] = useState<string | null>(null)
  const [pausing, setPausing] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    Promise.all([
      fetch("/api/automation/rules", { credentials: "include" }).then((r) => r.json()),
      fetch("/api/automation/logs?limit=50", { credentials: "include" }).then((r) => r.json()),
      fetch("/api/automation/pauses", { credentials: "include" }).then((r) => r.json()),
    ]).then(([r, l, p]) => {
      setRules(r as Rule[])
      setLogs(l as LogEntry[])
      setPauses(p as Pause[])
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [refreshKey])

  function refresh() { setRefreshKey((k) => k + 1) }

  async function toggleRule(id: string, enabled: boolean) {
    setToggling(id)
    const res = await fetch(`/api/automation/rules/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ enabled }),
    })
    if (res.ok) setRules((prev) => prev.map((r) => r.id === id ? { ...r, enabled } : r))
    setToggling(null)
  }

  async function replayLog(logId: string) {
    setReplaying(logId)
    await fetch(`/api/automation/logs/${logId}/replay`, { method: "POST", credentials: "include" })
    refresh()
    setReplaying(null)
  }

  async function pauseEntity(log: LogEntry) {
    setPausing(log.id)
    await fetch("/api/automation/pauses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ruleId: log.ruleId, entityType: log.entityType, entityId: log.entityId }),
    })
    refresh()
    setPausing(null)
  }

  async function resumeEntity(pauseId: string) {
    setPausing(pauseId)
    await fetch(`/api/automation/pauses/${pauseId}`, { method: "DELETE", credentials: "include" })
    refresh()
    setPausing(null)
  }

  function isPausedForLog(log: LogEntry): Pause | undefined {
    return pauses.find((p) => p.ruleId === log.ruleId && p.entityId === log.entityId)
  }

  return (
    <>
      <Header
        title="Automation"
        subtitle="Rules engine — configure automated actions"
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Automation" },
        ]}
      />
      <div className="p-4 lg:p-8 space-y-6">
        <Tabs defaultValue="rules">
          <TabsList>
            <TabsTrigger value="rules">Rules ({rules.length})</TabsTrigger>
            <TabsTrigger value="log">Recent Activity ({logs.length})</TabsTrigger>
            <TabsTrigger value="pauses">Pauses ({pauses.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="rules">
            <div className="bg-white rounded-lg shadow-sm">
              {loading ? (
                <div className="p-8 text-center text-gray-400">Loading…</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rule</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead className="text-right">Enabled</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rules.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <p className="font-medium text-gray-900">{rule.name}</p>
                          {rule.description && <p className="text-xs text-gray-500 mt-0.5">{rule.description}</p>}
                        </TableCell>
                        <TableCell>
                          <Badge className="bg-blue-100 text-blue-800">{TRIGGER_LABELS[rule.trigger] ?? rule.trigger}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge className="bg-purple-100 text-purple-800">{ACTION_LABELS[rule.action] ?? rule.action}</Badge>
                        </TableCell>
                        <TableCell>
                          {rule.isBuiltIn
                            ? <span className="text-xs text-gray-400">Built-in</span>
                            : <span className="text-xs text-blue-500">Custom</span>}
                        </TableCell>
                        <TableCell className="text-right">
                          <Switch
                            checked={rule.enabled}
                            disabled={toggling === rule.id}
                            onCheckedChange={(v: boolean) => toggleRule(rule.id, v)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-3">
              Built-in rules are seeded automatically. Disable to pause. The engine has no schedule: it runs only when the automation-engine cron endpoint is called. WhatsApp reminders are sent by the borrower reminder crons, not by rules.
            </p>
          </TabsContent>

          <TabsContent value="log">
            <div className="bg-white rounded-lg shadow-sm">
              {loading ? (
                <div className="p-8 text-center text-gray-400">Loading…</div>
              ) : logs.length === 0 ? (
                <div className="p-8 text-center text-gray-500">No automation activity yet. Run the engine cron to see results here.</div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rule</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>Result</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {logs.map((log) => {
                      const existingPause = isPausedForLog(log)
                      return (
                        <TableRow key={log.id}>
                          <TableCell>
                            <p className="font-medium text-sm">{log.rule.name}</p>
                            <p className="text-xs text-gray-400">{log.rule.trigger} → {log.rule.action}</p>
                          </TableCell>
                          <TableCell className="text-sm">
                            <span className="text-gray-500">{log.entityType}/</span>
                            <span className="font-mono text-xs">{log.entityId.slice(-8)}</span>
                          </TableCell>
                          <TableCell>
                            <Badge className={RESULT_COLORS[log.result] ?? "bg-gray-100 text-gray-700"}>{log.result}</Badge>
                            {log.error && log.error !== "paused" && (
                              <p className="text-xs text-red-600 mt-1 max-w-xs truncate">{log.error}</p>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-gray-400">{formatDateTime(log.createdAt)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              {log.result === "failed" && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-blue-600 hover:text-blue-800"
                                  disabled={replaying === log.id}
                                  onClick={() => replayLog(log.id)}
                                  title="Replay this failed automation"
                                >
                                  <RefreshCw className="h-3 w-3 mr-1" />
                                  {replaying === log.id ? "…" : "Replay"}
                                </Button>
                              )}
                              {existingPause ? (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-green-600 hover:text-green-800"
                                  disabled={pausing === existingPause.id}
                                  onClick={() => resumeEntity(existingPause.id)}
                                  title="Resume automation for this entity"
                                >
                                  <PlayCircle className="h-3 w-3 mr-1" />
                                  Resume
                                </Button>
                              ) : (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 px-2 text-xs text-amber-600 hover:text-amber-800"
                                  disabled={pausing === log.id}
                                  onClick={() => pauseEntity(log)}
                                  title="Pause this rule for this entity"
                                >
                                  <PauseCircle className="h-3 w-3 mr-1" />
                                  Pause
                                </Button>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>

          <TabsContent value="pauses">
            <div className="bg-white rounded-lg shadow-sm">
              <AutomationPausesTab
                pauses={pauses}
                loading={loading}
                pausingId={pausing}
                onResume={resumeEntity}
              />
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
