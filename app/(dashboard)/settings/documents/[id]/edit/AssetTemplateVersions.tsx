"use client"

// Versions of an asset-finance template, newest first, with the approval and
// publication actions. An approval needs a preview of that exact version in
// this session first: the hash the preview returned is what is approved.
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/toast"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { approve, openPreview, publish } from "./asset-template-api"
import type { AssetTemplateContent, AssetTemplateEditorProps, AssetVersionView } from "./asset-template-types"

const STATUS: Record<AssetVersionView["status"], string> = {
  DRAFT: "bg-[var(--cf-surface-soft)] text-[var(--cf-text-secondary)]",
  ACTIVE: "bg-[var(--cf-surface-soft)] text-[var(--cf-success)]",
  ARCHIVED: "bg-[var(--cf-surface-soft)] text-[var(--cf-text-muted)]",
}
const when = (iso: string) => new Date(iso).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE, dateStyle: "medium", timeStyle: "short" })

function ApprovalForm({ version, props, previewedSha, done }: {
  version: AssetVersionView; props: AssetTemplateEditorProps; previewedSha: string | null; done: () => void
}) {
  const [attested, setAttested] = useState(false)
  const [signedOff, setSignedOff] = useState(false)
  const [reference, setReference] = useState("")
  const [busy, setBusy] = useState(false)
  if (!previewedSha) return <p className="text-xs text-[var(--cf-text-muted)]">Preview this version to approve it.</p>
  if (!props.isDemoLender && props.currentUserRole !== "SUPER_ADMIN") {
    return <p className="text-xs text-[var(--cf-text-muted)]">A legal approval is recorded by a SUPER_ADMIN of your lender.</p>
  }
  const submit = async () => {
    setBusy(true)
    const result = await approve(props.templateId, version.id, {
      contentSha256: previewedSha, attestation: attested, ...(props.isDemoLender ? {} : { legalSignOff: signedOff, legalSignOffReference: reference }),
    })
    setBusy(false)
    if (!result.ok) return toast.error(result.error)
    toast.success(`Version ${version.version} approved`, result.value.approvalBasis === "SYNTHETIC_DEMO" ? "Synthetic demo approval: documents keep a demo watermark" : undefined)
    done()
  }
  return (
    <div className="space-y-2 mt-2">
      <label className="flex items-start gap-2 text-xs text-[var(--cf-text-secondary)]">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} className="mt-0.5" />
        I have read the full preview of version {version.version}. Its wording changes no fee, rate, schedule, statutory right or system process.
      </label>
      {props.isDemoLender ? (
        <p className="text-xs text-[var(--cf-warning)]">Demo lender: this records a synthetic demo approval, not a legal approval. Issued documents keep a demo watermark.</p>
      ) : (
        <>
        <label className="flex items-start gap-2 text-xs text-[var(--cf-text-secondary)]">
          <input type="checkbox" checked={signedOff} onChange={(e) => setSignedOff(e.target.checked)} className="mt-0.5" />
          Our legal team signed off version {version.version} (sha256 {previewedSha.slice(0, 12)}…) in writing. Issued documents will carry no DRAFT mark.
        </label>
        <input aria-label="Legal sign-off reference" placeholder="Your legal team's sign-off reference" value={reference} onChange={(e) => setReference(e.target.value)}
          className="w-full border border-[var(--cf-border-strong)] rounded-lg px-2 py-1 text-xs bg-[var(--cf-bg-panel)] text-[var(--cf-text)]" />
        </>
      )}
      <Button type="button" size="sm" onClick={submit} disabled={busy || !attested || (!props.isDemoLender && !signedOff)}>{busy ? "Approving…" : `Approve version ${version.version}`}</Button>
    </div>
  )
}

