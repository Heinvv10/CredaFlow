import { formatDateTime } from "@/lib/utils"
import type { DealerCapturedPerson } from "@/lib/dealer/staff-deal-panel"
import { DealActionButton } from "./DealActionButton"

const name = (p: { name: string | null; email: string } | null) => (p ? (p.name ?? p.email) : "—")

/**
 * The people on a deal a dealer captured, each with its contact details and
 * the staff "verified" action (lib/dealer/contact-verification.ts). Until
 * then nothing is sent to them and the deal is not booked. On a dealer deal's
 * panel, and on a staff deal whose borrower a dealer captured.
 */
export function DealerCapturedPeople({ dealId, people, canManage }: { dealId: string; people: DealerCapturedPerson[]; canManage: boolean }) {
  return (
    <section className="space-y-2">
      <h3 className="font-semibold text-[var(--cf-text)]">Contacts a dealer captured</h3>
      {people.length === 0 && <p className="text-[var(--cf-text-muted)]">None.</p>}
      {people.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--cf-border-subtle)] p-2">
          <p>{p.firstName} {p.lastName} · {p.email} · {p.phone}</p>
          {p.dealerContactVerifiedAt ? (
            <span className="text-xs text-[var(--cf-success)]">Contact verified by {name(p.dealerContactVerifiedBy)} {formatDateTime(p.dealerContactVerifiedAt)}</span>
          ) : canManage ? (
            <DealActionButton url={`/api/asset-finance/deals/${dealId}/dealer-people/${p.id}/verify-contact`} label="Contact details verified" busyLabel="Recording…" variant="outline" />
          ) : <span className="text-xs text-[var(--cf-warning)]">Contact not verified</span>}
        </div>
      ))}
      <p className="text-xs text-[var(--cf-text-muted)]">
        A dealer typed these details. Confirm them with the person directly, not through the dealer: until then no portal activation, reset or signing code is sent to them and the deal cannot be booked.
      </p>
    </section>
  )
}
