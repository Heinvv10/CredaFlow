import { Prisma } from "@prisma/client"

export interface Section129Addressee {
  displayName: string
  firstName: string
  lastName: string
  identityNumber: string
  identityLabel: "ID" | "Registration no."
  addressLine1: string | null
  city: string | null
  email: string
  lockClientId: string
  lockEntityId: string | null
}

interface Borrower {
  clientId: string | null
  entityId: string | null
  client: null | {
    firstName: string
    lastName: string
    idNumber: string
    addressLine1: string | null
    city: string | null
    email: string
  }
  entity: null | {
    legalName: string
    registrationNumber: string
    addressLine1: string | null
    city: string | null
    relationships: Array<{
      client: { id: string; email: string; deceasedAt: Date | null }
    }>
  }
}

/** Resolve the immutable notice addressee and the authorised delivery contact. */
export function section129Addressee(borrower: Borrower): Section129Addressee | null {
  if (borrower.clientId && borrower.client) return {
    displayName: `${borrower.client.firstName} ${borrower.client.lastName}`,
    firstName: borrower.client.firstName,
    lastName: borrower.client.lastName,
    identityNumber: borrower.client.idNumber,
    identityLabel: "ID",
    addressLine1: borrower.client.addressLine1,
    city: borrower.client.city,
    email: borrower.client.email,
    lockClientId: borrower.clientId,
    lockEntityId: null,
  }
  const contact = borrower.entity?.relationships.find((row) => row.client.deceasedAt === null)?.client
  if (!borrower.entityId || !borrower.entity || !contact) return null
  return {
    displayName: borrower.entity.legalName,
    firstName: borrower.entity.legalName,
    lastName: "",
    identityNumber: borrower.entity.registrationNumber,
    identityLabel: "Registration no.",
    addressLine1: borrower.entity.addressLine1,
    city: borrower.entity.city,
    email: contact.email,
    lockClientId: contact.id,
    lockEntityId: borrower.entityId,
  }
}

export const SECTION129_BORROWER_INCLUDE = Prisma.validator<Prisma.LoanInclude>()({
  client: true,
  entity: { select: {
    legalName: true, registrationNumber: true, addressLine1: true, city: true,
    relationships: {
      where: { active: true, role: { in: ["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"] } },
      orderBy: [{ clientId: "asc" }, { role: "asc" }],
      select: { client: { select: { id: true, email: true, deceasedAt: true } } },
    },
  } },
})
