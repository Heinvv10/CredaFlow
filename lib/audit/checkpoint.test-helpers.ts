import type { PrismaClient } from "@prisma/client"
import { verifyAuditChains } from "./chain-verify"
import { writeCheckpoints } from "./checkpoint"

/** What the daily job does for one chain: walk it, then sign what the walk checked. Returns checkpoints written. */
export async function checkpointNow(db: PrismaClient, chainKey: string): Promise<number> {
  const result = await verifyAuditChains(db, { chainKey, mode: "full" })
  return writeCheckpoints(db, result.verifiedHeads)
}
