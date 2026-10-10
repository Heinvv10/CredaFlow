import { describe, expect, it } from "vitest"
import { isPublicOperationalRoute } from "../public-routes"

describe("isPublicOperationalRoute", () => {
  it("allows the health endpoint without making other API routes public", () => {
    expect(isPublicOperationalRoute("/api/health")).toBe(true)
    expect(isPublicOperationalRoute("/api/health/extra")).toBe(false)
    expect(isPublicOperationalRoute("/api/clients")).toBe(false)
  })

  it("allows the cron route family (handler enforces x-cron-secret)", () => {
    expect(isPublicOperationalRoute("/api/cron/messaging-retry")).toBe(true)
    expect(isPublicOperationalRoute("/api/cron/")).toBe(true)
    expect(isPublicOperationalRoute("/api/cron")).toBe(false)
  })

  it("allows inbound provider webhook routes under /api/webhooks/* (handlers enforce HMAC)", () => {
    // /api/webhooks/whatsapp is a real route. The remaining names are
    // hypothetical — they exercise the prefix matcher against the path shapes
    // other provider webhooks would use.
    expect(isPublicOperationalRoute("/api/webhooks/whatsapp")).toBe(true)
    expect(isPublicOperationalRoute("/api/webhooks/example-provider")).toBe(true)
    expect(isPublicOperationalRoute("/api/webhooks/some-future-route")).toBe(true)
    expect(isPublicOperationalRoute("/api/webhooks/")).toBe(true)
    // No trailing slash → not under the prefix.
    expect(isPublicOperationalRoute("/api/webhooks")).toBe(false)
  })

  it("allows the one-time consumer selfie capture link family", () => {
    // The handler authenticates on the high-entropy secret in the path; the
    // consumer has no portal account and therefore no session.
    expect(isPublicOperationalRoute("/api/selfie-link/abc/capture")).toBe(true)
    expect(isPublicOperationalRoute("/api/selfie-link/")).toBe(true)
    // No trailing slash → not under the prefix.
    expect(isPublicOperationalRoute("/api/selfie-link")).toBe(false)
    // The staff route that MINTS a link stays session-gated.
    expect(isPublicOperationalRoute("/api/applications/app1/selfie/send-link")).toBe(false)
    // Nothing else under /api/documents becomes public by association.
    expect(isPublicOperationalRoute("/api/documents/selfie")).toBe(false)
  })

  it("allows the RFC 8058 List-Unsubscribe endpoint and its trailing-slash variant", () => {
    expect(isPublicOperationalRoute("/api/messaging/unsubscribe")).toBe(true)
    expect(isPublicOperationalRoute("/api/messaging/unsubscribe/")).toBe(true)
    // Sibling /api/messaging/* paths and deeper sub-paths stay session-gated.
    expect(isPublicOperationalRoute("/api/messaging/unsubscribe/extra")).toBe(false)
    expect(isPublicOperationalRoute("/api/messaging")).toBe(false)
    expect(isPublicOperationalRoute("/api/messaging/send")).toBe(false)
  })
})
