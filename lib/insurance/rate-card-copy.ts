// Copying the rows of one rate card onto a new DRAFT.
//
// "Create new version" is the only way to change a rate, because an ACTIVE card
// is immutable — so this loop runs every time anybody reprices anything. There
// is no bulk route and none is in scope, so it is one POST per band, which
// means every copied row goes through the same overlap, ordering and money
// validation a hand-typed one does.
//
// IT IS SEPARATED FROM THE COMPONENT ON PURPOSE. A copy that drops a band,
// duplicates one, or transposes two axes produces a new version that LOOKS
// populated and prices differently from the card it was cloned from, and nobody
// spots that by eye on a thirty-row grid. Testing it through the component
// would mean standing up the whole fetch shell and asserting against a mock of
// it; here the loop is the unit and `post` is the only thing stubbed, so the
// test exercises the real sequencing, the real payloads and the real stop
// condition.
//
// `post` is injected rather than `fetch` being called directly for that reason
// alone — the caller supplies the fetch-backed one.

import { readApiError, toRands, type RateBandRow } from "@/lib/settings-insurance-config"
import type { InsuredLifeType } from "@prisma/client"

/** Exactly what `parseBandInput` accepts, in the units it expects: rands. */
export interface BandCopyPayload {
  lifeType: InsuredLifeType
  minAge: number
  maxAge: number
  sumAssured: number
  premiumAmount: number
}

export type PostBand = (url: string, body: BandCopyPayload) => Promise<Response>

export interface BandCopyResult {
  /** How many bands the server accepted. */
  copied: number
  /** How many were on the source card. */
  total: number
  /**
   * The row the copy stopped on, or null if every one landed. `index` is the
   * position in the source card, so the caller can say which one.
   */
  failure: { index: number; band: RateBandRow; error: string } | null
}

/**
 * The five axes of a band, converted for the wire.
 *
 * All five, every time. `sumAssured` and `premiumAmount` arrive from the API as
 * STRINGS — Prisma serialises `Decimal` through `toJSON` — and posting a string
 * back would be refused by `parseDecimalAmount` as "must be a finite number",
 * so `toRands` is not cosmetic here. The other three are the keys the band's
 * identity and overlap check are built from; dropping one silently reprices the
 * copy.
 */
export function bandCopyPayload(band: RateBandRow): BandCopyPayload {
  return {
    lifeType: band.lifeType,
    minAge: band.minAge,
    maxAge: band.maxAge,
    sumAssured: toRands(band.sumAssured),
    premiumAmount: toRands(band.premiumAmount),
  }
}

/**
 * Copy every band onto `targetTableId`, in source order, stopping at the first
 * refusal.
 *
 * SEQUENTIAL, NOT CONCURRENT. Each POST takes a `FOR UPDATE` lock on the parent
 * rate table to run its overlap check, so firing them in parallel would have
 * them queue on that lock anyway — and a `Promise.all` would additionally lose
 * which row failed and leave the rest in flight after the first refusal.
 *
 * STOPS at the first failure rather than continuing. A refusal is nearly always
 * structural — the source card overlaps under the target's basis — so the
 * remaining rows would fail the same way and bury the first, real message under
 * a stack of consequences.
 *
 * This is the LOOP ONLY and it does not clean up after itself; discarding a
 * half-written draft is `copyBandsOrDiscard`'s job, one level up. Kept separate
 * so the sequencing and the recovery can each be read and tested on their own.
 * `copied` and `total` are returned so a caller can state exactly how partial a
 * copy was rather than leaving the operator to count rows.
 */
export async function copyBands(
  targetTableId: string,
  bands: readonly RateBandRow[],
  post: PostBand
): Promise<BandCopyResult> {
  const url = `/api/insurance/rate-tables/${targetTableId}/bands`

  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index]
    const res = await post(url, bandCopyPayload(band))
    if (!res.ok) {
      return { copied: index, total: bands.length, failure: { index, band, error: await readApiError(res) } }
    }
  }

  return { copied: bands.length, total: bands.length, failure: null }
}

/** What became of a draft whose copy did not finish. */
export type CleanupOutcome =
  /** The copy completed; there was nothing to clean up. */
  | "not-needed"
  /** The copy failed and the half-written draft was removed. */
  | "deleted"
  /** The copy failed AND the draft could not be removed. It is still there. */
  | "orphaned"

export interface DiscardableCopyResult extends BandCopyResult {
  cleanup: CleanupOutcome
  /** Why the cleanup failed, when it did. Null otherwise. */
  cleanupError: string | null
}

export type DeleteTable = (url: string) => Promise<Response>

/**
 * Copy a card onto a new DRAFT, and DISCARD that draft if the copy does not
 * finish.
 *
 * A VERSION IS A UNIT, NOT AN ACCUMULATION. The whole discipline of this
 * rate-card system is that an ACTIVE table is never mutated and a change is a
 * new COMPLETE version; a half-copied draft violates that at birth. Losing 27
 * good rows to one bad one is the right trade when re-clicking costs seconds
 * and the alternative is a card that reads plausibly on the grid and silently
 * fails to price two age bands. The grid's gap warnings do not save us here:
 * they catch a hole BETWEEN two bands, not a copy truncated at the end of a
 * life type's range, which is exactly the shape a stopped loop produces.
 *
 * Discarding also costs nothing in retries. A refusal is nearly always
 * structural — the source overlaps under the target's basis — so the operator
 * cannot fix it by trying again; they must change the source or the basis
 * first. Keeping the partial draft would leave a graveyard of junk versions
 * burning numbers against `@@unique([tenantId, productId, version])`.
 *
 * THE CLEANUP CAN ITSELF FAIL, and then we are back to an orphaned partial
 * draft with no rollback. That outcome is reported as `orphaned` and must never
 * be reported as a success or swallowed — the caller has to name the version so
 * a human can remove it by hand. A cleanup that fails quietly is worse than no
 * cleanup, because the message would say the draft was discarded when it is
 * still sitting there ready to be activated.
 */
export async function copyBandsOrDiscard(
  targetTableId: string,
  bands: readonly RateBandRow[],
  post: PostBand,
  del: DeleteTable
): Promise<DiscardableCopyResult> {
  const result = await copyBands(targetTableId, bands, post)
  if (!result.failure) return { ...result, cleanup: "not-needed", cleanupError: null }

  // A throw here is the same outcome as a refusal — the draft is still there —
  // so the network case cannot be allowed to escape and be reported as a plain
  // copy failure.
  try {
    const res = await del(`/api/insurance/rate-tables/${targetTableId}`)
    if (!res.ok) {
      return { ...result, cleanup: "orphaned", cleanupError: await readApiError(res) }
    }
  } catch (error) {
    return { ...result, cleanup: "orphaned", cleanupError: (error as Error).message }
  }

  return { ...result, cleanup: "deleted", cleanupError: null }
}
