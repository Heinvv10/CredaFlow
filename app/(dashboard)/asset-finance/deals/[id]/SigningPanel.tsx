import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatDate } from "@/lib/utils"
import type { StaffSigningPanel } from "@/lib/asset-finance/signing-view"
import { DEAL_DOCUMENT_LABELS, SIGNED_DOC_TYPE, SIGNER_STATE_LABELS, type SignerState } from "@/lib/asset-finance/signing"
import { sastCalendarDate } from "@/lib/date/sast"
import { fromDayNumber, toDayNumber } from "@/lib/asset-finance/dates"
import { MAX_PLANNED_START_DAYS } from "@/lib/asset-finance/signing-prepare"
import { DealActionButton } from "./DealActionButton"
import { PrepareDocumentsForm } from "./PrepareDocumentsForm"
import { WetInkControls } from "./WetInkControls"

const STATE_TONE: Record<SignerState, "neutral" | "warning" | "success"> = {
  PENDING: "neutral",
  AWAITING_CONFIRMATION: "warning",
  SIGNED: "success",
  CONFIRMED: "success",
}

const link = "text-[var(--cf-brand)] underline-offset-2 hover:underline"

/** The deal page's "Documents & signing" panel (goal §4.9). */
export function SigningPanel(props: { dealId: string; panel: StaffSigningPanel; canManage: boolean; userId: string; advanceStart?: string }) {
  const { dealId, panel, canManage, userId, advanceStart } = props
  const open = panel.dealStatus === "APPROVED"
  const today = sastCalendarDate(new Date())
  const latest = fromDayNumber(toDayNumber(today) + MAX_PLANNED_START_DAYS)
  const complete = panel.signers.length > 0 && panel.missing.length === 0
    && panel.signers.every((s) => s.state === "SIGNED" || s.state === "CONFIRMED")
  const actions = canManage && open ? (
    <div className="flex flex-wrap gap-2">
      {panel.canPrepare && <PrepareDocumentsForm dealId={dealId} today={today} latest={latest} again={panel.signers.length > 0} fixedStart={advanceStart} />}
      {panel.signers.length > 0 && (
        <DealActionButton url={`/api/asset-finance/deals/${dealId}/contract`} label="Mark contracted" busyLabel="Checking signatures…" />
      )}
    </div>
  ) : undefined

  return (
    <DataPanel
      title="Documents & signing"
      description={complete ? "Every required signature is in." : "The agreement and resolution are signed by each authorised signatory; each surety signs their own suretyship."}
      actions={actions}
      density="loose"
    >
      {!panel.legalWordingApproved && (
        <p className="mb-3 rounded-md border border-[var(--cf-warning)] bg-[var(--cf-surface-soft)] p-3 text-sm text-[var(--cf-warning)]">
          The lender&apos;s legal wording is not approved: every document carries placeholder clauses and a DRAFT — NOT FOR EXECUTION watermark.
        </p>
      )}
      {panel.signers.length === 0 ? (
        <p className="text-sm text-[var(--cf-text-muted)]">
          {open ? "No documents yet. Prepare them to create the signer list." : "Documents are prepared once the deal is approved."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--cf-border-subtle)] text-left text-xs text-[var(--cf-text-muted)]">
                <th className="py-2 pr-3 font-medium">Document</th>
                <th className="py-2 pr-3 font-medium">Signer</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium">Read</th>
                <th className="py-2 font-medium">Wet ink</th>
              </tr>
            </thead>
            <tbody>
              {panel.signers.map((s) => {
                const documentUrl = `/api/asset-finance/deals/${dealId}/signers/${s.id}/document`
                const awaiting = s.state === "AWAITING_CONFIRMATION"
                return (
                  <tr key={s.id} className="border-b border-[var(--cf-border-subtle)] align-top">
                    <td className="py-2 pr-3 text-[var(--cf-text)]">{DEAL_DOCUMENT_LABELS[s.document]}</td>
                    <td className="py-2 pr-3 text-[var(--cf-text)]">{s.name}</td>
                    <td className="py-2 pr-3">
                      <StatusPill tone={STATE_TONE[s.state]}>{SIGNER_STATE_LABELS[s.state]}</StatusPill>
                      <p className="mt-1 text-xs text-[var(--cf-text-muted)]">
                        {s.signedAt && `E-signed ${formatDate(s.signedAt)}`}
                        {s.scanUploadedBy && `Scan by ${s.scanUploadedBy.label}`}
                        {s.confirmedBy && s.confirmedAt && ` · confirmed by ${s.confirmedBy} ${formatDate(s.confirmedAt)}`}
                      </p>
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <a className={link} href={documentUrl} target="_blank" rel="noopener noreferrer">View</a>
                      {" · "}
                      <a className={link} href={`${documentUrl}?download=1`}>Download</a>
                      {s.scanDocumentId && (
                        <>
                          {" · "}
                          <a className={link} href={`/api/asset-finance/entities/${panel.entityId}/documents/${s.scanDocumentId}`} target="_blank" rel="noopener noreferrer">
                            Scan
                          </a>
                        </>
                      )}
                    </td>
                    <td className="py-2">
                      {canManage && open && (s.state === "PENDING" || awaiting) ? (
                        <WetInkControls
                          dealId={dealId}
                          signerId={s.id}
                          docType={SIGNED_DOC_TYPE[s.document]}
                          scanDocumentId={s.scanDocumentId}
                          canUpload
                          canConfirm={awaiting && s.scanUploadedBy?.id !== userId}
                        />
                      ) : null}
                      {awaiting && s.scanUploadedBy?.id === userId && (
                        <p className="mt-1 text-xs text-[var(--cf-text-muted)]">You uploaded this scan; another user confirms it.</p>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {panel.signers.length > 0 && panel.missing.length > 0 && (
        <p className="mt-3 text-sm text-[var(--cf-danger)]">
          Required but not on the signer list (prepare the documents again before anyone signs, or ask legal how to proceed):{" "}
          {panel.missing.map((m) => `${m.name} (${DEAL_DOCUMENT_LABELS[m.document]})`).join(", ")}
        </p>
      )}
    </DataPanel>
  )
}
