import type { ScreeningCandidates } from "./recovery-screening"
import type { SigningTx } from "./signing-prepare"

// Loads the lists a remarketing buyer is screened against (recovery-screening.ts
// does the comparing): the borrower, the deal's related clients (every
// entity relationship, sureties included, and every deal signer), the tenant's
// active staff, and this year's COI declarations that report a conflict.
// The database repeats the ID/registration part of the borrower and related-
// client checks (guardRemarketingSale), so a miss here is not the last line.
// UNTESTED: compliance sign-off on the screened lists.

interface PersonName { firstName: string; lastName: string; idNumber: string }

const personNames = (p: PersonName) => `${p.firstName} ${p.lastName}`

export async function loadScreeningCandidates(tx: SigningTx, tenantId: string, loanId: string, year: number): Promise<ScreeningCandidates[]> {
  const person = { select: { firstName: true, lastName: true, idNumber: true } } as const
  const loan = await tx.loan.findFirst({
    where: { id: loanId, tenantId },
    select: {
      client: person,
      entity: { select: { legalName: true, tradingName: true, registrationNumber: true, relationships: { select: { client: person } } } },
    },
  })
  const deal = await tx.assetFinanceDeal.findFirst({
    where: { tenantId, loanId },
    select: { client: person, signers: { select: { client: person } } },
  })
  const staff = await tx.user.findMany({ where: { tenantId, active: true }, select: { name: true } })
  const declarations = await tx.coiDeclaration.findMany({ where: { tenantId, year, hasConflict: true }, select: { details: true } })

  const related: PersonName[] = [
    ...(loan?.entity?.relationships.map((r) => r.client) ?? []),
    ...(deal?.client ? [deal.client] : []),
    ...(deal?.signers.map((s) => s.client) ?? []),
  ]
  const borrower: ScreeningCandidates = loan?.client
    ? { kind: "BORROWER", names: [personNames(loan.client)], identifiers: [loan.client.idNumber] }
    : { kind: "BORROWER", names: [loan?.entity?.legalName, loan?.entity?.tradingName].filter((n): n is string => !!n), identifiers: loan?.entity ? [loan.entity.registrationNumber] : [] }
  return [
    borrower,
    { kind: "RELATED_PARTY", names: related.map(personNames), identifiers: related.map((p) => p.idNumber) },
    { kind: "STAFF", names: staff.flatMap((u) => (u.name ? [u.name] : [])), identifiers: [] },
    { kind: "COI_DECLARATION", names: [], identifiers: [], freeText: declarations.flatMap((d) => (d.details ? [d.details] : [])) },
  ]
}
