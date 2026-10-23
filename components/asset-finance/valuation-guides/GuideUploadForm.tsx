"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { FormError, TextField } from "@/components/asset-finance/register-form-controls"
import { SELECT_CLASS } from "@/components/asset-finance/form-fields"

interface Problem { line: number; reason: string }

/**
 * Loads a valuation guide as a DRAFT (manage_valuation_guides): a CSV with the
 * header make,model,year,variant,trade_cents,retail_cents. A refused file
 * lists its reasons per line; nothing is stored. `synthetic` offers the
 * simulated provider (only where this deployment permits it).
 */
export function GuideUploadForm({ synthetic }: { synthetic: boolean }) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [name, setName] = useState("")
  const [effectiveOn, setEffectiveOn] = useState("")
  const [provider, setProvider] = useState<"csv" | "synthetic">("csv")
  const [error, setError] = useState<string | null>(null)
  const [fields, setFields] = useState<Record<string, string>>({})
  const [problems, setProblems] = useState<{ list: Problem[]; total: number } | null>(null)
  const [saving, setSaving] = useState(false)

  const upload = async () => {
    const form = new FormData()
    form.set("name", name)
    form.set("effectiveOn", effectiveOn)
    form.set("provider", provider)
    const file = fileInput.current?.files?.[0]
    if (provider === "csv" && file) form.set("file", file)
    setSaving(true)
    setError(null)
    setFields({})
    setProblems(null)
    try {
      const res = await fetch("/api/asset-finance/valuation-guides", { method: "POST", body: form })
      const body = (await res.json().catch(() => ({}))) as { error?: string; fields?: Record<string, string>; problems?: Problem[]; total?: number }
      if (!res.ok) {
        setError(body.error ?? `Upload failed (${res.status})`)
        setFields(body.fields ?? {})
        if (body.problems) setProblems({ list: body.problems, total: body.total ?? body.problems.length })
        return
      }
      setName("")
      setEffectiveOn("")
      if (fileInput.current) fileInput.current.value = ""
      router.refresh()
    } catch {
      setError("Network error — try again")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <FormError message={error} />
      {problems && (
        <div className="rounded-md border border-[var(--cf-border-subtle)] p-3 text-sm">
          <p className="mb-2 font-semibold text-[var(--cf-text)]">
            {problems.total} line(s) refused{problems.total > problems.list.length ? `, the first ${problems.list.length} shown` : ""}. Nothing was stored.
          </p>
          <ul className="max-h-64 space-y-1 overflow-y-auto">
            {problems.list.map((p) => (
              <li key={p.line} className="text-[var(--cf-text-secondary)]"><span className="font-mono text-xs">Line {p.line}:</span> {p.reason}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <TextField id="guideName" label="Guide name" required placeholder="Plant and vehicle guide" value={name} onChange={setName} error={fields.name} />
        <TextField id="guideEffectiveOn" label="Effective from" type="date" required value={effectiveOn} onChange={setEffectiveOn} error={fields.effectiveOn} />
        {synthetic && (
          <div className="space-y-1.5">
            <label htmlFor="guideProvider" className="text-xs text-[var(--cf-text-secondary)]">Source</label>
            <select id="guideProvider" className={SELECT_CLASS} value={provider} onChange={(e) => setProvider(e.target.value as "csv" | "synthetic")}>
              <option value="csv">CSV file</option>
              <option value="synthetic">Synthetic guide (simulated)</option>
            </select>
          </div>
        )}
      </div>
      {provider === "csv" && (
        <div>
          <label htmlFor="guideFile" className="mb-1.5 block text-xs text-[var(--cf-text-secondary)]">
            CSV file, up to 5 MB: make,model,year,variant,trade_cents,retail_cents (values incl. VAT, in cents)
          </label>
          <input id="guideFile" ref={fileInput} type="file" accept=".csv,text/csv"
            className="block w-full text-sm text-[var(--cf-text-secondary)] file:mr-3 file:rounded-md file:border-0 file:bg-[var(--cf-surface-strong)] file:px-3 file:py-2 file:text-sm file:text-[var(--cf-text)]" />
        </div>
      )}
      <p className="text-xs text-[var(--cf-text-muted)]">The guide is loaded as a draft. Another guide manager checks its rows and publishes it.</p>
      <Button size="sm" onClick={upload} disabled={saving}>
        {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
        {saving ? "Loading…" : "Load guide"}
      </Button>
    </div>
  )
}
