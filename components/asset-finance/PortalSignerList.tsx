import Link from "next/link"
import { StatusPill } from "@/components/app-shell/StatusPill"
import type { PortalSignerView } from "@/lib/asset-finance/signing-view"
import { DEAL_DOCUMENT_LABELS, SIGNER_STATE_LABELS } from "@/lib/asset-finance/signing"

/** A portal client's own deal documents: what to sign and what is signed. */
export function PortalSignerList({ signers, showEntity }: { signers: PortalSignerView[]; showEntity: boolean }) {
  if (signers.length === 0) return <p className="text-sm text-[var(--cf-text-muted)]">Nothing is waiting for your signature.</p>
  return (
    <ul className="divide-y divide-[var(--cf-border-subtle)]">
      {signers.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
          <div>
            <p className="font-medium text-[var(--cf-text)]">{DEAL_DOCUMENT_LABELS[s.document]}</p>
            <p className="text-xs text-[var(--cf-text-muted)]">{showEntity ? `${s.entityName} · ` : ""}agreement {s.dealReference}</p>
          </div>
          {s.canSign ? (
            <Link href={`/portal/sign/deal-signers/${s.id}`} className="rounded-md bg-[var(--cf-brand)] px-3 py-1.5 text-xs font-semibold text-[var(--cf-on-brand)]">
              Read and sign
            </Link>
          ) : (
            <Link href={`/portal/sign/deal-signers/${s.id}`}>
              <StatusPill tone={s.state === "SIGNED" || s.state === "CONFIRMED" ? "success" : "warning"}>{SIGNER_STATE_LABELS[s.state]}</StatusPill>
            </Link>
          )}
        </li>
      ))}
    </ul>
  )
}
