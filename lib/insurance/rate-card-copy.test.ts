// "Create new version" is the ONLY way to change a rate, because an ACTIVE card
// is immutable — so this loop runs on every repricing there will ever be. A copy
// that drops a band, duplicates one, or transposes two axes produces a version
// that looks populated and prices differently from the card it was cloned from,
// and nobody catches that by eye on a thirty-row grid. The consequence is real
// money mispriced against an insurer's terms.
//
// THE SOURCE FIXTURE IS NON-UNIFORM ON EVERY AXIS. Two life types, two cover
// tiers, three distinct age ranges, six distinct premiums, and one premium
// carrying cents. A uniform card would make almost every assertion below
// vacuous: a loop that posted the first band six times, or reused one premium
// throughout, would pass against it. This is the same trap the rating fixtures
// carry a warning about.
import { describe, expect, it, vi } from "vitest"
import {
  bandCopyPayload,
  copyBands,
  copyBandsOrDiscard,
  type BandCopyPayload,
} from "./rate-card-copy"
import type { RateBandRow } from "@/lib/settings-insurance-config"

function band(
  id: string,
  lifeType: RateBandRow["lifeType"],
  minAge: number,
  maxAge: number,
  sumAssured: string,
  premiumAmount: string
): RateBandRow {
  return { id, rateTableId: "src", lifeType, minAge, maxAge, sumAssured, premiumAmount }
}

/** Money arrives as STRINGS, as Prisma actually serialises Decimal columns. */
const SOURCE: RateBandRow[] = [
  band("b1", "MAIN_MEMBER", 18, 40, "10000", "45"),
  band("b2", "MAIN_MEMBER", 41, 65, "10000", "88.50"),
  band("b3", "MAIN_MEMBER", 18, 40, "20000", "82"),
  band("b4", "MAIN_MEMBER", 41, 65, "20000", "171.50"),
  band("b5", "SPOUSE", 18, 65, "10000", "39"),
  band("b6", "CHILD", 0, 21, "5000", "12.50"),
]

/** A `post` that accepts everything, recording what it was sent. */
function acceptAll() {
  const sent: { url: string; body: BandCopyPayload }[] = []
  const post = vi.fn(async (url: string, body: BandCopyPayload) => {
    sent.push({ url, body })
    return { ok: true, status: 200, json: async () => ({ id: `new-${sent.length}` }) } as Response
  })
  return { sent, post }
}

describe("bandCopyPayload", () => {
  it("carries all five axes", () => {
    expect(bandCopyPayload(SOURCE[3])).toEqual({
      lifeType: "MAIN_MEMBER",
      minAge: 41,
      maxAge: 65,
      sumAssured: 20000,
      premiumAmount: 171.5,
    })
  })

  it("converts the money columns out of the strings they arrive as", () => {
    // Posting "171.50" back is refused by parseDecimalAmount as "must be a
    // finite number", so this conversion is load-bearing, not cosmetic.
    const payload = bandCopyPayload(SOURCE[3])
    expect(typeof payload.sumAssured).toBe("number")
    expect(typeof payload.premiumAmount).toBe("number")
    expect(payload.premiumAmount).toBe(171.5)
  })

  it("survives the JSON round trip the request actually makes", () => {
    expect(JSON.parse(JSON.stringify(bandCopyPayload(SOURCE[5])))).toEqual({
      lifeType: "CHILD",
      minAge: 0,
      maxAge: 21,
      sumAssured: 5000,
      premiumAmount: 12.5,
    })
  })
})

