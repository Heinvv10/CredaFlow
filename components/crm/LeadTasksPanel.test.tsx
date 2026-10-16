// @vitest-environment jsdom
// "Overdue" is a clock comparison. The server must render the not-overdue
// variant, so a browser whose clock disagrees cannot trigger a hydration
// mismatch; the real answer lands once hydrated.
import { renderToString } from "react-dom/server"
import { hydrateRoot } from "react-dom/client"
import { act as reactAct } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { LeadTasksPanel, type LeadTask } from "./LeadTasksPanel"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const past: LeadTask = {
  id: "t1", title: "Call back", description: null, priority: "HIGH", status: "PENDING",
  dueAt: "2020-01-01T08:00:00.000Z", assignee: null,
}
const future: LeadTask = { ...past, id: "t2", title: "Send quote", dueAt: "2999-01-01T08:00:00.000Z" }

const panel = () => (
  <LeadTasksPanel leadId="l1" tasks={[past, future]} staff={[]} canCreate={false} canManage={false} currentUserId="u1" />
)

beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { delete env.IS_REACT_ACT_ENVIRONMENT })

describe("LeadTasksPanel overdue marker", () => {
  it("server-renders nothing as overdue, even for a task long past due", () => {
    const html = renderToString(panel())
    expect(html).toContain("Call back")
    expect(html).not.toContain("Overdue")
  })

  it("hydrates the server HTML without a mismatch, then marks only the past-due task overdue", async () => {
    const container = document.createElement("div")
    container.innerHTML = renderToString(panel())
    const onRecoverableError = vi.fn()
    await reactAct(async () => { hydrateRoot(container, panel(), { onRecoverableError }) })
    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(container.textContent?.match(/Overdue/g)).toHaveLength(1)
    expect(container.textContent).toMatch(/Overdue\s*\d/)
  })
})
