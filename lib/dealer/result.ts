/** A dealer-domain write that did not happen: the route answers `status` with `error`. */
export type DealerRefusal = { kind: "refused"; status: 400 | 404 | 409 | 422; error: string }

export const dealerRefused = (status: DealerRefusal["status"], error: string): DealerRefusal => ({ kind: "refused", status, error })

/** Every cross-dealer or cross-lender miss: the row does not exist for this caller. */
export const dealerMiss = (what: string): DealerRefusal => dealerRefused(404, `${what} not found`)
