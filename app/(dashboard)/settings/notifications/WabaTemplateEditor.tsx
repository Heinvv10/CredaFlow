"use client"

import { useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Save, Send, AlertTriangle, CheckCircle } from "lucide-react"
import {
  buildTemplateCreateComponents,
  templateLanguageProblem,
  templateNameProblem,
  WABA_TEMPLATE_CATEGORY,
} from "@/lib/whatsapp/template-create"
import type { StoredTemplateButton } from "@/lib/whatsapp/template-buttons"
import { WabaButtonsBuilder } from "./WabaButtonsBuilder"
import { WabaTemplateList } from "./WabaTemplateList"

/** Categories this editor writes. MARKETING is excluded — it needs a consent
 * purpose the schema requires alongside it, and the route refuses it. */
const CATEGORIES = ["SERVICE", "TRANSACTIONAL"] as const
type Category = (typeof CATEGORIES)[number]

export interface WabaTemplate {
  id: string
  event: string
  wabaTemplateName: string | null
  language: string
  category: string | null
  headerContent: string | null
  bodyTemplate: string | null
  footer: string | null
  buttons: unknown
  active: boolean
  providerStatus: string | null
  providerTemplateId: string | null
}

type Draft = {
  event: string
  wabaTemplateName: string
  language: string
  category: Category
  headerContent: string
  bodyTemplate: string
  footer: string
  buttons: StoredTemplateButton[]
  /** Set when the STORED row holds something this editor cannot round-trip, so
   * saving would silently discard or downgrade it. Blocks the save. */
  rowError: string | null
  active: boolean
}

/**
 * A stored value this editor cannot represent must BLOCK the save, never be
 * silently normalised: a non-array buttons blob would be shown as "no buttons"
 * and overwritten with null, and a MARKETING category would be downgraded to
 * SERVICE — a change of lawful basis nobody asked for.
 */
function storedRowProblem(t: WabaTemplate | null): string | null {
  if (!t) return null
  const buttons = t.buttons
  if (buttons !== null && buttons !== undefined && !Array.isArray(buttons)) {
    return "This template's stored buttons are not a list, so they cannot be edited here — saving would discard them. Fix the row before editing."
  }
  if (t.category && !CATEGORIES.includes(t.category as Category)) {
    return `This template's category is ${t.category}, which this editor cannot set — saving would change its consent basis. Edit it where that category is supported.`
  }
  return null
}

function toDraft(t: WabaTemplate | null): Draft {
  return {
    event: t?.event ?? "",
    wabaTemplateName: t?.wabaTemplateName ?? "",
    language: t?.language ?? "en",
    // SERVICE is the conservative default for a template with no category:
    // it respects channel opt-out, where TRANSACTIONAL bypasses consent rules.
    // Never inferred from an unsupported stored value — storedRowProblem blocks
    // that case instead.
    category: t?.category === "TRANSACTIONAL" ? "TRANSACTIONAL" : "SERVICE",
    headerContent: t?.headerContent ?? "",
    bodyTemplate: t?.bodyTemplate ?? "",
    footer: t?.footer ?? "",
    buttons: Array.isArray(t?.buttons) ? (t.buttons as StoredTemplateButton[]) : [],
    rowError: storedRowProblem(t),
    active: t?.active ?? true,
  }
}

const inputClass =
  "w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4F46E5]"

