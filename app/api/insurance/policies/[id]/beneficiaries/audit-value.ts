/**
 * What an audit row records about a beneficiary.
 *
 * A beneficiary is the most PII-dense row in the module: it carries an
 * `idNumber` and a `dateOfBirth`. The audit trail exists to prove WHO changed
 * WHAT — not to copy POPIA identifiers into a second store that has its own
 * retention, its own access path, and (per the AuditLog immutability work) no
 * deletion route. So identity is recorded by the beneficiary's own id plus the
 * non-sensitive fields an auditor needs to recognise the row, and the two
 * sensitive columns are deliberately dropped.
 *
 * Presence is still recorded — `hadIdNumber` tells an auditor an identifier
 * existed on the destroyed row without reproducing it.
 *
 * This is a whitelist, not a blacklist: it names the fields that go in, so a
 * column added to InsuranceBeneficiary later cannot leak into AuditLog by
 * simply existing.
 */
export function beneficiaryAuditValue(beneficiary: {
  id: string
  policyId: string
  firstName: string
  lastName: string
  relationship: string
  idNumber: string | null
  dateOfBirth: Date | null
  coverAmount: unknown
}): Record<string, unknown> {
  return {
    id: beneficiary.id,
    policyId: beneficiary.policyId,
    firstName: beneficiary.firstName,
    lastName: beneficiary.lastName,
    relationship: beneficiary.relationship,
    coverAmount: beneficiary.coverAmount == null ? null : Number(beneficiary.coverAmount),
    hadIdNumber: beneficiary.idNumber != null,
    hadDateOfBirth: beneficiary.dateOfBirth != null,
  }
}
