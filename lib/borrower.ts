/**
 * A loan or application has exactly one borrower: a natural-person `Client`
 * (`clientId`) or a juristic `BusinessEntity` (`entityId`, asset finance).
 * The database enforces it (CHECK `Loan_borrower_xor`,
 * `LoanApplication_borrower_xor`).
 *
 * Consumer paths (PASQ, credit agreement, debit mandate, s129, affordability,
 * consumer bureau) only make sense for a `Client`. They call
 * `requireClientBorrower` / `requireClientBorrowerId`, which narrow the type and
 * refuse an entity borrower with `EntityBorrowerError`. Never silence a null
 * `client` with a non-null assertion: an entity row would crash at run time
 * instead of being refused.
 */

export class EntityBorrowerError extends Error {
  readonly status = 409

  constructor(message = "This action applies to individual (consumer) borrowers only; this record's borrower is a business entity") {
    super(message)
    this.name = "EntityBorrowerError"
  }
}

/** The row's `Client`, or `EntityBorrowerError` when the borrower is an entity. */
export function requireClientBorrower<C>(row: { client: C | null }): C {
  if (row.client === null) throw new EntityBorrowerError()
  return row.client
}

/** The row's `clientId`, or `EntityBorrowerError` when the borrower is an entity. */
export function requireClientBorrowerId(row: { clientId: string | null }): string {
  if (row.clientId === null) throw new EntityBorrowerError()
  return row.clientId
}

export function isEntityBorrowerError(error: unknown): error is EntityBorrowerError {
  return error instanceof EntityBorrowerError
}

interface NamedBorrower {
  client?: { firstName: string; lastName: string } | null
  entity?: { legalName: string } | null
}

/** Display name for lists, reports and statements: the person or the entity. */
export function borrowerDisplayName(row: NamedBorrower): string {
  if (row.client) return `${row.client.firstName} ${row.client.lastName}`.trim()
  if (row.entity) return row.entity.legalName
  return "Unknown borrower"
}
