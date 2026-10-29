import type { ChangeRequest } from "@prisma/client"
import type { prisma } from "@/lib/prisma"

/** The transaction client of the app's (tenant-scoped) Prisma client. */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** The signed-in staff user making a call (a StaffUser fits). */
export interface Actor {
  id: string
  email: string
  role: string
}

export interface ApplyContext<P> {
  tenantId: string
  request: ChangeRequest
  payload: P
  checker: Actor
  now: Date
}

/**
 * One kind of change. A consumer (decision rules, product versions, approval
 * matrix, ...) writes one handler and adds it to ./handlers.ts; the service,
 * the routes and the database rules are shared. See .claude.md.
 */
export interface ChangeHandler<P = unknown> {
  /** UPPER_SNAKE, 3-60 chars (CHECK ChangeRequest_kind); also the audit tag. */
  kind: string
  /** Shown in lists: "Decision rule set". */
  label: string
  /** Permission keys (lib/registry/permissions/) for drafting/submitting and for approving/rejecting. */
  makePermission: string
  approvePermission: string
  /**
   * Validates untrusted JSON and returns the normalised payload that is
   * stored and later applied. Pure. Throws InvalidPayloadError.
   */
  parse(raw: unknown): P
  /**
   * Checks that need the database (a referenced product exists, the delegate is
   * a staff user). Runs on submit and again inside the approval transaction,
   * just before apply. Throws InvalidPayloadError.
   */
  verify?(tx: Tx, tenantId: string, payload: P): Promise<void>
  /**
   * Makes the change. Runs inside the approval transaction, after the request
   * is marked APPROVED: any throw rolls the approval back too. Write audit
   * rows for what changed with the same `tx`.
   */
  apply(tx: Tx, ctx: ApplyContext<P>): Promise<void>
}