export function AssetTemplateVersions(props: AssetTemplateEditorProps & { onLoad: (content: AssetTemplateContent) => void }) {
  const router = useRouter()
  const [previewed, setPreviewed] = useState<Record<string, string>>({})
  const [shape, setShape] = useState(props.shapes[0]?.id ?? "")
  const preview = async (v: AssetVersionView) => {
    const result = await openPreview(props.templateId, { versionId: v.id, shape })
    if (!result.ok) return toast.error(result.error)
    if (result.value.sha) setPreviewed((p) => ({ ...p, [v.id]: result.value.sha! }))
  }
  const doPublish = async (v: AssetVersionView) => {
    const result = await publish(props.templateId, v.id)
    if (!result.ok) return toast.error(result.error)
    toast.success(`Version ${v.version} published`, "Documents issued from now on use it; documents already issued keep their version")
    router.refresh()
  }
  return (
    <div className="bg-[var(--cf-bg-raised)] border border-[var(--cf-border-subtle)] rounded-2xl overflow-hidden">
      <h2 className="text-[10px] font-semibold uppercase tracking-wider text-[var(--cf-text-muted)] px-5 pt-5 pb-2">Versions</h2>
      <label className="block px-5 pb-2 text-xs text-[var(--cf-text-secondary)]">
        Preview deal
        <select aria-label="Preview deal" value={shape} onChange={(e) => setShape(e.target.value)}
          className="mt-1 w-full border border-[var(--cf-border-strong)] rounded-lg px-2 py-1 text-xs bg-[var(--cf-bg-panel)] text-[var(--cf-text)]">
          {props.shapes.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
        <span className="block mt-1 text-[var(--cf-text-muted)]">Approving covers the protected wording of every deal shown here: preview each before approving.</span>
      </label>
      <ul className="divide-y divide-[var(--cf-border-subtle)]">
        {props.versions.map((v) => {
          const mine = v.createdById === props.currentUserId
          return (
            <li key={v.id} className="px-5 py-3 space-y-1" data-testid={`version-${v.version}`}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-[var(--cf-text)]">Version {v.version}</span>
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS[v.status]}`}>{v.status === "ACTIVE" ? "Published" : v.status === "ARCHIVED" ? "Archived" : "Draft"}</span>
              </div>
              <p className="text-xs text-[var(--cf-text-muted)]">By {v.createdBy}, {when(v.createdAt)}{v.notes ? ` — ${v.notes}` : ""}</p>
              <p className="text-[11px] font-mono text-[var(--cf-text-muted)] break-all">sha256 {v.contentSha256.slice(0, 16)}…</p>
              {v.approvedBy && (
                <p className="text-xs text-[var(--cf-text-secondary)]">
                  {v.approvalBasis === "SYNTHETIC_DEMO" ? "Synthetic demo approval" : `Legal approval (${v.legalSignOffReference})`} by {v.approvedBy}, {when(v.approvedAt!)}
                </p>
              )}
              {v.activatedBy && <p className="text-xs text-[var(--cf-text-secondary)]">Published by {v.activatedBy}, {when(v.activatedAt!)}</p>}
              <div className="flex flex-wrap gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" onClick={() => preview(v)}>Preview v{v.version}</Button>
                <Button type="button" variant="outline" size="sm" onClick={() => props.onLoad(v.content)}>Load into editor</Button>
                {v.status === "DRAFT" && v.approvedBy && v.approvedById !== props.currentUserId && (
                  <Button type="button" size="sm" onClick={() => doPublish(v)}>Publish v{v.version}</Button>
                )}
              </div>
              {v.status === "DRAFT" && !v.approvedBy && (mine
                ? <p className="text-xs text-[var(--cf-text-muted)]">Awaiting approval by another admin.</p>
                : <ApprovalForm version={v} props={props} previewedSha={previewed[v.id] ?? null} done={() => router.refresh()} />)}
              {v.status === "DRAFT" && v.approvedById === props.currentUserId && (
                <p className="text-xs text-[var(--cf-text-muted)]">You approved this version; another admin publishes it.</p>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
