import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { SelfieLinkSection } from "./SelfieLinkSection"

describe("SelfieLinkSection", () => {
  it("shows the masked destination and never a secret", () => {
    const html = renderToStaticMarkup(
      <SelfieLinkSection
        applicationId="app1"
        latestToken={{
          channel: "WHATSAPP",
          sentTo: "*******1111",
          expiresAt: "2026-08-07T10:00:00.000Z",
          usedAt: null,
        }}
        smsEnabled
      />,
    )

    expect(html).toContain("*******1111")
    expect(html).toContain("WhatsApp")
    // 43-char base64url run would indicate a leaked secret.
    expect(html).not.toMatch(/[A-Za-z0-9_-]{43}/)
  })

  // Review of #152: a link the client opened in the portal was sent nowhere.
  it("names a portal hand-off as the Client portal, not a send to a masked destination", () => {
    const html = renderToStaticMarkup(
      <SelfieLinkSection
        applicationId="app1"
        latestToken={{ channel: "PORTAL", sentTo: "p****l", expiresAt: "2026-08-07T10:00:00.000Z", usedAt: null }}
        smsEnabled
      />,
    ).replace(/<!-- -->/g, "")
    expect(html).toContain("the client opened a link in the Client portal")
    expect(html).not.toContain("p****l")
    expect(html).not.toContain("sent by PORTAL")
  })

  it("states plainly when no link has been sent", () => {
    const html = renderToStaticMarkup(
      <SelfieLinkSection applicationId="app1" latestToken={null} smsEnabled />,
    )

    expect(html).toContain("No selfie link sent")
  })

  it("reports a used link as completed rather than still pending", () => {
    const html = renderToStaticMarkup(
      <SelfieLinkSection
        applicationId="app1"
        latestToken={{
          channel: "SMS",
          sentTo: "********0000",
          expiresAt: "2026-08-07T10:00:00.000Z",
          usedAt: "2026-08-06T11:00:00.000Z",
        }}
        smsEnabled
      />,
    )

    expect(html).toContain("Photo received")
    expect(html).not.toContain("Waiting for the consumer")
  })

  it("reports a live, unused link as still waiting", () => {
    const html = renderToStaticMarkup(
      <SelfieLinkSection
        applicationId="app1"
        latestToken={{
          channel: "SMS",
          sentTo: "********0000",
          expiresAt: "2026-08-07T10:00:00.000Z",
          usedAt: null,
        }}
        smsEnabled
      />,
    )

    expect(html).toContain("Waiting for the consumer")
    expect(html).not.toContain("Photo received")
  })

  it("offers all three channels the send route accepts", () => {
    const html = renderToStaticMarkup(
      <SelfieLinkSection applicationId="app1" latestToken={null} smsEnabled />,
    )

    expect(html).toContain("WhatsApp")
    expect(html).toContain("SMS")
    expect(html).toContain("Email")
  })

  // The route refuses an SMS send while the channel is off. A button that
  // errors 100% of the time is worse than no button, so it is not rendered.
  it("does not offer the SMS button when the channel is off", () => {
    const html = renderToStaticMarkup(
      <SelfieLinkSection applicationId="app1" latestToken={null} smsEnabled={false} />,
    )

    expect(html).not.toContain("Send link by SMS")
    expect(html).toContain("Send link by WhatsApp")
    expect(html).toContain("Send link by Email")
  })

  // The history line still names SMS for a link sent before the channel was
  // switched off — hiding the button must not rewrite what already happened.
  it("still reports a past SMS send when the channel is now off", () => {
    const html = renderToStaticMarkup(
      <SelfieLinkSection
        applicationId="app1"
        smsEnabled={false}
        latestToken={{
          channel: "SMS",
          sentTo: "********0000",
          expiresAt: "2026-08-07T10:00:00.000Z",
          usedAt: "2026-08-06T11:00:00.000Z",
        }}
      />,
    )

    expect(html).toContain("Photo received")
    expect(html).toContain("SMS")
    expect(html).not.toContain("Send link by SMS")
  })

  it("says the link goes to the number on file, so staff do not go looking for a destination field", () => {
    const html = renderToStaticMarkup(
      <SelfieLinkSection applicationId="app1" latestToken={null} smsEnabled />,
    )

    expect(html).toMatch(/on file/i)
  })
})
