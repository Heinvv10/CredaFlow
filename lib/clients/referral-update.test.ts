import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { planReferralUpdate, REFERRAL_REASSIGN_MIN_ROLE } from "./referral-update"

const ADMIN = "LOAN_ADMIN" as const
const OFFICER = "CREDIT_OFFICER" as const

describe("planReferralUpdate — key presence", () => {
  it("returns 'absent' when the key was not sent at all", () => {
    // The edit form omits the key whenever its agent list failed to load.
    // Anything but 'absent' here would erase an agent's commission trail.
    expect(planReferralUpdate({ data: { firstName: "A" }, previousCodeId: "c1", actorRole: ADMIN }))
      .toEqual({ kind: "absent" })
  })

  it("treats an explicit null as a real clear, not an absent key", () => {
    expect(
      planReferralUpdate({ data: { referralCodeId: null }, previousCodeId: "c1", actorRole: ADMIN }),
    ).toEqual({ kind: "change", codeId: null, previousCodeId: "c1" })
  })

  it("treats an empty / whitespace string as a clear", () => {
    for (const raw of ["", "   "]) {
      expect(
        planReferralUpdate({ data: { referralCodeId: raw }, previousCodeId: "c1", actorRole: ADMIN }),
      ).toEqual({ kind: "change", codeId: null, previousCodeId: "c1" })
    }
  })

  it("rejects a non-string id instead of coercing it to a clear", () => {
    for (const raw of [42, {}, [], true]) {
      expect(
        planReferralUpdate({ data: { referralCodeId: raw }, previousCodeId: null, actorRole: ADMIN }).kind,
      ).toBe("invalid")
    }
  })

  it("trims a posted id", () => {
    expect(
      planReferralUpdate({ data: { referralCodeId: "  c2  " }, previousCodeId: "c1", actorRole: ADMIN }),
    ).toEqual({ kind: "change", codeId: "c2", previousCodeId: "c1" })
  })
})

describe("planReferralUpdate — authorisation", () => {
  it("lets a credit officer round-trip an UNCHANGED value", () => {
    // Otherwise an officer editing a phone number is blocked by a field they
    // are merely echoing back.
    expect(
      planReferralUpdate({ data: { referralCodeId: "c1" }, previousCodeId: "c1", actorRole: OFFICER }),
    ).toEqual({ kind: "unchanged", codeId: "c1" })
  })

  it("treats null-echo on an unattributed client as unchanged, not a change", () => {
    expect(
      planReferralUpdate({ data: { referralCodeId: "" }, previousCodeId: null, actorRole: OFFICER }),
    ).toEqual({ kind: "unchanged", codeId: null })
  })

  it("forbids a credit officer from MOVING commission to another agent", () => {
    const plan = planReferralUpdate({
      data: { referralCodeId: "c2" },
      previousCodeId: "c1",
      actorRole: OFFICER,
    })
    expect(plan.kind).toBe("forbidden")
  })

  it("forbids a credit officer from CLEARING an existing attribution", () => {
    expect(
      planReferralUpdate({ data: { referralCodeId: null }, previousCodeId: "c1", actorRole: OFFICER }).kind,
    ).toBe("forbidden")
  })

  it("allows a loan admin to move commission", () => {
    expect(
      planReferralUpdate({ data: { referralCodeId: "c2" }, previousCodeId: "c1", actorRole: ADMIN }),
    ).toEqual({ kind: "change", codeId: "c2", previousCodeId: "c1" })
  })

  it("denies an unknown or missing role", () => {
    for (const role of [undefined, "CLIENT" as const, "NOT_A_ROLE" as never]) {
      expect(
        planReferralUpdate({ data: { referralCodeId: "c2" }, previousCodeId: "c1", actorRole: role }).kind,
      ).toBe("forbidden")
    }
  })

  it("pins the floor to the role that can create agents", () => {
    // app/api/agent-hub/agents/route.ts POST requires LOAN_ADMIN. Re-pointing
    // commission is the same class of act, so the two must not drift apart.
    expect(REFERRAL_REASSIGN_MIN_ROLE).toBe("LOAN_ADMIN")
  })
})

describe("ROLE_HIERARCHY drift guard", () => {
  // This gate runs on lib/permissions' hasMinRole (that module has zero imports,
  // so it stays usable from a node-env test; lib/auth-guards pulls in next-auth).
  // lib/permissions describes itself as a "client-safe mirror" of auth-guards —
  // and the two files have ALREADY drifted elsewhere (PERMISSIONS.decline_loan is
  // CREDIT_OFFICER in one and LOAN_ADMIN in the other). So do not take the mirror
  // on trust: read BOTH files from disk and compare the orderings directly. Two
  // independent sources means a real divergence fails this test.
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8")
  const hierarchy = (src: string) => {
    const block = src.match(/ROLE_HIERARCHY[^=]*=\s*\[([\s\S]*?)\]/)
    if (!block) throw new Error("ROLE_HIERARCHY not found — did the declaration change shape?")
    return block[1].match(/"([A-Z_]+)"/g)?.map((s) => s.replace(/"/g, "")) ?? []
  }

  it("keeps lib/permissions and lib/auth-guards in the same role order", () => {
    const fromPermissions = hierarchy(read("lib/permissions.ts"))
    const fromAuthGuards = hierarchy(read("lib/auth-guards.ts"))
    expect(fromPermissions.length).toBeGreaterThan(5)
    expect(fromPermissions).toEqual(fromAuthGuards)
  })

  it("keeps LOAN_ADMIN strictly above CREDIT_OFFICER in the authority copy", () => {
    // The property the referral gate actually depends on, asserted against
    // auth-guards (the authority) rather than the mirror we import.
    const order = hierarchy(read("lib/auth-guards.ts"))
    expect(order.indexOf("LOAN_ADMIN")).toBeGreaterThan(order.indexOf("CREDIT_OFFICER"))
    expect(order.indexOf("CREDIT_OFFICER")).toBeGreaterThan(-1)
  })
})
