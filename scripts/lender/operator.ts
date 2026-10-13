import { hostname, userInfo } from "node:os"

/**
 * Who ran a lender CLI, for the audit row. The wrappers run the CLIs in a
 * throwaway container, whose OS user and hostname say nothing, so they pass
 * the host operator in LENDER_OPERATOR. It is a record, not authentication:
 * whoever can run containers on the host is already the trust boundary.
 */
export function operatorId(env: Record<string, string | undefined> = process.env): string {
  return env.LENDER_OPERATOR?.trim() || `${userInfo().username}@${hostname()}`
}