describe("copyBands — a complete copy", () => {
  it("posts every band, once each, and reports them all copied", async () => {
    const { sent, post } = acceptAll()
    const result = await copyBands("target", SOURCE, post)

    expect(post).toHaveBeenCalledTimes(6)
    expect(sent).toHaveLength(6)
    expect(result).toEqual({ copied: 6, total: 6, failure: null })
  })

  it("reproduces the source card EXACTLY — every axis of every row", async () => {
    // The whole payload sequence in one assertion. A loop that dropped a row,
    // repeated one, reused a premium, or swapped minAge and maxAge fails here.
    const { sent, post } = acceptAll()
    await copyBands("target", SOURCE, post)

    expect(sent.map((s) => s.body)).toEqual([
      { lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 40, sumAssured: 10000, premiumAmount: 45 },
      { lifeType: "MAIN_MEMBER", minAge: 41, maxAge: 65, sumAssured: 10000, premiumAmount: 88.5 },
      { lifeType: "MAIN_MEMBER", minAge: 18, maxAge: 40, sumAssured: 20000, premiumAmount: 82 },
      { lifeType: "MAIN_MEMBER", minAge: 41, maxAge: 65, sumAssured: 20000, premiumAmount: 171.5 },
      { lifeType: "SPOUSE", minAge: 18, maxAge: 65, sumAssured: 10000, premiumAmount: 39 },
      { lifeType: "CHILD", minAge: 0, maxAge: 21, sumAssured: 5000, premiumAmount: 12.5 },
    ])
  })

  it("keeps every distinct premium distinct", async () => {
    // Named separately from the payload assertion because THIS is the failure
    // that would still price: six rows land, all at one rate.
    const { sent, post } = acceptAll()
    await copyBands("target", SOURCE, post)
    expect(sent.map((s) => s.body.premiumAmount)).toEqual([45, 88.5, 82, 171.5, 39, 12.5])
    expect(new Set(sent.map((s) => s.body.premiumAmount)).size).toBe(6)
  })

  it("copies every life type the source card carries", async () => {
    const { sent, post } = acceptAll()
    await copyBands("target", SOURCE, post)
    expect(new Set(sent.map((s) => s.body.lifeType))).toEqual(
      new Set(["MAIN_MEMBER", "SPOUSE", "CHILD"])
    )
  })

  it("addresses the TARGET table, never the source", async () => {
    const { sent, post } = acceptAll()
    await copyBands("target-99", SOURCE, post)
    expect(new Set(sent.map((s) => s.url))).toEqual(
      new Set(["/api/insurance/rate-tables/target-99/bands"])
    )
    expect(sent.every((s) => !s.url.includes("src"))).toBe(true)
  })

  it("posts in source order, which is the order the overlap check sees them", async () => {
    const { sent, post } = acceptAll()
    await copyBands("target", SOURCE, post)
    expect(sent.map((s) => `${s.body.lifeType}-${s.body.minAge}-${s.body.sumAssured}`)).toEqual([
      "MAIN_MEMBER-18-10000",
      "MAIN_MEMBER-41-10000",
      "MAIN_MEMBER-18-20000",
      "MAIN_MEMBER-41-20000",
      "SPOUSE-18-10000",
      "CHILD-0-5000",
    ])
  })

  it("is sequential — each POST completes before the next is issued", async () => {
    // They serialise on the parent table's FOR UPDATE lock anyway, and a
    // Promise.all would lose which row failed and leave the rest in flight
    // after the first refusal.
    const order: string[] = []
    const post = vi.fn(async (_url: string, body: BandCopyPayload) => {
      order.push(`start-${body.premiumAmount}`)
      await new Promise((resolve) => setTimeout(resolve, 0))
      order.push(`end-${body.premiumAmount}`)
      return { ok: true, status: 200 } as Response
    })
    await copyBands("target", SOURCE.slice(0, 3), post)
    expect(order).toEqual([
      "start-45", "end-45",
      "start-88.5", "end-88.5",
      "start-82", "end-82",
    ])
  })

  it("posts nothing for an empty source card", async () => {
    const { post } = acceptAll()
    expect(await copyBands("target", [], post)).toEqual({ copied: 0, total: 0, failure: null })
    expect(post).not.toHaveBeenCalled()
  })
})

