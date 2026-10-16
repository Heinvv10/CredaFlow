/**
 * What an approver must see and answer before approving an asset-finance deal
 * (Fair Score audit E5, E6). Read on the deal page (credit memo) and again by
 * decideDeal inside its transaction, so the gate sees what the page showed.
 *
 *   INTERNAL ARREARS. The borrower (the entity, or the sole proprietor) or any
 *   active party of the entity (director, member, trustee, surety, authorised
 *   signatory, beneficial owner) has a loan with this lender that is in
 *   arrears (days or an amount overdue) or has defaulted (DEFAULTED,
 *   PENDING_WRITE_OFF, WRITTEN_OFF).
 *
 *   BUREAU CHECK NOT ON RECORD. A bureau check was run for a natural director
 *   or trustee of the entity and its latest attempt stored nothing current:
 *   it was skipped (consent missing, refused or withdrawn), failed, or the
 *   person's identity changed after it. A person never checked is not an
 *   exception here (the deal page lists them under "No bureau checks yet"):
 *   whether every approval needs the checks run is a credit-policy choice
 *   this module does not make. A juristic trustee gets no consumer check by
 *   design (./deal-bureau.ts) and is not listed.
 *
 * Each exception is one plain sentence with a stable key (ARREARS:<loanId>,
 * BUREAU:<clientId>). Approving with any of them needs an exception reason
 * bound to the fingerprint of the keys shown; the stored decision carries the
 * sentences, so a reason can never claim a check that was not made without
 * the record saying so, and the keys, which payout and booking compare against
 * (./deal-credit-gate.ts) so an exception arising after approval stops the
 * money (./deal-decision.ts).
 */
import { createHash } from "node:crypto"
import type { EntityRole, LoanStatus } from "@prisma/client"
import type { RegimeTx } from "./classification"
import { loadDealBureauResults, type BureauResultsDb, type DealBureauResult } from "./deal-bureau-results"
import { formatMoney } from "./format"
import { ENTITY_ROLE_LABELS, statusLabel } from "./labels"

export type DealExceptionsDb = BureauResultsDb & Pick<RegimeTx, "entityRelationship" | "loan">

export interface InternalArrears {
  clientId: string | null
  party: string
  roles: string[]
  loanId: string
  reference: string
  status: LoanStatus
  daysInArrears: number
  arrearsCents: number
}

export interface DealExceptions {
  internalArrears: InternalArrears[]
  /** One sentence per exception, internal arrears first. */
  lines: string[]
  /** The exceptions' stable keys, in the order of `lines`. */
  keys: string[]
  /** sha256 of the sorted keys: what an exception reason answers. */
  fingerprint: string
}

const PARTY_ROLES: EntityRole[] = ["DIRECTOR", "MEMBER", "TRUSTEE", "SURETY", "AUTHORISED_SIGNATORY", "BENEFICIAL_OWNER"]

export function exceptionsFingerprint(keys: string[]): string {
  return createHash("sha256").update(JSON.stringify([...keys].sort())).digest("hex")
}
const DEFAULTED: LoanStatus[] = ["DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF"]
const OPEN_OR_DEFAULTED: LoanStatus[] = ["ACTIVE", "RESTRUCTURED", ...DEFAULTED]

const SKIP_REASONS: Record<string, string> = {
  CONSENT_MISSING: "no bureau consent on record",
  CONSENT_REFUSED: "bureau consent refused",
  CONSENT_WITHDRAWN: "bureau consent withdrawn",
}

function bureauGap(latest: DealBureauResult | undefined): string | null {
  if (!latest) return null
  switch (latest.outcome) {
    case "stored":
      return null
    case "skipped":
      return `the bureau check was skipped (${(latest.detail && SKIP_REASONS[latest.detail]) ?? latest.detail ?? "no reason recorded"})`
    case "stale":
      return "the person's identity changed after the bureau check"
    case "failed":
      return `the bureau check failed${latest.detail ? ` (${latest.detail})` : ""}`
  }
}

export async function loadDealExceptions(
  db: DealExceptionsDb,
  tenantId: string,
  deal: { applicationId: string; entityId: string | null; clientId: string | null },
): Promise<DealExceptions> {
  const people = deal.entityId === null ? [] : await db.entityRelationship.findMany({
    where: { tenantId, entityId: deal.entityId, active: true, role: { in: PARTY_ROLES } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { clientId: true, role: true, trusteeKind: true, client: { select: { firstName: true, lastName: true } } },
  })
  const parties = new Map<string, { name: string; roles: string[] }>()
  for (const p of people) {
    const party = parties.get(p.clientId) ?? { name: `${p.client.firstName} ${p.client.lastName}`, roles: [] }
    party.roles.push(ENTITY_ROLE_LABELS[p.role])
    parties.set(p.clientId, party)
  }
  const clientIds = [...parties.keys(), ...(deal.clientId ? [deal.clientId] : [])]
  const loans = await db.loan.findMany({
    where: {
      tenantId,
      status: { in: OPEN_OR_DEFAULTED },
      OR: [
        ...(clientIds.length > 0 ? [{ clientId: { in: clientIds } }] : []),
        ...(deal.entityId ? [{ entityId: deal.entityId }] : []),
      ],
    },
    orderBy: [{ daysInArrears: "desc" }, { reference: "asc" }],
    select: {
      id: true, reference: true, status: true, daysInArrears: true, arrearsAmount: true, clientId: true, entityId: true,
      client: { select: { firstName: true, lastName: true } }, entity: { select: { legalName: true } },
    },
  })
  const internalArrears: InternalArrears[] = loans
    .filter((l) => DEFAULTED.includes(l.status) || l.daysInArrears > 0 || l.arrearsAmount > 0)
    .map((l) => {
      const party = l.clientId ? parties.get(l.clientId) : undefined
      const borrower = l.entityId ? l.entity?.legalName : l.client && `${l.client.firstName} ${l.client.lastName}`
      return {
        clientId: l.clientId,
        party: party?.name ?? borrower ?? "The borrower",
        roles: party?.roles ?? ["Borrower"],
        loanId: l.id,
        reference: l.reference,
        status: l.status,
        daysInArrears: l.daysInArrears,
        arrearsCents: l.arrearsAmount,
      }
    })

  const keys = internalArrears.map((a) => `ARREARS:${a.loanId}`)
  const lines = internalArrears.map((a) =>
    `${a.party} (${a.roles.join(", ")}) has loan ${a.reference} with this lender: ${statusLabel(a.status)}, ` +
    `${a.daysInArrears} days in arrears, ${formatMoney(a.arrearsCents)} overdue`)

  const subjects = people.filter((p) => (p.role === "DIRECTOR" || p.role === "TRUSTEE") && p.trusteeKind !== "JURISTIC")
  if (subjects.length > 0) {
    const results = await loadDealBureauResults(tenantId, deal.applicationId, db)
    const seen = new Set<string>()
    for (const s of subjects) {
      if (seen.has(s.clientId)) continue
      seen.add(s.clientId)
      // Results are newest first: the person's latest attempt decides.
      const gap = bureauGap(results.find((r) => r.clientId === s.clientId))
      const party = parties.get(s.clientId)
      if (gap && party) {
        lines.push(`${party.name} (${party.roles.join(", ")}): ${gap}`)
        keys.push(`BUREAU:${s.clientId}`)
      }
    }
  }
  return { internalArrears, lines, keys, fingerprint: exceptionsFingerprint(keys) }
}
