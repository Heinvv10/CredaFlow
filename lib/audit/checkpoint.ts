/**
 * Daily checkpoints: a signed note of a chain's head as the verifier walked it. The
 * verifier starts from the latest one, and each is queued to the lender's SIEM (by
 * audit_checkpoint_write), so a copy of the head exists outside the database.
 */
import type { PrismaClient } from "@prisma/client"
import { checkpointHmac } from "./chain-hash"
import type { ChainVerification } from "./chain-verify"
import { writeCheckpoint } from "./store"

/**
 * Signs exactly the (seq, rowHash) the verification checked, for each chain that passed; it
 * does not re-read the head. The database confirms the link at that seq still has that
 * hash and refuses otherwise, so a link swapped after the walk is not blessed. Returns how
 * many checkpoints were written (a chain whose head did not move since its last one writes none).
 */
export async function writeCheckpoints(db: PrismaClient, verified: ChainVerification["verifiedHeads"]): Promise<number> {
  let written = 0
  for (const { chainKey, seq, rowHash } of verified) {
    if (await writeCheckpoint(db, chainKey, seq, rowHash, checkpointHmac(chainKey, seq, rowHash))) written++
  }
  return written
}
