import { describe, expect, it } from "vitest"
import { principalRefusal } from "@/lib/auth-principal"

const staff = (status: string) => ({ active: true, role: "ADMIN", tenantId: "t1", operatorId: null, tenant: { status } })

// Breaker repro C asked whether staff of a lender that is not ACTIVE can sign in.
// SUSPENDED staff cannot (and open sessions end). PROVISIONING staff can, on purpose:
// a single-lender deployment resolves its tenant from NEXT_PUBLIC_TENANT_SLUG with no
// status check (lib/tenant.ts), so the lender's first admin configures it while it is
// PROVISIONING, before it is switched ACTIVE. That is safe for jurisdiction because a
// PROVISIONING tenant's config must already equal the instance's (database trigger,
// instance-guard.integration.test.ts), so it cannot be a lender of another jurisdiction.
describe("staff sign-in by lender status", () => {
  it("refuses a SUSPENDED lender's staff", () => {
    expect(principalRefusal(staff("SUSPENDED"), "staff")).toBe("tenant_suspended")
  })
  it("lets an ACTIVE lender's staff in", () => {
    expect(principalRefusal(staff("ACTIVE"), "staff")).toBeNull()
  })
  it("lets a PROVISIONING lender's staff in (onboarding)", () => {
    expect(principalRefusal(staff("PROVISIONING"), "staff")).toBeNull()
  })
})
