import { accountControlRefusal } from "@/lib/security/account-control"
import type { RecoveryActor } from "./recovery-create"
import { RecoveryRefusal } from "./recovery-result"
import type { SigningTx } from "./signing-prepare"

/** The shared two-people rule (lib/security/account-control.ts) for a recovery's approving acts: refused like any other recovery rule. */
export async function requireTwoPeople(tx: SigningTx, actor: RecoveryActor, makerIds: ReadonlyArray<string | null>): Promise<void> {
  const controlled = await accountControlRefusal(tx, { tenantId: actor.tenantId, makerIds, checkerId: actor.userId })
  if (controlled) throw new RecoveryRefusal(controlled)
}
