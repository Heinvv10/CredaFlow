import { describe, expect, it } from "vitest"
import { closure, sourceFiles } from "./__fixtures__/import-graph"

// "No outbound message" (docs/asset-finance/SLICE5.md part B): an alert raises
// a TelematicsAlert work item and nothing else. No telematics module, nor any
// module it reaches, imports the send pipeline, the bell or a channel. The
// real-DB proof that no Message, Notification or EmailLog row is written is
// lib/telematics/alerts.integration.test.ts.
const OUTBOUND = [/^lib\/messaging\//, /^lib\/notifications(\/|\.ts$)/, /^lib\/whatsapp\//, /^lib\/email\//, /^lib\/integrations\/bulksms/]

describe("telematics sends nothing", () => {
  const entries = sourceFiles("lib/telematics")
  const graph = closure(entries)

  it("walks a real import graph", () => {
    for (const file of ["lib/telematics/ingest.ts", "lib/telematics/poll.ts", "lib/telematics/alerts-raise.ts"]) expect(entries).toContain(file)
    expect(graph.has("lib/asset-finance/meter-readings.ts")).toBe(true)
    expect(graph.has("lib/audit.ts")).toBe(true)
  })

  it("reaches no messaging, notification, WhatsApp, email or SMS module, directly or transitively", () => {
    expect([...graph].filter((file) => OUTBOUND.some((re) => re.test(file)))).toEqual([])
  })
})
