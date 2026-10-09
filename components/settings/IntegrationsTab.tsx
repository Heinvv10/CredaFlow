"use client"

import { useState, useEffect, useCallback } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { ExperianStatusCard } from "@/components/settings/ExperianStatusCard"
import { SAST_TIME_ZONE } from "@/lib/utils"
import {
  integrationTestResultMessage,
  notificationLogDisplayStatus,
} from "@/lib/integrations/simulation-presentation"

interface IntegrationConfig {
  bulkSmsKey: string
  netcashKey: string
  transunionKey: string
  smileIdentityKey: string
  netcashDebitOrderKey: string
  netcashRiskReportsKey: string
  bulkSmsConfigured: boolean
  netcashConfigured: boolean
  transunionConfigured: boolean
  smileIdentityConfigured: boolean
  netcashDebitOrderConfigured: boolean
  netcashRiskReportsConfigured: boolean
  collectionsEngineEnabled: boolean
  collectionProvider: string | null
  experianConfigured: boolean
  experianEnv: string
}

interface LogEntry {
  id: string
  event: string
  channel: string
  status: string
  error: string | null
  createdAt: string
}

export function IntegrationsTab() {
  const [config, setConfig] = useState<IntegrationConfig | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [form, setForm] = useState({
    bulkSmsKey: "",
    netcashKey: "",
    transunionKey: "",
    smileIdentityKey: "",
  })
  const [collectionsForm, setCollectionsForm] = useState({
    collectionProvider: "",
    collectionsEngineEnabled: false,
    netcashDebitOrderKey: "",
    netcashRiskReportsKey: "",
  })
  const [savingCollections, setSavingCollections] = useState(false)

  const loadConfig = useCallback(async () => {
    const res = await fetch("/api/settings/integrations")
    if (res.ok) {
      const data = await res.json()
      setConfig(data)
      setCollectionsForm((prev) => ({
        ...prev,
        collectionProvider: data.collectionProvider ?? "",
        collectionsEngineEnabled: data.collectionsEngineEnabled ?? false,
      }))
    }
  }, [])

  const loadLogs = useCallback(async () => {
    const res = await fetch("/api/settings/integrations?logs=true")
    if (res.ok) {
      const data = await res.json()
      if (data.logs) setLogs(data.logs)
    }
  }, [])

  useEffect(() => { loadConfig(); loadLogs() }, [loadConfig, loadLogs])

  async function handleSave(field: keyof typeof form) {
    if (!form[field]) return
    setSaving(true)
    try {
      const res = await fetch("/api/settings/integrations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: form[field] }),
      })
      if (res.ok) {
        setForm((prev) => ({ ...prev, [field]: "" }))
        await loadConfig()
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleSaveCollections() {
    setSavingCollections(true)
    try {
      const body: Record<string, string | boolean | null> = {
        collectionProvider: collectionsForm.collectionProvider || null,
        collectionsEngineEnabled: collectionsForm.collectionsEngineEnabled,
      }
      if (collectionsForm.netcashDebitOrderKey) body.netcashDebitOrderKey = collectionsForm.netcashDebitOrderKey
      if (collectionsForm.netcashRiskReportsKey) body.netcashRiskReportsKey = collectionsForm.netcashRiskReportsKey

      const res = await fetch("/api/settings/integrations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        setCollectionsForm((prev) => ({ ...prev, netcashDebitOrderKey: "", netcashRiskReportsKey: "" }))
        await loadConfig()
      }
    } finally {
      setSavingCollections(false)
    }
  }

  async function handleTest(provider: string) {
    setTesting(provider)
    setTestResult(null)
    try {
      const res = await fetch("/api/settings/integrations/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      })
      const data = await res.json()
      setTestResult(integrationTestResultMessage(data))
    } catch {
      setTestResult("Test request failed")
    } finally {
      setTesting(null)
    }
  }

  return (
    <div className="space-y-6">
      <Tabs defaultValue="bulksms">
        <TabsList>
          <TabsTrigger value="bulksms">BulkSMS</TabsTrigger>
          <TabsTrigger value="netcash">Netcash</TabsTrigger>
          <TabsTrigger value="transunion">TransUnion</TabsTrigger>
          <TabsTrigger value="smileidentity">Smile Identity</TabsTrigger>
          <TabsTrigger value="collections">Collections</TabsTrigger>
        </TabsList>

        <TabsContent value="bulksms">
          <IntegrationCard
            title="BulkSMS"
            description="SMS and WhatsApp messaging via BulkSMS API"
            configured={config?.bulkSmsConfigured ?? false}
            maskedKey={config?.bulkSmsKey ?? ""}
            fieldLabel="API Credentials (username:password)"
            fieldValue={form.bulkSmsKey}
            onFieldChange={(v) => setForm((p) => ({ ...p, bulkSmsKey: v }))}
            onSave={() => handleSave("bulkSmsKey")}
            onTest={() => handleTest("bulksms")}
            saving={saving}
            testing={testing === "bulksms"}
            testResult={testing === null && testResult ? testResult : null}
          />
        </TabsContent>

        <TabsContent value="netcash">
          <IntegrationCard
            title="Netcash"
            description="EFT disbursements via Netcash payment gateway"
            configured={config?.netcashConfigured ?? false}
            maskedKey={config?.netcashKey ?? ""}
            fieldLabel="Service Key"
            fieldValue={form.netcashKey}
            onFieldChange={(v) => setForm((p) => ({ ...p, netcashKey: v }))}
            onSave={() => handleSave("netcashKey")}
            onTest={() => handleTest("netcash")}
            saving={saving}
            testing={testing === "netcash"}
            testResult={testing === null && testResult ? testResult : null}
          />
        </TabsContent>

        <TabsContent value="transunion">
          <IntegrationCard
            title="TransUnion"
            description="Credit bureau checks via TransUnion REST API"
            configured={config?.transunionConfigured ?? false}
            maskedKey={config?.transunionKey ?? ""}
            fieldLabel="Credentials (clientId:clientSecret)"
            fieldValue={form.transunionKey}
            onFieldChange={(v) => setForm((p) => ({ ...p, transunionKey: v }))}
            onSave={() => handleSave("transunionKey")}
            onTest={() => handleTest("transunion")}
            saving={saving}
            testing={testing === "transunion"}
            testResult={testing === null && testResult ? testResult : null}
          />
        </TabsContent>

        <TabsContent value="smileidentity">
          <IntegrationCard
            title="Smile Identity"
            description="SA ID verification via Smile Identity (env-based config)"
            configured={config?.smileIdentityConfigured ?? false}
            maskedKey={config?.smileIdentityKey ?? ""}
            fieldLabel="API Key (optional — use env vars SMILE_IDENTITY_API_KEY)"
            fieldValue={form.smileIdentityKey}
            onFieldChange={(v) => setForm((p) => ({ ...p, smileIdentityKey: v }))}
            onSave={() => handleSave("smileIdentityKey")}
            onTest={() => handleTest("smileidentity")}
            saving={saving}
            testing={testing === "smileidentity"}
            testResult={testing === null && testResult ? testResult : null}
          />
        </TabsContent>

        <TabsContent value="collections">
          <CollectionsCard
            configured={!!config?.collectionProvider && (config?.netcashRiskReportsConfigured ?? false)}
            collectionProvider={collectionsForm.collectionProvider}
            onProviderChange={(v) => setCollectionsForm((p) => ({ ...p, collectionProvider: v }))}
            collectionsEngineEnabled={collectionsForm.collectionsEngineEnabled}
            onEngineEnabledChange={(v) => setCollectionsForm((p) => ({ ...p, collectionsEngineEnabled: v }))}
            debitOrderKeyConfigured={config?.netcashDebitOrderConfigured ?? false}
            maskedDebitOrderKey={config?.netcashDebitOrderKey ?? ""}
            debitOrderKeyValue={collectionsForm.netcashDebitOrderKey}
            onDebitOrderKeyChange={(v) => setCollectionsForm((p) => ({ ...p, netcashDebitOrderKey: v }))}
            riskReportsKeyConfigured={config?.netcashRiskReportsConfigured ?? false}
            maskedRiskReportsKey={config?.netcashRiskReportsKey ?? ""}
            riskReportsKeyValue={collectionsForm.netcashRiskReportsKey}
            onRiskReportsKeyChange={(v) => setCollectionsForm((p) => ({ ...p, netcashRiskReportsKey: v }))}
            onSave={handleSaveCollections}
            saving={savingCollections}
            onTest={() => handleTest("collections")}
            testing={testing === "collections"}
            testResult={testing === null && testResult ? testResult : null}
          />
        </TabsContent>
      </Tabs>

      {/* Experian (read-only): credentials live in .env, not editable here */}
      <ExperianStatusCard
        configured={config?.experianConfigured ?? false}
        env={config?.experianEnv ?? ""}
      />

      {/* Notification Log */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Notifications</CardTitle>
          <CardDescription>Last 20 notification events</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Channel</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Date</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground">
                    No notifications yet
                  </TableCell>
                </TableRow>
              ) : (
                logs.map((log) => {
                  const displayStatus = notificationLogDisplayStatus(log.status)
                  return <TableRow key={log.id}>
                    <TableCell>{log.event}</TableCell>
                    <TableCell>{log.channel}</TableCell>
                    <TableCell>
                      <Badge variant={displayStatus.tone === "success" ? "default" : displayStatus.tone === "simulation" ? "secondary" : "destructive"}>
                        {displayStatus.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate">{log.error ?? "—"}</TableCell>
                    <TableCell>{new Date(log.createdAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}</TableCell>
                  </TableRow>
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

function IntegrationCard(props: {
  title: string
  description: string
  configured: boolean
  maskedKey: string
  fieldLabel: string
  fieldValue: string
  onFieldChange: (v: string) => void
  onSave: () => void
  onTest: () => void
  saving: boolean
  testing: boolean
  testResult: string | null
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{props.title}</CardTitle>
            <CardDescription>{props.description}</CardDescription>
          </div>
          <Badge variant={props.configured ? "default" : "secondary"}>
            {props.configured ? "Configured" : "Not configured"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {props.configured && (
          <p className="text-sm text-muted-foreground">
            Current key: <code>{props.maskedKey}</code>
          </p>
        )}
        <div className="space-y-2">
          <Label>{props.fieldLabel}</Label>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="Enter new credentials..."
              value={props.fieldValue}
              onChange={(e) => props.onFieldChange(e.target.value)}
            />
            <Button onClick={props.onSave} disabled={props.saving || !props.fieldValue}>
              {props.saving ? "Saving..." : "Save"}
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={props.onTest} disabled={props.testing || !props.configured}>
            {props.testing ? "Testing..." : "Test Connection"}
          </Button>
          {props.testResult && (
            <span className={`text-sm ${props.testResult.includes("successful") ? "text-green-600" : "text-red-600"}`}>
              {props.testResult}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function CollectionsCard(props: {
  configured: boolean
  collectionProvider: string
  onProviderChange: (v: string) => void
  collectionsEngineEnabled: boolean
  onEngineEnabledChange: (v: boolean) => void
  debitOrderKeyConfigured: boolean
  maskedDebitOrderKey: string
  debitOrderKeyValue: string
  onDebitOrderKeyChange: (v: string) => void
  riskReportsKeyConfigured: boolean
  maskedRiskReportsKey: string
  riskReportsKeyValue: string
  onRiskReportsKeyChange: (v: string) => void
  onSave: () => void
  saving: boolean
  onTest: () => void
  testing: boolean
  testResult: string | null
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Collections</CardTitle>
            <CardDescription>
              Provider-agnostic collection engine — account verification (AVS) and debit-order collection
            </CardDescription>
          </div>
          <Badge variant={props.configured ? "default" : "secondary"}>
            {props.configured ? "Configured" : "Not configured"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 max-w-xs">
          <Label>Provider</Label>
          <Select
            value={props.collectionProvider || "none"}
            onValueChange={(v) => props.onProviderChange(v === "none" ? "" : v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="netcash">Netcash</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {props.debitOrderKeyConfigured && (
          <p className="text-sm text-muted-foreground">
            Current debit order key: <code>{props.maskedDebitOrderKey}</code>
          </p>
        )}
        <div className="space-y-2">
          <Label>Netcash Debit Order Service Key</Label>
          <Input
            type="password"
            placeholder="Enter new service key..."
            value={props.debitOrderKeyValue}
            onChange={(e) => props.onDebitOrderKeyChange(e.target.value)}
          />
        </div>

        {props.riskReportsKeyConfigured && (
          <p className="text-sm text-muted-foreground">
            Current risk reports key: <code>{props.maskedRiskReportsKey}</code>
          </p>
        )}
        <div className="space-y-2">
          <Label>Netcash Risk Reports (AVS) Service Key</Label>
          <Input
            type="password"
            placeholder="Enter new service key..."
            value={props.riskReportsKeyValue}
            onChange={(e) => props.onRiskReportsKeyChange(e.target.value)}
          />
        </div>

        <div className="flex items-center justify-between gap-4 pt-2">
          <div>
            <Label htmlFor="collectionsEngineEnabled">
              Collection engine enabled (master flag — leave OFF until Phase 7 go-live)
            </Label>
          </div>
          <Switch
            id="collectionsEngineEnabled"
            checked={props.collectionsEngineEnabled}
            onCheckedChange={props.onEngineEnabledChange}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button onClick={props.onSave} disabled={props.saving}>
            {props.saving ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" onClick={props.onTest} disabled={props.testing || !props.configured}>
            {props.testing ? "Testing..." : "Test AVS"}
          </Button>
          {props.testResult && (
            <span className={`text-sm ${props.testResult.includes("successful") ? "text-green-600" : "text-red-600"}`}>
              {props.testResult}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
