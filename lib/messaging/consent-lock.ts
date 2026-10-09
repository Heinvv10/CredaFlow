type ConsentLockTx = {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>
}

/**
 * Serialize an eligibility decision with every ContactConsent writer.
 * Contact always exists before a consent row can exist, so this lock also
 * protects the first grant/revocation where a ContactConsent row lock cannot.
 */
export async function lockContactConsentSubject(
  tx: ConsentLockTx,
  args: { tenantId: string; contactId: string },
): Promise<void> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "Contact"
       WHERE id = $1 AND "tenantId" = $2
       FOR UPDATE`,
    args.contactId,
    args.tenantId,
  )
  if (rows.length !== 1) {
    throw new Error("Consent subject contact not found in tenant")
  }
}
