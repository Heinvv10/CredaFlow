import { describe, expect, it, vi } from "vitest"
import {
  amountBand,
  bureauScoreBand,
  incomeBand,
  inputsHash,
  ndiCoverBand,
  policyHash,
  ratioBand,
  recordData,
  recordDecisions,
  type DecisionLogDb,
  type DecisionRecordInput,
} from "./decision-log"

const input = (over: Partial<DecisionRecordInput> = {}): DecisionRecordInput => ({
  tenantId: "tenant-a",
  kind: "CREDIT_DECISION",
  decision: "APPROVE",
  recommendation: "PASS",
  overrideReason: null,
  actor: { type: "STAFF", userId: "user-1", role: "LOAN_ADMIN" },
  subject: { applicationId: "app-1" },
  source: { entityType: "LoanApplication", entityId: "app-1" },
  ruleVersion: "decision-log-v1",
  policy: { bureauMinScore: 580, ndiBufferPct: 110 },
  snapshot: { amountBand: "1000-4999" },
  evidenceRefs: { bureauCheckId: "b-1" },
  exactInputs: { principalCents: 350_000, flags: ["x", "y"] },
  decidedAt: new Date("2026-10-21T08:00:00.000Z"),
  ...over,
})

describe("hashes", () => {
  it("are canonical: key order does not change them", () => {
    expect(policyHash({ a: 1, b: { c: true, d: null } })).toBe(policyHash({ b: { d: null, c: true }, a: 1 }))
    expect(inputsHash(input())).toBe(inputsHash(input({ exactInputs: { flags: ["x", "y"], principalCents: 350_000 } })))
  })

  it("change with any input, reference or threshold", () => {
    const base = inputsHash(input())
    expect(inputsHash(input({ exactInputs: { principalCents: 350_001, flags: ["x", "y"] } }))).not.toBe(base)
    expect(inputsHash(input({ evidenceRefs: { bureauCheckId: "b-2" } }))).not.toBe(base)
    expect(inputsHash(input({ policy: { bureauMinScore: 581, ndiBufferPct: 110 } }))).not.toBe(base)
  })

  it("are pinned: a change to the canonical form is a deliberate one", () => {
    expect(policyHash({ bureauMinScore: 580, ndiBufferPct: 110 })).toBe("beaed83fce893559593a76b0c9c0f6dfd385ee8ff02fdef84bd01c1b162ff03c")
  })
})

describe("recordData", () => {
  it("is not an override without a reason, and is one with a reason", () => {
    expect(recordData(input())).toMatchObject({ overridden: false, overrideReason: null })
    expect(recordData(input({ overrideReason: "   " }))).toMatchObject({ overridden: false, overrideReason: null })
    expect(recordData(input({ recommendation: "BLOCK", overrideReason: " Verified by hand. " }))).toMatchObject({
      overridden: true, overrideReason: "Verified by hand.",
    })
  })

  it("names the staff member and role, and nobody for an automated decision", () => {
    expect(recordData(input())).toMatchObject({ actorType: "STAFF", actorUserId: "user-1", actorRole: "LOAN_ADMIN" })
    expect(recordData(input({ actor: { type: "SYSTEM" } }))).toMatchObject({ actorType: "SYSTEM", actorUserId: null, actorRole: null })
  })

  it("records no model and no probability: nothing produces one today", () => {
    expect(recordData(input())).toMatchObject({ modelVersion: null, predictedProbability: null })
  })

  it("never stores the exact inputs", () => {
    expect(JSON.stringify(recordData(input()))).not.toContain("350000")
  })
})

describe("recordDecisions", () => {
  it("writes each record through the client it is given, and throws when a write fails", async () => {
    const create = vi.fn(async () => ({}))
    const db = { creditDecisionRecord: { create } } as unknown as DecisionLogDb
    await recordDecisions(db, [input(), input({ kind: "OFFER", decision: "APPROVED_TERMS", recommendation: "NONE" })])
    expect(create).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({ kind: "OFFER", decision: "APPROVED_TERMS" }) })

    create.mockRejectedValueOnce(new Error("insert refused"))
    await expect(recordDecisions(db, [input()])).rejects.toThrow("insert refused")
  })
})

describe("bands", () => {
  it("band money in rands, from cents", () => {
    expect(amountBand(99_900)).toBe("<1000")
    expect(amountBand(100_000)).toBe("1000-4999")
    expect(amountBand(499_999)).toBe("1000-4999")
    expect(amountBand(150_000_000)).toBe("1000000+")
    expect(incomeBand(1_000_000)).toBe("10000-19999")
  })

  it("band the Sigma score in 50 points, and keep no score as null", () => {
    expect(bureauScoreBand(null)).toBeNull()
    expect(bureauScoreBand(470)).toBe("<480")
    expect(bureauScoreBand(480)).toBe("480-529")
    expect(bureauScoreBand(710)).toBe("680+")
  })

  it("band NDI as a multiple of the required NDI", () => {
    expect(ndiCoverBand(99, 100)).toBe("<1.00")
    expect(ndiCoverBand(100, 100)).toBe("1.00-1.24")
    expect(ndiCoverBand(300, 100)).toBe("3.00+")
    expect(ndiCoverBand(100, 0)).toBeNull()
  })

  it("band ratios, and keep a missing one null", () => {
    expect(ratioBand(1.8, [1, 1.25, 1.5, 2])).toBe("1.5-2")
    expect(ratioBand(0.5, [1, 1.25, 1.5, 2])).toBe("<1")
    expect(ratioBand(null, [1])).toBeNull()
  })
})
