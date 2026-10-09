import { describe, it, expect } from "vitest"
import { parseCreditPolicyInput } from "@/lib/decision/credit-policy-input"

const valid = { bureauMinScore: 600, bureauBlockAdverse: true, ndiBufferPct: 110 }

describe("parseCreditPolicyInput", () => {
  it("accepts a valid in-band policy and echoes the typed values", () => {
    const r = parseCreditPolicyInput(valid)
    expect(r).toEqual({ ok: true, values: valid })
  })

  describe("bureauMinScore", () => {
    it("accepts the Sigma band boundaries 480 and 710", () => {
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: 480 }).ok).toBe(true)
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: 710 }).ok).toBe(true)
    })

    it("warn-but-allows sub-480 values (uncalibrated fail-safe, incl. the 450 default)", () => {
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: 479 }).ok).toBe(true)
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: 450 }).ok).toBe(true)
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: 1 }).ok).toBe(true)
    })

    it("rejects above the Sigma band ceiling (711)", () => {
      const r = parseCreditPolicyInput({ ...valid, bureauMinScore: 711 })
      expect(r.ok).toBe(false)
    })

    it("rejects 0 and negatives", () => {
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: 0 }).ok).toBe(false)
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: -5 }).ok).toBe(false)
    })

    it("rejects non-integers and non-numbers", () => {
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: 600.5 }).ok).toBe(false)
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: "600" }).ok).toBe(false)
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: NaN }).ok).toBe(false)
      expect(parseCreditPolicyInput({ ...valid, bureauMinScore: undefined }).ok).toBe(false)
    })
  })

  describe("ndiBufferPct", () => {
    it("accepts the boundaries 100 and 1000", () => {
      expect(parseCreditPolicyInput({ ...valid, ndiBufferPct: 100 }).ok).toBe(true)
      expect(parseCreditPolicyInput({ ...valid, ndiBufferPct: 1000 }).ok).toBe(true)
    })

    it("rejects below 100 and above 1000", () => {
      expect(parseCreditPolicyInput({ ...valid, ndiBufferPct: 99 }).ok).toBe(false)
      expect(parseCreditPolicyInput({ ...valid, ndiBufferPct: 1001 }).ok).toBe(false)
    })

    it("rejects non-integers", () => {
      expect(parseCreditPolicyInput({ ...valid, ndiBufferPct: 110.5 }).ok).toBe(false)
      expect(parseCreditPolicyInput({ ...valid, ndiBufferPct: "110" }).ok).toBe(false)
    })
  })

  describe("bureauBlockAdverse", () => {
    it("accepts both boolean values", () => {
      expect(parseCreditPolicyInput({ ...valid, bureauBlockAdverse: false }).ok).toBe(true)
      expect(parseCreditPolicyInput({ ...valid, bureauBlockAdverse: true }).ok).toBe(true)
    })

    it("rejects truthy non-booleans", () => {
      expect(parseCreditPolicyInput({ ...valid, bureauBlockAdverse: "true" }).ok).toBe(false)
      expect(parseCreditPolicyInput({ ...valid, bureauBlockAdverse: 1 }).ok).toBe(false)
      expect(parseCreditPolicyInput({ ...valid, bureauBlockAdverse: null }).ok).toBe(false)
    })
  })

  describe("body shape", () => {
    it("rejects non-object bodies", () => {
      expect(parseCreditPolicyInput(null).ok).toBe(false)
      expect(parseCreditPolicyInput(undefined).ok).toBe(false)
      expect(parseCreditPolicyInput("nope").ok).toBe(false)
      expect(parseCreditPolicyInput(42).ok).toBe(false)
    })

    it("rejects when any field is missing", () => {
      expect(parseCreditPolicyInput({ bureauBlockAdverse: true, ndiBufferPct: 110 }).ok).toBe(false)
      expect(parseCreditPolicyInput({ bureauMinScore: 600, ndiBufferPct: 110 }).ok).toBe(false)
      expect(parseCreditPolicyInput({ bureauMinScore: 600, bureauBlockAdverse: true }).ok).toBe(false)
    })
  })
})
