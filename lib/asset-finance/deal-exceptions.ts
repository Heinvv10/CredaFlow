/**
 * What an approver must see and answer before approving an asset-finance deal
 * (Fair Score audit E5, E6). Read on the deal page (credit memo) and again by
 * decideDeal inside its transaction, so the gate sees what the page showed.
 *
 *   INTERNAL ARREARS. The borrower (the entity, or the sole proprietor) or any
 *   active party of the entity (director, member, trustee, surety, authorised
 *   signatory, beneficial owner) has a loan with this lender that is in
 *   arrears (days or an amount overdue) or has defaulted (DEFAULTED,
 *   PENDING_WRITE_OFF, WRITTEN_OFF). A party removed from the entity within
 *   FORMER_PARTY_LOOKBACK_MONTHS counts too ("former director, removed
 *   <date>"), so a defaulting party cannot be stepped off before submission.
 *   The removal date is the inactive row's updatedAt (the deactivation; a
 *   later edit of an inactive row only lengthens the window).
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
 * BUREAU:<clientId>) and its severity (./deal-exception-severity.ts).
 * Approving with any of them needs an exception reason bound to the
 * fingerprint of what was shown; the stored decision carries the sentences,
 * so a reason can never claim a check that was not made without the record
 * saying so, and the recorded severities, which payout and booking compare
 * against (./deal-credit-gate.ts) so an exception that is new or worse
 * since approval stops the money (./deal-decision.ts).
 */
import type { EntityRole, LoanStatus } from "@prisma/client"
import type { RegimeTx } from "./classification"
import { loadDealBureauResults, type BureauResultsDb, type DealBureauResult } from "./deal-bureau-results"
import { formatMoney } from "./format"
import { ENTITY_ROLE_LABELS, statusLabel } from "./labels"
import { exceptionsFingerprint, type RecordedException } from "./deal-exception-severity"
import { formatDate } from "@/lib/utils"

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
  /** Each exception's key and severity, in the order of `lines`: what an approval records. */
  recorded: RecordedException[]
  /** What an exception reason answers (exceptionsFingerprint of `recorded`). */
  fingerprint: string
}

const PARTY_ROLES: EntityRole[] = ["DIRECTOR", "MEMBER", "TRUSTEE", "SURETY", "AUTHORISED_SIGNATORY", "BENEFICIAL_OWNER"]

/** How far back a removed party is still cross-checked (policy, Fair Score review of #151; Hein to confirm). */
export const FORMER_PARTY_LOOKBACK_MONTHS = 12

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
  /** `loanId` is the loan the deal itself booked: it is this deal's own exposure, not an existing one. */
  deal: { applicationId: string; entityId: string | null; clientId: string | null; loanId?: string | null },
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
  // Parties removed within the lookback, unless still active in another role.
  const since = new Date()
  since.setMonth(since.getMonth() - FORMER_PARTY_LOOKBACK_MONTHS)
  const removed = deal.entityId === null ? [] : await db.entityRelationship.findMany({
    where: { tenantId, entityId: deal.entityId, active: false, role: { in: PARTY_ROLES }, updatedAt: { gte: since } },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    select: { clientId: true, role: true, updatedAt: true, client: { select: { firstName: true, lastName: true } } },
  })
  for (const p of removed) {
    if (parties.has(p.clientId) && !parties.get(p.clientId)?.roles.some((r) => r.startsWith("former "))) continue
    const party = parties.get(p.clientId) ?? { name: `${p.client.firstName} ${p.client.lastName}`, roles: [] }
    party.roles.push(`former ${ENTITY_ROLE_LABELS[p.role].toLowerCase()}, removed ${formatDate(p.updatedAt)}`)
    parties.set(p.clientId, party)
  }
  const clientIds = [...parties.keys(), ...(deal.clientId ? [deal.clientId] : [])]
  const loans = await db.loan.findMany({
    where: {
      tenantId,
      status: { in: OPEN_OR_DEFAULTED },
      ...(deal.loanId ? { id: { not: deal.loanId } } : {}),
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

  const recorded: RecordedException[] = internalArrears.map((a) => ({
    key: `ARREARS:${a.loanId}`, kind: "ARREARS", status: a.status, daysInArrears: a.daysInArrears, arrearsCents: a.arrearsCents,
  }))
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
      const latest = results.find((r) => r.clientId === s.clientId)
      const gap = bureauGap(latest)
      const party = parties.get(s.clientId)
      if (gap && party && latest) {
        lines.push(`${party.name} (${party.roles.join(", ")}): ${gap}`)
        recorded.push({ key: `BUREAU:${s.clientId}`, kind: "BUREAU", outcome: `${latest.outcome}:${latest.detail ?? ""}` })
      }
    }
  }
  return { internalArrears, lines, keys: recorded.map((r) => r.key), recorded, fingerprint: exceptionsFingerprint(recorded) }
}
