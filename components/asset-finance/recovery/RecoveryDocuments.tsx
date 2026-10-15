import type { StaffRecovery } from "./recovery-panel-data"
import { isNcaRoute } from "./recovery-model"

const link = "text-[var(--cf-text-secondary)] underline underline-offset-2 hover:text-[var(--cf-text)]"

/** The notices and statement a recovery has produced (each read is logged by the route). */
export function RecoveryDocuments({ view }: { view: StaffRecovery }) {
  const nca = isNcaRoute(view.route)
  const docs = [
    nca && view.notices.valuationIssued ? { kind: "valuation", label: "Valuation notice (draft)" } : null,
    nca && view.notices.finalIssued ? { kind: "final", label: "Final notice (draft)" } : null,
    !nca && view.figures?.netProceedsCents != null ? { kind: "statement", label: "Post-sale account statement" } : null,
  ].filter((doc): doc is { kind: string; label: string } => doc !== null)
  if (docs.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">No notice or statement has been produced yet.</p>
  return (
    <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
      {docs.map((doc) => (
        <li key={doc.kind}>
          <a className={link} href={`/api/asset-finance/recoveries/${view.id}/documents/${doc.kind}`} target="_blank" rel="noopener noreferrer">{doc.label}</a>
          {" · "}
          <a className={link} href={`/api/asset-finance/recoveries/${view.id}/documents/${doc.kind}?download=1`}>Download</a>
        </li>
      ))}
    </ul>
  )
}
