import { RecoveryRefusal } from "./recovery-result"
export function ncaRemittanceDisposition(account: { approvedById: string | null; releaseAuthorisedById: string | null } | null) {
  if (!account?.approvedById) return "HELD_NO_VERIFIED_ACCOUNT" as const
  if (!account.releaseAuthorisedById) throw new RecoveryRefusal("Authorise the surplus release before issuing the final notice")
  return "INSTRUCTED" as const
}
