import type { ChangeRequest } from "@prisma/client"
import type { prisma } from "@/lib/prisma"

/** The transaction client of the app's (tenant-scoped) Prisma client. */
export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** The signed-in staff user making a call (a StaffUser fits). */
export interface Actor {
  id: string
  email: string
  role: string
  /** This session's sign-in verified a TOTP code (StaffUser.totpVerified). */
  totpVerified?: boolean
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
 * matrix, ...) writes one handler and registers it in
 * lib/registry/change-handlers/; the service, the routes and the database
 * rules are shared. See .claude.md.
 */
export interface ChangeHandler<P = unknown> {
  /** UPPER_SNAKE, 3-60 chars (CHECK ChangeRequest_kind); also the audit tag. Must equal its registry key. */
  kind: string
  /** Shown in lists: "Decision rule set". */
  label: string
  /** Version of the payload format `parse` accepts; stored with each request. A request drafted under another version cannot be approved. Bump it when `parse` changes meaning. */
  payloadVersion: number
  /** Permission key (lib/registry/permissions/) for drafting, editing, submitting and withdrawing. */
  makePermission: string
  /**
   * A stronger permission for drafting, editing and submitting a high-risk payload (e.g. engine settings that go LIVE), on top of
   * `makePermission`. Optional; checked wherever the payload is known.
   */
  makePermissionFor?(payload: P): string
  /** Permission key for approving or rejecting; a function picks it from the payload (e.g. by amount). */
  approvePermission: string | ((payload: P) => string)
  /**
   * Validates untrusted JSON and returns the normalised payload that is
   * stored and later applied. Pure. Throws InvalidPayloadError.
   */
  parse(raw: unknown): P
  /**
   * Checks that need the database (a referenced product exists, a version is in
   * effect). Runs on submit and again inside the approval transaction, just
   * before apply. Throws InvalidPayloadError.
   */
  verify?(tx: Tx, tenantId: string, payload: P): Promise<void>
  /**
   * An opaque string naming the state the change is drafted against (the
   * latest version number, an updatedAt). Recorded at submit; approval is
   * refused (STALE) if it differs when the checker approves, so a change cannot
   * silently overwrite one approved in between. Runs inside the per-kind
   * approval lock, so it cannot move between the check and `apply`.
   */
  baseRef?(tx: Tx, tenantId: string, payload: P): Promise<string>
  /**
   * Makes the change. Runs inside the approval transaction, after the request
   * is marked APPROVED: any throw rolls the approval back too. Write audit
   * rows for what changed with the same `tx`.
   */
  apply(tx: Tx, ctx: ApplyContext<P>): Promise<void>
}

export function approvePermissionFor<P>(handler: ChangeHandler<P>, payload: P): string {
  return typeof handler.approvePermission === "function" ? handler.approvePermission(payload) : handler.approvePermission
}
