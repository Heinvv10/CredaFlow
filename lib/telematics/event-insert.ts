/**
 * The telematics event row, inserted ON CONFLICT DO NOTHING on (tenant,
 * provider, provider event id), and the agreement covering an instant
 * (docs/asset-finance/SLICE5.md part B). A raw insert, so a refusal carries
 * its SQLSTATE in a structured field (`meta.code` of P2010), never parsed out
 * of a message: only this statement's refusals for what the event itself is
 * (its guard and CHECKs, a byte or number its column cannot hold) are the
 * poll's permanent rejections (TelematicsEventRejected); anything later in
 * the event's transaction is a failure worth retrying.
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import type { SigningTx } from "@/lib/asset-finance/signing-prepare"
import { TelematicsEventRejected } from "./event-shape"
import type { NormalisedTelematicsEvent } from "./types"

/** SQLSTATEs the event insert raises only for the event itself: its guard or a CHECK (23514), a NUL or untranslatable byte, a number or text too large. */
const EVENT_INTRINSIC = new Set(["23514", "22021", "22P05", "22003", "22001"])

/** The SQLSTATE and the database's message of a raw statement's refusal (P2010 `meta`), or null. */
export function rawSqlState(error: unknown): { code: string; message: string } | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2010") return null
  const meta = error.meta as { code?: unknown; message?: unknown } | undefined
  return typeof meta?.code === "string" ? { code: meta.code, message: typeof meta.message === "string" ? meta.message : "" } : null
}

/** The instant as the database's timestamp(3) columns hold it (UTC). */
const utc = (at: Date) => Prisma.sql`(${at.toISOString()}::timestamptz AT TIME ZONE 'UTC')`

/** The ACTIVE, DEFAULTED or PENDING_WRITE_OFF loan whose tenure of the asset covers `at` (the database's telematicsLoanAt), or null. */
export async function loanCovering(tx: SigningTx, tenantId: string, assetId: string, at: Date): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ loanId: string | null }[]>`SELECT public."telematicsLoanAt"(${tenantId}, ${assetId}, ${utc(at)}) AS "loanId"`
  return row?.loanId ?? null
}

/** Inserts the event; null for a duplicate. Throws TelematicsEventRejected when the database refuses the event itself. */
export async function insertEvent(
  tx: SigningTx, device: { id: string; tenantId: string; provider: string }, event: NormalisedTelematicsEvent, simulated: boolean,
): Promise<string | null> {
  try {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "TelematicsEvent" ("id", "tenantId", "deviceId", "provider", "providerEventId", "kind", "occurredAt",
        "meterValue", "meterUnit", "ignitionOn", "alertKind", "simulated")
      VALUES (${randomUUID()}, ${device.tenantId}, ${device.id}, ${device.provider}, ${event.providerEventId}, ${event.kind}::"TelematicsEventKind", ${utc(event.occurredAt)},
        ${event.meter?.value ?? null}::integer, ${event.meter?.unit ?? null}::"UsageUnit", ${event.ignitionOn ?? null}::boolean,
        ${event.alert ?? null}::"TelematicsAlertKind", ${simulated})
      ON CONFLICT ("tenantId", "provider", "providerEventId") DO NOTHING
      RETURNING "id"`
    return row?.id ?? null
  } catch (error) {
    const refusal = rawSqlState(error)
    if (refusal && EVENT_INTRINSIC.has(refusal.code)) {
      throw new TelematicsEventRejected(`database refused the event (${refusal.code}): ${refusal.message.replace(/^ERROR: /, "").slice(0, 300)}`)
    }
    throw error
  }
}
