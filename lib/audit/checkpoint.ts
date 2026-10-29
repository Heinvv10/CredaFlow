/**
 * Daily checkpoints: a signed note of each verified chain's head. The verifier
 * starts from the latest one, and each is queued to the lender's SIEM (by
 * audit_checkpoint_write), so a copy of the head exists outside the database.
 */
import type { PrismaClient } from "@prisma/client"
import { checkpointHmac } from "./chain-hash"
import { chainHead, writeCheckpoint } from "./store"

/** Writes a checkpoint for each chain in `keys` whose head moved since its last one. Returns how many. */
export async function writeCheckpoints(db: PrismaClient, keys: readonly string[]): Promise<number> {
  let written = 0
  for (const key of keys) {
    const head = await chainHead(db, key)
    if (!head) continue
    if (await writeCheckpoint(db, key, head.seq, head.rowHash, checkpointHmac(key, head.seq, head.rowHash))) written++
  }
  return written
}
