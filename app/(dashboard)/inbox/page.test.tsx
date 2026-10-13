import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { readFile } from "node:fs/promises"

const mocks = vi.hoisted(() => ({
  requireCommsAgentPage: vi.fn(),
  hasMinRole: vi.fn(),
  count: vi.fn(),
  inboxClient: vi.fn(),
}))

vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgentPage: mocks.requireCommsAgentPage }))
vi.mock("@/lib/auth-guards", () => ({ hasMinRole: mocks.hasMinRole }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: vi.fn().mockResolvedValue("tenant-1") }))
vi.mock("@/lib/inbox/conversations", () => ({
  listConversations: vi.fn().mockResolvedValue({ conversations: [] }),
  resolveQueueForConversation: vi.fn().mockResolvedValue(null),
  getConversationSummary: vi.fn(),
}))
vi.mock("@/lib/inbox/canned-replies", () => ({ listCannedReplies: vi.fn().mockResolvedValue([]) }))
vi.mock("@/lib/inbox/roster", () => ({ listStaffForRoster: vi.fn().mockResolvedValue([]) }))
vi.mock("@/lib/prisma", () => ({ prisma: { message: { count: mocks.count } } }))
vi.mock("@/components/layout/Header", () => ({ Header: () => <div>Inbox header</div> }))
vi.mock("./InboxClient", () => ({ InboxClient: (props: unknown) => { mocks.inboxClient(props); return <div>Inbox client</div> } }))
vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))

import InboxPage from "./page"

describe("InboxPage reconciliation authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireCommsAgentPage.mockResolvedValue({ id: "agent-1", role: "COLLECTIONS_OFFICER" })
    mocks.count.mockResolvedValue(3)
  })

  it("does not query, count, link, or enable reconciliation for a lower-role comms agent", async () => {
    mocks.hasMinRole.mockReturnValue(false)

    const html = renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) }))

    expect(mocks.count).not.toHaveBeenCalled()
    expect(html).not.toContain("require provider reconciliation")
    expect(html).not.toContain("/inbox/reconciliation")
    expect(mocks.inboxClient).toHaveBeenCalledWith(expect.objectContaining({ canReconcile: false }))
  })

  it("shows the queue and enables controls for LOAN_ADMIN or above", async () => {
    mocks.hasMinRole.mockReturnValue(true)

    const html = renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) }))

    expect(mocks.count).toHaveBeenCalledOnce()
    expect(html).toContain("3 messages")
    expect(html).toContain("/inbox/reconciliation")
    expect(mocks.inboxClient).toHaveBeenCalledWith(expect.objectContaining({ canReconcile: true }))
  })

  it("lets only ADMIN and above release a colleague's website chat", async () => {
    mocks.hasMinRole.mockImplementation((_role: string, min: string) => min === "LOAN_ADMIN")
    renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) }))
    expect(mocks.hasMinRole).toHaveBeenCalledWith("COLLECTIONS_OFFICER", "ADMIN")
    expect(mocks.inboxClient).toHaveBeenLastCalledWith(expect.objectContaining({ canReconcile: true, canReleaseChats: false }))

    mocks.hasMinRole.mockReturnValue(true)
    renderToStaticMarkup(await InboxPage({ searchParams: Promise.resolve({}) }))
    expect(mocks.inboxClient).toHaveBeenLastCalledWith(expect.objectContaining({ canReleaseChats: true }))
  })

  it("uses channel-neutral inbox copy", async () => {
    const source = await readFile(new URL("./page.tsx", import.meta.url), "utf8")
    expect(source).not.toContain("WhatsApp agent inbox")
    expect(source).toContain('subtitle="Inbox')
  })
})
