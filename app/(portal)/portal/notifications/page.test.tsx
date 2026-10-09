import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi, beforeEach } from "vitest"

const { authMock, clientFindFirst, notificationFindMany, getDefaultTenantIdMock, tabsProps } = vi.hoisted(() => ({
  authMock: vi.fn(),
  clientFindFirst: vi.fn(),
  notificationFindMany: vi.fn(),
  getDefaultTenantIdMock: vi.fn(),
  tabsProps: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: authMock }))
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: getDefaultTenantIdMock }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: clientFindFirst },
    notificationLog: { findMany: notificationFindMany },
  },
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
// Captures what the borrower would actually be shown, so these assert the
// rendered history rather than the shape of a query.
vi.mock("./NotificationTabs", () => ({
  NotificationTabs: (props: { items: unknown[] }) => {
    tabsProps(props)
    return null
  },
}))

import NotificationsPage from "./page"

type Row = {
  id: string
  event: string
  channel: string
  status: string
  error: string | null
  createdAt: Date
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "n1",
    event: "loan_overdue",
    channel: "email",
    status: "sent",
    error: null,
    createdAt: new Date("2026-09-20T08:00:00.000Z"),
    ...over,
  }
}

async function shownIds(rows: Row[]): Promise<string[]> {
  notificationFindMany.mockResolvedValue(rows)
  // The page is an async server component: awaiting it yields the element
  // tree, and rendering that tree is what actually invokes NotificationTabs.
  renderToStaticMarkup(await NotificationsPage())
  const items = tabsProps.mock.calls.at(-1)![0].items as Array<{ id: string }>
  return items.map((i) => i.id)
}

beforeEach(() => {
  vi.clearAllMocks()
  authMock.mockResolvedValue({ user: { email: "client@example.test" } })
  getDefaultTenantIdMock.mockResolvedValue("tn1")
  clientFindFirst.mockResolvedValue({ id: "cli1" })
  notificationFindMany.mockResolvedValue([])
})

// NotificationLog rows render in the CLIENT PORTAL. A leg we skipped because
// the LENDER switched that channel off is an internal operating fact — a
// borrower must not see a red "Blocked" line against an event that did reach
// them by email and WhatsApp. The row stays in the table for the audit trail.
describe("portal notifications — channel-disabled rows", () => {
  it("hides the SMS-channel-off row and keeps the rest of the event", async () => {
    const ids = await shownIds([
      row({ id: "email-sent" }),
      row({ id: "sms-off", channel: "sms", status: "blocked", error: "SMS not enabled" }),
      row({ id: "wa-sent", channel: "whatsapp" }),
    ])

    expect(ids).toEqual(["email-sent", "wa-sent"])
  })

  // `blocked` also carries consent suppression and "No WhatsApp on file",
  // which are facts about the borrower's own record.
  it("keeps every other blocked row", async () => {
    const ids = await shownIds([
      row({ id: "opted-out", status: "blocked", error: "Client opted out" }),
      row({ id: "no-wa", channel: "whatsapp", status: "blocked", error: "No WhatsApp on file" }),
      row({ id: "sms-off", channel: "sms", status: "blocked", error: "SMS not enabled" }),
    ])

    expect(ids).toEqual(["opted-out", "no-wa"])
  })

  // The exclusion must fail TOWARDS showing the borrower their own record.
  // As a Prisma `NOT (status='blocked' AND error=<const>)` this row vanished:
  // in SQL the inner AND is NULL for a null error, NOT NULL is NULL, and a
  // NULL predicate filters the row out. In JS the comparison is plainly false.
  it("keeps a blocked row that carries NO reason at all", async () => {
    const ids = await shownIds([
      row({ id: "blocked-null", status: "blocked", error: null }),
      row({ id: "blocked-empty", status: "blocked", error: "" }),
    ])

    expect(ids).toEqual(["blocked-null", "blocked-empty"])
  })

  // Rows written before this shipped are labelled "Simulated — not sent",
  // which is accurate. They are deliberately NOT swept up by the exclusion.
  it("leaves historical simulated SMS rows visible", async () => {
    const ids = await shownIds([
      row({ id: "old-sim", channel: "sms", status: "simulated", error: null }),
    ])

    expect(ids).toEqual(["old-sim"])
  })

  it("still scopes the query to the signed-in client and tenant", async () => {
    await NotificationsPage()

    expect(notificationFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "tn1", clientId: "cli1" } }),
    )
  })
})
