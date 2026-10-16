// @vitest-environment jsdom
// A pending referral move previews one client's commission. When the field is
// handed another client, that preview must leave the screen and the parent's
// save must stop being bound to it, even if the new preview fails.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ReferralAgentField } from "./ReferralAgentField"
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const AGENTS = { agents: [
  { status: "ACTIVE", displayName: "Outgoing Agent", referralCodes: [{ id: "code-a", code: "AAA", status: "ACTIVE" }] },
  { status: "ACTIVE", displayName: "Agent Two", referralCodes: [{ id: "code-b", code: "BBB", status: "ACTIVE" }] } ] }
const IMPACT = { accrue: [{ loanReference: "L-1", commissionCents: 500 }], reverse: [], skipped: [], blockers: [], totalAccrueCents: 500, totalReverseCents: 0, reverseUnknownCount: 0 }
afterEach(() => vi.unstubAllGlobals())
describe("ReferralAgentField on a client change", () => {
  it("drops the previous client's preview and reports null to the parent", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/agent-hub")) return { ok: true, json: async () => AGENTS } as Response
      if (url.includes("client-1")) return { ok: true, json: async () => IMPACT } as Response
      return { ok: false, status: 500, json: async () => ({}) } as Response
    }))
    const calls: unknown[] = []
    const el = (id: string) => <ReferralAgentField clientId={id} initialCodeId="code-a" initialCodeLabel="Outgoing Agent" canEdit onImpactChange={(s) => calls.push(s)} />
    let r!: ReactTestRenderer
    await act(async () => { r = create(el("client-1")) })
    await act(async () => { r.root.findByType("select").props.onChange({ target: { value: "code-b" } }) })
    expect(JSON.stringify(r.toJSON())).toContain("will accrue")
    calls.length = 0
    await act(async () => { r.update(el("client-2")) })
    expect(JSON.stringify(r.toJSON())).not.toContain("will accrue")
    expect(calls[0]).toBeNull()
  })
})
