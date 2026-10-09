// The push to Experian. NOT BUILT: Experian has not confirmed a channel
// (SFTP or API, folder, key, PGP, file extension). Do not invent a transport.
// Until one exists a submission stays GENERATED and staff download it.

export type PushOutcome = "NOT_CONFIGURED"

/**
 * Whether a transport exists. While it does not, the scheduled job refuses
 * LIVE mode: a LIVE ledger row means "the bureau was told this", and a file
 * nothing delivers would use up closures that can then never be sent.
 */
export function pushConfigured(): boolean {
  return false
}

export async function pushSubmission(_submissionId: string): Promise<PushOutcome> {
  return "NOT_CONFIGURED"
}
