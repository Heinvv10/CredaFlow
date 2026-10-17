import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { NotificationTabs } from "./NotificationTabs"
import type { BorrowerNotificationStatus } from "@/lib/portal/notification-status"

const item = (id: string, status: BorrowerNotificationStatus) => ({
  id, event: "loan_overdue", eventLabel: "loan overdue", channel: "WHATSAPP", status,
  createdAt: "2026-10-05T10:00:00.000Z", createdAtLabel: "5 Oct 2026, 12:00",
})

describe("NotificationTabs borrower statuses", () => {
  it("labels a delivered message Sent and a failed one Not delivered with the reassurance", () => {
    const html = renderToStaticMarkup(<NotificationTabs items={[item("a", "sent"), item("b", "not_delivered")]} />)
    expect(html).toContain(">Sent<")
    expect(html).toContain("Not delivered — we’ll contact you another way")
    expect(html).not.toContain("Failed")
    expect(html).not.toContain("Review required")
  })
})
