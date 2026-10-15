import { screenBuyer, type ScreeningBuyer, type ScreeningCandidates } from "./recovery-screening"
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
    ? { kind: "BORROWER", names: [personNames(loan.client)], people: [personNames(loan.client)], identifiers: [loan.client.idNumber] }
    : { kind: "BORROWER", names: [loan?.entity?.legalName, loan?.entity?.tradingName].filter((n): n is string => !!n), identifiers: loan?.entity ? [loan.entity.registrationNumber] : [] }
  return [
    borrower,
    { kind: "RELATED_PARTY", names: related.map(personNames), people: related.map(personNames), identifiers: related.map((p) => p.idNumber) },
    { kind: "STAFF", names: staff.flatMap((u) => (u.name ? [u.name] : [])), people: staff.flatMap((u) => (u.name ? [u.name] : [])), identifiers: [] },
    { kind: "COI_DECLARATION", names: [], identifiers: [], freeText: declarations.flatMap((d) => (d.details ? [d.details] : [])) },
  ]
}

/**
 * Whether the acting staff member screens as the buyer: their own name, or any
 * conflict declaration of theirs (any year) naming the buyer. Nobody proposes,
 * approves or completes the sale of an asset to themselves.
 */
export async function actorIsBuyer(tx: SigningTx, tenantId: string, userId: string, buyer: ScreeningBuyer): Promise<boolean> {
  const user = await tx.user.findFirst({ where: { id: userId, tenantId }, select: { name: true } })
  const declarations = await tx.coiDeclaration.findMany({ where: { tenantId, userId }, select: { details: true } })
  return screenBuyer(buyer, [
    { kind: "STAFF", names: user?.name ? [user.name] : [], people: user?.name ? [user.name] : [], identifiers: [] },
    { kind: "COI_DECLARATION", names: [], identifiers: [], freeText: declarations.flatMap((d) => (d.details ? [d.details] : [])) },
  ]).match
}