// ─── The partial copy ────────────────────────────────────────────────────────
//
// `copyBands` stops at the first refusal and reports how far it got. It does
// NOT roll back — that is `copyBandsOrDiscard`'s job, below, and the split is
// deliberate: the loop's own contract is "post these in order, stop when the
// server says no, say where you stopped", and the recovery policy sits on top
// of it where it can be read and changed on its own.
describe("copyBands — a refusal partway through", () => {
  function failAt(failIndex: number, error: string) {
    let call = -1
    return vi.fn(async () => {
      call += 1
      if (call === failIndex) {
        return { ok: false, status: 409, json: async () => ({ error }) } as Response
      }
      return { ok: true, status: 200 } as Response
    })
  }

  it("stops at the refusal and does not post the remaining bands", async () => {
    const post = failAt(2, "That band already exists")
    const result = await copyBands("target", SOURCE, post)

    // Three calls: two accepted, the third refused. Bands 4-6 never sent.
    expect(post).toHaveBeenCalledTimes(3)
    expect(result.copied).toBe(2)
    expect(result.total).toBe(6)
  })

  it("names WHICH band was refused and what the server said, verbatim", async () => {
    const refusal =
      "This band overlaps an existing band (ages 18-40) already covering MAIN_MEMBER over ages 18-40 at cover 20000"
    const result = await copyBands("target", SOURCE, failAt(2, refusal))

    expect(result.failure).not.toBeNull()
    expect(result.failure?.index).toBe(2)
    expect(result.failure?.band.id).toBe("b3")
    expect(result.failure?.error).toBe(refusal)
  })

  it("reports the count that makes the copy's incompleteness measurable", async () => {
    // `copied` vs `total` is what lets the caller say "only 2 of 6 copied"
    // rather than "copying a band failed", which left the operator counting
    // rows against the source to find out how bad it was.
    const result = await copyBands("target", SOURCE, failAt(2, "nope"))
    expect(result.copied).toBe(2)
    expect(result.total).toBe(6)
    expect(result.copied).toBeLessThan(result.total)
  })

  // This test previously asserted the OPPOSITE — that the partial copy was
  // left in place — and it was pinning that on purpose while the question of
  // whether to roll back was still open. The decision came back as "discard
  // the partial draft", so the pin is inverted here rather than deleted: the
  // recovery moved one level up to `copyBandsOrDiscard`, and `copyBands`
  // remains the bare loop that does not clean up after itself.
  it("does not clean up after itself — recovery belongs to copyBandsOrDiscard", async () => {
    const calls: string[] = []
    let call = -1
    const post = vi.fn(async (url: string) => {
      call += 1
      calls.push(`POST ${url}`)
      return call === 2
        ? ({ ok: false, status: 409, json: async () => ({ error: "nope" }) } as Response)
        : ({ ok: true, status: 200 } as Response)
    })

    await copyBands("target", SOURCE, post)

    expect(calls).toEqual([
      "POST /api/insurance/rate-tables/target/bands",
      "POST /api/insurance/rate-tables/target/bands",
      "POST /api/insurance/rate-tables/target/bands",
    ])
  })

  it("reports zero copied when the very first band is refused", async () => {
    const result = await copyBands("target", SOURCE, failAt(0, "nope"))
    expect(result.copied).toBe(0)
    expect(result.failure?.index).toBe(0)
  })

  it("reports five of six when only the last is refused", async () => {
    const result = await copyBands("target", SOURCE, failAt(5, "nope"))
    expect(result.copied).toBe(5)
    expect(result.failure?.band.id).toBe("b6")
  })

  it("falls back to the status code when the refusal body will not parse", async () => {
    const post = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json")
      },
    }) as unknown as Response)
    const result = await copyBands("target", SOURCE, post)
    expect(result.failure?.error).toContain("HTTP 500")
  })
})

