import { describe, expect, it } from "vitest"
import { evaluateStaffAccess, policyFromConfig } from "./staff-access-policy"

const hours = {
  mon: { start: "08:00", end: "17:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
}
// Monday 2026-10-12, 10:00 SAST and 18:00 SAST.
const inHours = new Date("2026-10-12T08:00:00.000Z")
const afterHours = new Date("2026-10-12T16:00:00.000Z")

describe("policyFromConfig", () => {
  it("is unrestricted with no config row, no hours and an empty allowlist", () => {
    expect(policyFromConfig(null)).toEqual({ hours: null, ipAllowlist: [], invalid: false })
    expect(policyFromConfig({ staffAccessHours: null, staffIpAllowlist: [] }))
      .toEqual({ hours: null, ipAllowlist: [], invalid: false })
  })

  it("marks a stored value it cannot read as invalid rather than as no restriction", () => {
    const policy = policyFromConfig({ staffAccessHours: { mon: "always" }, staffIpAllowlist: [] })
    expect(policy.invalid).toBe(true)
    expect(evaluateStaffAccess(policy, { role: "ADMIN", now: inHours, ip: "192.0.2.1" }))
      .toEqual({ allowed: false, reason: "policy_invalid" })
  })
})

describe("evaluateStaffAccess", () => {
  const policy = policyFromConfig({ staffAccessHours: hours, staffIpAllowlist: ["192.0.2.0/24"] })

  it("allows an in-hours caller from an allowed address", () => {
    expect(evaluateStaffAccess(policy, { role: "CREDIT_OFFICER", now: inHours, ip: "192.0.2.9" }))
      .toEqual({ allowed: true })
  })

  it("refuses outside working hours", () => {
    expect(evaluateStaffAccess(policy, { role: "CREDIT_OFFICER", now: afterHours, ip: "192.0.2.9" }))
      .toEqual({ allowed: false, reason: "outside_hours" })
  })

  it("refuses an address outside the allowlist, and an unknown address", () => {
    expect(evaluateStaffAccess(policy, { role: "ADMIN", now: inHours, ip: "198.51.100.1" }))
      .toEqual({ allowed: false, reason: "ip_not_allowed" })
    expect(evaluateStaffAccess(policy, { role: "ADMIN", now: inHours, ip: "unknown" }))
      .toEqual({ allowed: false, reason: "ip_not_allowed" })
  })

  it("lets a SUPER_ADMIN through but reports what it bypassed", () => {
    expect(evaluateStaffAccess(policy, { role: "SUPER_ADMIN", now: afterHours, ip: "198.51.100.1" }))
      .toEqual({ allowed: true, bypassed: "ip_not_allowed" })
    expect(evaluateStaffAccess(policy, { role: "SUPER_ADMIN", now: inHours, ip: "192.0.2.9" }))
      .toEqual({ allowed: true })
  })

  it("does not restrict an unconfigured tenant", () => {
    expect(evaluateStaffAccess(policyFromConfig(null), { role: "READONLY", now: afterHours, ip: "unknown" }))
      .toEqual({ allowed: true })
  })
})
