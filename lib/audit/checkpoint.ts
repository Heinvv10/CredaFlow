/**
 * Daily checkpoints: a signed note of each verified chain's head. The verifier
 * starts from the latest one, and each is queued to the lender's SIEM, so a copy
 * of the head exists outside the database.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { checkpointHmac, PLATFORM_CHAIN } from "./chain-hash"

/** Writes a checkpoint for each chain in `keys` whose head moved since its last one. Returns how many. */
export async function writeCheckpoints(db: PrismaClient, keys: readonly string[]): Promise<number> {
  let written = 0
  for (const key of keys) {
    const made = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const [head] = await tx.$queryRaw<Array<{ seq: number; rowHash: string }>>`
        SELECT "seq", "rowHash" FROM "AuditChainLink" WHERE "chainKey" = ${key} ORDER BY "seq" DESC LIMIT 1`
      if (!head) return false
      const [last] = await tx.$queryRaw<Array<{ seq: number }>>`
        SELECT "seq" FROM "AuditChainCheckpoint" WHERE "chainKey" = ${key} ORDER BY "seq" DESC LIMIT 1`
      if (last && last.seq >= head.seq) return false
      const tenantId = key === PLATFORM_CHAIN ? null : key
      const id = `cp_${crypto.randomUUID().replaceAll("-", "")}`
      await tx.$executeRaw`
        INSERT INTO "AuditChainCheckpoint" ("id", "chainKey", "tenantId", "seq", "rowHash", "hmac")
        VALUES (${id}, ${key}, ${tenantId}, ${head.seq}, ${head.rowHash}, ${checkpointHmac(key, head.seq, head.rowHash)})`
      if (tenantId) {
        await tx.$executeRaw`
          INSERT INTO "AuditSiemOutbox" ("tenantId", "kind", "checkpointId", "seq")
          SELECT ${tenantId}, 'CHECKPOINT', ${id}, ${head.seq} FROM "AuditPolicy" WHERE "tenantId" = ${tenantId} AND "siemEnabled"`
      }
      return true
    })
    if (made) written++
  }
  return written
}
