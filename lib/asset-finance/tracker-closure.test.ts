import { describe, expect, it } from "vitest"
import { closure, importsOf } from "@/lib/telematics/__fixtures__/import-graph"

// The closure's one outbound door (docs/asset-finance/SLICE5-FOLLOWUPS.md part
// T): the borrower's email goes through sendMessage, whose consent gate,
// opt-outs and kill switches stand; the processor imports no channel, bell or
// transport of its own. The cron reaches messaging only through it. The
// real-DB proof (a faked transport called once, BLOCKED when the lender has
// no email) is ./tracker-closure.integration.test.ts.
const OUTBOUND = [/^lib\/messaging\//, /^lib\/notifications(\/|\.ts$)/, /^lib\/whatsapp\//, /^lib\/email\//, /^lib\/integrations\/bulksms/]
const outbound = (files: Iterable<string>) => [...files].filter((file) => OUTBOUND.some((re) => re.test(file))).sort()

describe("tracker closure sends only through sendMessage", () => {
  it("imports no outbound module but the send pipeline, its outcome reader and its in-flight error", () => {
    expect(outbound(importsOf("lib/asset-finance/tracker-closure.ts"))).toEqual(["lib/messaging/delivery-outcome.ts", "lib/messaging/dispatch-control.ts", "lib/messaging/send.ts"])
  })

  it("the cron route reaches messaging only through the processor", () => {
    const route = "app/api/cron/asset-finance-telematics-closure/route.ts"
    expect(outbound(importsOf(route))).toEqual([])
    expect(closure([route]).has("lib/asset-finance/tracker-closure.ts")).toBe(true)
  })
})
