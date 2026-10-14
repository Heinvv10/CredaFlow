// The push to the bureau. LIVE is NOT BUILT: Experian has not confirmed a
// channel (SFTP or API, folder, key, PGP, file extension). Do not invent a
// transport. A TEST file can be delivered to a local outbox
// (BUREAU_SUBMISSION_TEST_OUTBOX, transport.ts) to exercise the path; with
// nothing configured a submission stays GENERATED and staff download it.
//
// Push never writes the ledger: the once-only statuses are decided when the
// LIVE rows are created (generate.ts), and a LIVE file is never pushed here.

import { AuditAction, logAudit } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"
import type { SubmissionMode } from "./layout"
import { renderSubmission, sha256Of } from "./render"
import { SubmissionTransportError, testTransportFromEnv, type SubmissionTransport } from "./transport"

export type PushOutcome =
  | "NOT_CONFIGURED"
  | "DELIVERED"
  /** The ledger no longer re-renders to the hash stored at generation, or a newer TEST file replaced it. */
  | "REFUSED"
  | "FAILED"

type Db = Pick<typeof prisma, "bureauSubmission" | "bureauSubmissionRecord">

/**
 * Whether a LIVE transport exists. While it does not, the scheduled job refuses
 * LIVE mode: a LIVE ledger row means "the bureau was told this", and a file
 * nothing delivers would use up closures that can then never be sent.
 */
export function pushConfigured(): boolean {
  return false
}

function transportFor(mode: SubmissionMode): SubmissionTransport | null {
  if (mode !== "TEST") return null
  const transport = testTransportFromEnv()
  return transport && transport.modes.includes(mode) ? transport : null
}

export async function pushSubmission(
  db: Db,
  args: { tenantId: string; submissionId: string; mode: SubmissionMode },
  resolveTransport: (mode: SubmissionMode) => SubmissionTransport | null = transportFor,
): Promise<PushOutcome> {
  let transport: SubmissionTransport | null
  try {
    transport = resolveTransport(args.mode)
  } catch (error) {
    if (error instanceof SubmissionTransportError) return "NOT_CONFIGURED"
    throw error
  }
  if (!transport) return "NOT_CONFIGURED"

  // Delivered bytes are the ledger's bytes or nothing (render.ts).
  const rendered = await renderSubmission(db, args.tenantId, args.submissionId)
  if (!rendered) return "NOT_CONFIGURED"
  const audit = (outcome: PushOutcome, extra: Record<string, unknown> = {}) => logAudit({
    tenantId: args.tenantId,
    action: AuditAction.BUREAU_SUBMISSION_PUSHED,
    entity: "BureauSubmission",
    entityId: args.submissionId,
    // Identifiers and counts only: never a line of the file.
    newValue: { outcome, mode: args.mode, transport: transport.id, fileName: rendered.fileName, recordCount: rendered.recordCount, ...extra },
  })
  if (!rendered.intact || rendered.superseded) {
    await audit("REFUSED", { intact: rendered.intact, superseded: rendered.superseded })
    return "REFUSED"
  }
  try {
    await transport.deliver({ fileName: rendered.fileName, content: rendered.content, sha256: sha256Of(rendered.content) })
  } catch (error) {
    // The ledger is already committed: a delivery failure is reported, not thrown.
    await audit("FAILED", { code: error instanceof SubmissionTransportError ? error.code : "UNEXPECTED" })
    return "FAILED"
  }
  await audit("DELIVERED")
  return "DELIVERED"
}