// ─── Discard on failure ──────────────────────────────────────────────────────
//
// A version is a UNIT, not an accumulation: an ACTIVE card is never mutated and
// a change is a new COMPLETE version, so a half-copied draft violates the
// discipline at birth. The grid's gap warnings do not cover for it either —
// they catch a hole BETWEEN two bands, not a copy truncated at the end of a
// life type's range, which is exactly the shape a stopped loop leaves behind.
//
// The cleanup can itself fail, and then the draft really is orphaned. That path
// gets its own tests because a cleanup that fails quietly is WORSE than no
// cleanup: the message would tell the operator the draft was discarded while it
// sits there ready to be activated.
describe("copyBandsOrDiscard", () => {
  function ok() {
    return { ok: true, status: 200 } as Response
  }
  function refusal(error: string, status = 409) {
    return { ok: false, status, json: async () => ({ error }) } as Response
  }

  it("deletes nothing when every band copies", async () => {
    const del = vi.fn(async () => ok())
    const result = await copyBandsOrDiscard("target", SOURCE, async () => ok(), del)

    expect(result.cleanup).toBe("not-needed")
    expect(result.cleanupError).toBeNull()
    expect(result.copied).toBe(6)
    expect(del).not.toHaveBeenCalled()
  })

  it("DELETES the half-written draft when a band is refused", async () => {
    let call = -1
    const post = vi.fn(async () => {
      call += 1
      return call === 2 ? refusal("That band already exists") : ok()
    })
    const del = vi.fn(async () => ok())

    const result = await copyBandsOrDiscard("target-7", SOURCE, post, del)

    expect(del).toHaveBeenCalledTimes(1)
    expect(del).toHaveBeenCalledWith("/api/insurance/rate-tables/target-7")
    expect(result.cleanup).toBe("deleted")
    expect(result.cleanupError).toBeNull()
  })

  it("still reports how far the copy got and why it stopped, after discarding", async () => {
    // The discard does not erase the diagnosis: the operator has to know which
    // row the server refused, because the refusal is nearly always structural
    // and they must fix the SOURCE before retrying.
    let call = -1
    const post = vi.fn(async () => {
      call += 1
      return call === 4 ? refusal("This band overlaps an existing band (ages 18-40)") : ok()
    })

    const result = await copyBandsOrDiscard("target", SOURCE, post, async () => ok())

    expect(result.copied).toBe(4)
    expect(result.total).toBe(6)
    expect(result.failure?.index).toBe(4)
    expect(result.failure?.band.id).toBe("b5")
    expect(result.failure?.error).toBe("This band overlaps an existing band (ages 18-40)")
  })

  it("deletes the TARGET table, never the source", async () => {
    // `_url` is declared so `mock.calls` types as a real tuple — a bare
    // `vi.fn(async () => …)` infers zero parameters and indexing it fails the
    // typecheck rather than the assertion.
    const del = vi.fn(async (_url: string) => ok())
    await copyBandsOrDiscard("target-7", SOURCE, async () => refusal("nope"), del)

    expect(del).toHaveBeenCalledWith("/api/insurance/rate-tables/target-7")
    expect(del.mock.calls[0][0]).not.toContain("src")
  })

  it("reports ORPHANED when the cleanup is itself refused", async () => {
    // The dangerous path: the draft is still there and can be activated. This
    // must never come back as "deleted".
    const del = vi.fn(async () => refusal("Only a DRAFT rate table can be deleted. Retire it instead."))
    const result = await copyBandsOrDiscard("target", SOURCE, async () => refusal("nope"), del)

    expect(result.cleanup).toBe("orphaned")
    expect(result.cleanupError).toBe("Only a DRAFT rate table can be deleted. Retire it instead.")
    expect(result.failure).not.toBeNull()
  })

  it("reports ORPHANED when the cleanup request throws rather than letting it escape", async () => {
    // A network failure leaves the draft exactly as a refusal does. Letting the
    // throw propagate would surface as a generic send failure and lose the fact
    // that a partial version is sitting on the product.
    const del = vi.fn(async () => {
      throw new Error("network down")
    })
    const result = await copyBandsOrDiscard("target", SOURCE, async () => refusal("nope"), del)

    expect(result.cleanup).toBe("orphaned")
    expect(result.cleanupError).toContain("network down")
  })

  it("falls back to the status code when the cleanup refusal will not parse", async () => {
    const del = vi.fn(
      async () =>
        ({
          ok: false,
          status: 503,
          json: async () => {
            throw new Error("not json")
          },
        }) as unknown as Response
    )
    const result = await copyBandsOrDiscard("target", SOURCE, async () => refusal("nope"), del)

    expect(result.cleanup).toBe("orphaned")
    expect(result.cleanupError).toContain("HTTP 503")
  })

  it("never reports a cleanup outcome that contradicts the copy", async () => {
    // The invariant tying the two halves together: a finished copy is never
    // "deleted" or "orphaned", and a failed one is never "not-needed".
    const outcomes = await Promise.all([
      copyBandsOrDiscard("t", SOURCE, async () => ok(), async () => ok()),
      copyBandsOrDiscard("t", SOURCE, async () => refusal("nope"), async () => ok()),
      copyBandsOrDiscard("t", SOURCE, async () => refusal("nope"), async () => refusal("no")),
    ])

    expect(outcomes.map((o) => o.cleanup)).toEqual(["not-needed", "deleted", "orphaned"])
    for (const outcome of outcomes) {
      expect(outcome.failure === null).toBe(outcome.cleanup === "not-needed")
    }
  })
})
