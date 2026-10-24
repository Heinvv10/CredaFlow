import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))

import { DsarClient } from "./DsarClient"

const dsar = (id: string, status: string) => ({
  id, reference: `DSAR-${id}`, clientId: "client-1", type: "ACCESS", description: null, status,
  dueDate: new Date("2026-12-01T00:00:00Z"), completedAt: null, response: null, createdAt: new Date("2026-10-01T00:00:00Z"),
  client: { id: "client-1", firstName: "Synthetic", lastName: "Person", idNumber: "0000000000000", email: null },
})

describe("DsarClient decision-record export", () => {
  it("offers the download on every request, including a closed one", () => {
    const html = renderToStaticMarkup(<DsarClient dsars={[dsar("a", "IN_PROGRESS"), dsar("b", "COMPLETED")]} clients={[]} />)
    expect(html.match(/Download decision records/g)).toHaveLength(2)
  })

  it("renders with no requests at all", () => {
    const html = renderToStaticMarkup(<DsarClient dsars={[]} clients={[]} />)
    expect(html).toContain("No data subject requests found")
    expect(html).not.toContain("Download decision records")
  })
})
