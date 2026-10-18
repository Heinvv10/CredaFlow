"use client"

// The lender's wording of one asset-finance document variant: the editable
// clauses and additional terms only. Everything else in the document is
// protected and shown here as a summary. Every edit is saved as a new draft
// that needs a second admin's approval of its exact text before publication.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"
import { openPreview, saveDraft, type ApiProblem } from "./asset-template-api"
import { AssetTemplateVersions } from "./AssetTemplateVersions"
import type { AdditionalTerm, AssetTemplateContent, AssetTemplateEditorProps } from "./asset-template-types"

const card = "bg-[var(--cf-bg-raised)] border border-[var(--cf-border-subtle)] rounded-2xl p-5"
const label = "text-[10px] font-semibold uppercase tracking-wider text-[var(--cf-text-muted)]"
const input = "w-full border border-[var(--cf-border-strong)] rounded-lg px-3 py-2 text-sm bg-[var(--cf-bg-panel)] text-[var(--cf-text)]"

export function AssetTemplateEditor(props: AssetTemplateEditorProps) {
  const router = useRouter()
  const latest = props.versions[0]
  const [content, setContent] = useState<AssetTemplateContent>(latest.content)
  const [notes, setNotes] = useState("")
  const [problems, setProblems] = useState<ApiProblem[]>([])
  const [busy, setBusy] = useState(false)

  const setClause = (id: string, text: string) => setContent((c) => ({ ...c, clauses: { ...c.clauses, [id]: text } }))
  const setTerm = (i: number, term: Partial<AdditionalTerm>) =>
    setContent((c) => ({ ...c, additionalTerms: c.additionalTerms.map((t, j) => (j === i ? { ...t, ...term } : t)) }))
  const problemFor = (field: string) => problems.filter((p) => p.field === field || p.field.startsWith(`${field}.`))

  const preview = async () => {
    const result = await openPreview(props.templateId, { content })
    setProblems(result.ok ? [] : result.problems)
    if (!result.ok) toast.error(result.error)
  }
  const save = async () => {
    setBusy(true)
    const result = await saveDraft(props.templateId, content, notes)
    setBusy(false)
    setProblems(result.ok ? [] : result.problems)
    if (!result.ok) return toast.error(result.error)
    toast.success("Draft saved", `Version ${result.value.version} needs a second admin's approval before it can be published`)
    setNotes("")
    router.refresh()
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <div className={card}>
          <h2 className={label}>Protected content</h2>
          <p className="text-sm text-[var(--cf-text-secondary)] mt-2" data-testid="protected-summary">{props.protectedSummary}</p>
          <p className="text-xs text-[var(--cf-text-muted)] mt-2">
            Your identity comes from Settings → Lender identity. Figures, schedules, statutory notices and the numbered
            clauses not listed below are printed by the system and cannot be edited here.
          </p>
          {content.starterRevision !== props.starterRevision && (
            <p className="text-xs text-[var(--cf-warning)] mt-2">This wording was adopted from an earlier starter ({content.starterRevision}); it is not changed automatically.</p>
          )}
        </div>

        {props.editable.map((clause) => (
          <div key={clause.id} className={card}>
            <label htmlFor={`clause-${clause.id}`} className={label}>Clause {clause.number} — {clause.heading}</label>
            {clause.requiredTokens.length > 0 && (
              <p className="text-xs text-[var(--cf-text-muted)] mt-1">Must contain {clause.requiredTokens.map((t) => `{{${t}}}`).join(" and ")}.</p>
            )}
            <textarea id={`clause-${clause.id}`} className={`${input} mt-2 min-h-[160px] font-mono text-xs`} value={content.clauses[clause.id] ?? ""}
              onChange={(e) => setClause(clause.id, e.target.value)} />
            {problemFor(`clauses.${clause.id}`).map((p, i) => <p key={i} role="alert" className="text-xs text-[var(--cf-danger)] mt-1">{p.message}</p>)}
            <button type="button" className="text-xs text-[var(--cf-brand)] mt-2 hover:underline" onClick={() => setClause(clause.id, clause.starter)}>Restore the starter text</button>
          </div>
        ))}

        {props.takesLenderText && <div className={card}>
          <div className="flex items-center justify-between">
            <h2 className={label}>Additional terms (printed from clause {props.firstAdditionalNumber})</h2>
            <Button type="button" variant="outline" size="sm" disabled={content.additionalTerms.length >= 10}
              onClick={() => setContent((c) => ({ ...c, additionalTerms: [...c.additionalTerms, { heading: "", text: "" }] }))}>
              Add a term
            </Button>
          </div>
          {content.additionalTerms.length === 0 && <p className="text-sm text-[var(--cf-text-muted)] mt-3">No additional terms.</p>}
          {content.additionalTerms.map((term, i) => (
            <div key={i} className="mt-4 space-y-2 border-t border-[var(--cf-border-subtle)] pt-4">
              <input aria-label={`Additional term ${i + 1} heading`} className={input} placeholder="Heading" value={term.heading} onChange={(e) => setTerm(i, { heading: e.target.value })} />
              <textarea aria-label={`Additional term ${i + 1} text`} className={`${input} min-h-[100px]`} value={term.text} onChange={(e) => setTerm(i, { text: e.target.value })} />
              {problemFor(`additionalTerms.${i}`).map((p, j) => <p key={j} role="alert" className="text-xs text-[var(--cf-danger)]">{p.message}</p>)}
              <button type="button" className="text-xs text-[var(--cf-danger)] hover:underline"
                onClick={() => setContent((c) => ({ ...c, additionalTerms: c.additionalTerms.filter((_, j) => j !== i) }))}>
                Remove
              </button>
            </div>
          ))}
          {problemFor("additionalTerms").filter((p) => p.field === "additionalTerms").map((p, i) => <p key={i} role="alert" className="text-xs text-[var(--cf-danger)] mt-2">{p.message}</p>)}
        </div>}

        <div className={card}>
          <label htmlFor="draft-notes" className={label}>What changed (saved with the draft)</label>
          <input id="draft-notes" className={`${input} mt-2`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
          {problemFor("content").concat(problemFor("clauses").filter((p) => p.field === "clauses")).map((p, i) => <p key={i} role="alert" className="text-xs text-[var(--cf-danger)] mt-2">{p.message}</p>)}
          <div className="flex gap-2 mt-4">
            <Button type="button" variant="outline" onClick={preview}>Preview PDF</Button>
            <Button type="button" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save as new draft"}</Button>
          </div>
        </div>
      </div>

      <div className="space-y-6">
        <AssetTemplateVersions {...props} onLoad={(c) => { setContent(c); toast.success("Loaded into the editor", "Save it as a new draft to change it") }} />
        <div className={card}>
          <h2 className={label}>Tokens</h2>
          <ul className="mt-2 space-y-1">
            {props.tokens.map((t) => (
              <li key={t.token} className="text-xs text-[var(--cf-text-secondary)]"><code className="font-mono">{`{{${t.token}}}`}</code> — {t.label}</li>
            ))}
          </ul>
          <p className="text-xs text-[var(--cf-text-muted)] mt-2">Amounts, rates, percentages, fees, charges and wording that overrides, varies or waives the protected terms are refused.</p>
        </div>
      </div>
    </div>
  )
}
