"use client"

// Settings → Document templates, for a lender outside the NCA: the two documents a loan is signed on
// (lib/non-nca-documents). The wording is the lender's own legal text: nothing is written for it here.
// Setup: create the template, save a draft in the editor, a second admin approves it, anyone but the
// approver publishes it. Loan documents are issued only from the published, approved version.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"

export interface LoanDocumentTemplateRow {
  key: string
  name: string
  templateId: string | null
  published: number | null
  drafts: number
  awaitingApproval: number
}

export function LoanDocumentTemplates({ rows }: { rows: LoanDocumentTemplateRow[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function create(row: LoanDocumentTemplateRow) {
    setBusy(row.key)
    try {
      const res = await fetch("/api/documents/templates", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: row.name, key: row.key, category: "Agreement" }),
      })
      const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string }
      if (!res.ok || !data.id) {
        toast.error(data.error ?? "Could not create the template")
        return
      }
      router.push(`/settings/documents/${data.id}/edit`)
    } catch {
      toast.networkError()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mb-6 rounded-2xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-5" data-testid="loan-document-templates">
      <h2 className="text-sm font-semibold text-[var(--cf-text)]">Loan documents: key facts statement and loan agreement</h2>
      <p className="mt-1 text-xs text-[var(--cf-text-muted)]">
        A loan is signed on these two documents, in your own wording. Create each template, write and save a draft, have a second
        admin approve it in the version list, then publish it. Nothing is issued until both have a published, approved version.
        The figures come from the approved loan through the Approved terms tokens.
      </p>
      <ul className="mt-4 divide-y divide-[var(--cf-border-subtle)]">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid={`loan-template-${r.key}`}>
            <div>
              <p className="text-sm font-medium text-[var(--cf-text)]">{r.name}</p>
              <p className="text-xs text-[var(--cf-text-secondary)]">
                {!r.templateId
                  ? "Not created yet"
                  : r.published
                    ? `Version ${r.published} published`
                    : r.awaitingApproval > 0
                      ? `${r.awaitingApproval} draft${r.awaitingApproval === 1 ? "" : "s"} awaiting approval by a second admin: no published version, documents cannot be issued`
                      : r.drafts > 0
                        ? "Approved draft ready to publish: no published version yet"
                        : "No version yet: documents cannot be issued"}
              </p>
            </div>
            {r.templateId ? (
              <a className="text-sm text-[var(--cf-brand)] hover:underline" href={`/settings/documents/${r.templateId}/edit`}>Open the editor</a>
            ) : (
              <Button type="button" size="sm" variant="outline" disabled={busy === r.key} onClick={() => create(r)}>
                {busy === r.key ? "Creating…" : "Create template"}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