function StatusBadge({ status }: { status: string | null }) {
  const tone =
    status === "APPROVED" ? "bg-green-100 text-green-700"
      : status === "REJECTED" ? "bg-red-100 text-red-700"
        : status ? "bg-amber-100 text-amber-700"
          : "bg-gray-100 text-gray-500"
  return (
    <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${tone}`}>
      {status ?? "NOT SUBMITTED"}
    </span>
  )
}

export function WabaTemplateEditor({ templates }: { templates: WabaTemplate[] }) {
  const [rows, setRows] = useState<WabaTemplate[]>(templates)
  const [selectedId, setSelectedId] = useState<string | null>(templates[0]?.id ?? null)
  const [draft, setDraft] = useState<Draft>(() => toDraft(templates[0] ?? null))
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const selected = rows.find((r) => r.id === selectedId) ?? null
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setResult(null)
  }

  const select = (id: string | null) => {
    setSelectedId(id)
    setDraft(toDraft(rows.find((r) => r.id === id) ?? null))
    setResult(null)
  }

  // Unconditional: a blank name is not "not yet filled in", it is a template
  // that can never register — and the route refuses it too.
  const nameProblem = templateNameProblem(draft.wabaTemplateName)
  const langProblem = templateLanguageProblem(draft.language)

  // An upsert on (tenant, event, WHATSAPP) REPLACES a row with the same event.
  // That is correct PUT behaviour, but from "+ New template" it looks like a
  // create, so say plainly that it will overwrite.
  const collision = !selectedId && draft.event.trim()
    ? rows.find((r) => r.event === draft.event.trim())
    : undefined

  // The live create-shape payload, built with the SAME function the write path
  // and Meta's CREATE call use. Not a mock-up: what renders here is byte-for-byte
  // what gets submitted, including the {{name}} → {{1}} renumbering, and its
  // thrown message is the inline error.
  const preview = useMemo(() => {
    if (!draft.bodyTemplate.trim()) {
      return { components: null, error: null as string | null }
    }
    try {
      return {
        components: buildTemplateCreateComponents({
          bodyTemplate: draft.bodyTemplate,
          headerContent: draft.headerContent || null,
          footer: draft.footer || null,
          buttons: draft.buttons,
        }),
        error: null as string | null,
      }
    } catch (err) {
      return { components: null, error: err instanceof Error ? err.message : "invalid template" }
    }
  }, [draft.bodyTemplate, draft.headerContent, draft.footer, draft.buttons])

  const blocked =
    Boolean(nameProblem || langProblem || preview.error || draft.rowError)
    || !draft.event.trim()
    || !draft.bodyTemplate.trim()

  const save = async () => {
    setSaving(true)
    setResult(null)
    try {
      const res = await fetch("/api/settings/notifications/waba", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, buttons: draft.buttons.length > 0 ? draft.buttons : null }),
      })
      const json = await res.json() as {
        template?: WabaTemplate
        submit?: { attempted: boolean; ok: boolean; reason?: string; error?: string }
        error?: string
      }
      if (!res.ok || !json.template) {
        setResult({ ok: false, message: json.error ?? `Save failed (${res.status})` })
        return
      }
      const saved = json.template
      setRows((prev) => {
        const without = prev.filter((r) => r.id !== saved.id)
        return [...without, saved].sort((a, b) => a.event.localeCompare(b.event))
      })
      setSelectedId(saved.id)
      setDraft(toDraft(saved))
      // Only "unchanged" is a benign non-submit, and it is only benign because
      // the route resubmits anything that never registered. Reporting a failed
      // submission in the same green tone would tell the operator a template
      // is with Meta when it never got there.
      setResult(
        json.submit?.attempted && !json.submit.ok
          ? { ok: false, message: `Saved, but it was NOT submitted — Meta returned: ${json.submit.error}` }
          : json.submit?.attempted
            ? { ok: true, message: "Saved and submitted to Meta for approval." }
            : { ok: true, message: "Saved. Already registered and nothing Meta reviews changed, so it was not resubmitted." },
      )
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : "Save failed" })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="space-y-4">
        <WabaTemplateList rows={rows} selectedId={selectedId} onSelect={select} />

        <div className="bg-white rounded-lg border border-[#e5e7eb] p-5 space-y-4">
          <h3 className="font-semibold text-[#1b1d24]">
            {selected ? selected.event : "New template"}
          </h3>

          {selected && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <span>Meta status:</span>
              <StatusBadge status={selected.providerStatus} />
              <span className="font-mono">{selected.providerTemplateId ?? "no provider id"}</span>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-medium text-gray-600 space-y-1">
              <span>Event key</span>
              <input
                aria-label="Event key"
                type="text" placeholder="loan_approved" value={draft.event}
                disabled={Boolean(selected)}
                onChange={(e) => set("event", e.target.value)}
                className={`${inputClass} font-mono disabled:bg-gray-50`}
              />
              {selected && <span className="text-gray-400">The event key identifies the row and cannot be changed.</span>}
            </label>

            <label className="text-xs font-medium text-gray-600 space-y-1">
              <span>Meta template name</span>
              <input
                aria-label="Meta template name"
                type="text" placeholder="loan_approved" value={draft.wabaTemplateName}
                onChange={(e) => set("wabaTemplateName", e.target.value)}
                className={`${inputClass} font-mono`}
              />
              {nameProblem && <span className="text-red-600">Name {nameProblem}</span>}
            </label>

            <label className="text-xs font-medium text-gray-600 space-y-1">
              <span>Language</span>
              <input
                aria-label="Language"
                type="text" placeholder="en" value={draft.language}
                onChange={(e) => set("language", e.target.value)}
                className={`${inputClass} font-mono`}
              />
              {langProblem && <span className="text-red-600">Language {langProblem}</span>}
            </label>

            <label className="text-xs font-medium text-gray-600 space-y-1">
              <span>Category</span>
              <select
                aria-label="Category"
                value={draft.category}
                onChange={(e) => set("category", e.target.value as Category)}
                className={inputClass}
              >
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="text-gray-400">
                SERVICE respects channel opt-out. TRANSACTIONAL bypasses marketing-consent rules — use only for OTPs and password resets.
              </span>
            </label>

            <label className="flex items-center gap-2 text-xs font-medium text-gray-600 sm:pt-6">
              <input type="checkbox" checked={draft.active} onChange={(e) => set("active", e.target.checked)} />
              <span>Active</span>
            </label>
          </div>

          <label className="block text-xs font-medium text-gray-600 space-y-1">
            <span>Header (optional, one variable max)</span>
            <input
              type="text" value={draft.headerContent}
              onChange={(e) => set("headerContent", e.target.value)}
              className={inputClass}
            />
          </label>

          <label className="block text-xs font-medium text-gray-600 space-y-1">
            <span>Body</span>
            <textarea
              rows={5} value={draft.bodyTemplate}
              onChange={(e) => set("bodyTemplate", e.target.value)}
              className={`${inputClass} font-mono`}
            />
            <span className="text-gray-400">Use named variables like {"{{firstName}}"}. Meta sees them renumbered as {"{{1}}"} — check the preview.</span>
          </label>

          <label className="block text-xs font-medium text-gray-600 space-y-1">
            <span>Footer (optional, no variables)</span>
            <input
              type="text" value={draft.footer}
              onChange={(e) => set("footer", e.target.value)}
              className={inputClass}
            />
          </label>

          <div className="space-y-2">
            <span className="text-xs font-medium text-gray-600">Buttons</span>
            <WabaButtonsBuilder buttons={draft.buttons} onChange={(b) => set("buttons", b)} disabled={saving} />
          </div>

          {draft.rowError && (
            <p className="flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2.5">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />{draft.rowError}
            </p>
          )}

          {collision && (
            <p className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2.5">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />
              A WhatsApp template for <span className="font-mono">{collision.event}</span> already exists. Saving REPLACES it.
            </p>
          )}

          {preview.error && (
            <p className="flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2.5">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />{preview.error}
            </p>
          )}

          {result && (
            <p className={`flex items-start gap-2 text-xs rounded p-2.5 border ${
              result.ok ? "text-green-700 bg-green-50 border-green-200" : "text-red-600 bg-red-50 border-red-200"
            }`}>
              {result.ok ? <CheckCircle className="h-4 w-4 shrink-0 mt-px" /> : <AlertTriangle className="h-4 w-4 shrink-0 mt-px" />}
              {result.message}
            </p>
          )}

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={save} disabled={saving || blocked}>
              <Save className="h-3.5 w-3.5 mr-1.5" />{saving ? "Saving..." : "Save & submit to Meta"}
            </Button>
            <span className="text-[11px] text-gray-400 flex items-center gap-1">
              <Send className="h-3 w-3" />Saving submits for approval when a review-relevant field changed.
            </span>
          </div>
        </div>
      </div>

      <aside className="space-y-2">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-500">Payload sent to Meta</h4>
        <pre className="bg-[#1b1d24] text-[#e2e5ea] rounded-lg p-4 text-[11px] leading-relaxed overflow-x-auto max-h-[36rem]">
{preview.components
  ? JSON.stringify(
      {
        name: draft.wabaTemplateName || "…",
        language: draft.language,
        category: WABA_TEMPLATE_CATEGORY,
        components: preview.components,
      },
      null, 2,
    )
  : preview.error ?? "Enter a body to preview the payload."}
        </pre>
      </aside>
    </div>
  )
}
