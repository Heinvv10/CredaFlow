import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))

import { ContactPanel } from "./ContactPanel"

function thread(channel: string, window: { open: boolean; expiresAt: string | null }, availableChannels: string[] = channel === "WHATSAPP" ? ["WHATSAPP"] : ["EMAIL"]) {
  return {
    conversation: { id: "cv1", channel, status: "OPEN", priority: "NORMAL" },
    contact: {
      displayName: "Thabo M", status: "CLIENT", primaryPhone: "27821234567",
      primaryWaJid: null, primaryEmail: "t@example.com", clientId: null, waOptedOut: false,
    },
    linked: { loan: null, application: null },
    window,
    messages: [],
    reply: { availableChannels, defaultChannel: channel },
  } as never
}

describe("ContactPanel 24h window badge", () => {
  it("shows the window on a WhatsApp thread", () => {
    const html = renderToStaticMarkup(<ContactPanel thread={thread("WHATSAPP", { open: true, expiresAt: "2026-08-12T19:51:26.000Z" })} />)
    expect(html).toContain("24h reply window open")
  })

  it("shows the closed state on a WhatsApp thread", () => {
    const html = renderToStaticMarkup(<ContactPanel thread={thread("WHATSAPP", { open: false, expiresAt: null })} />)
    expect(html).toContain("24h reply window closed")
  })

  // The 24h window and its "a template may be required" prompt are WhatsApp
  // rules. getThread computes the field for every channel, so without a gate an
  // email thread told the agent to reach for a template that does not exist.
  it("hides the window entirely when the contact cannot be reached on WhatsApp", () => {
    const html = renderToStaticMarkup(<ContactPanel thread={thread("EMAIL", { open: false, expiresAt: null })} />)
    expect(html).not.toContain("24h reply window")
    expect(html).not.toContain("template may be required")
  })

  // Conversation.channel is only the channel the thread was OPENED on. A
  // WhatsApp reminder filed into an email-opened thread still has a window.
  it("shows the window on an email-opened thread when the contact is reachable on WhatsApp", () => {
    const html = renderToStaticMarkup(<ContactPanel thread={thread("EMAIL", { open: false, expiresAt: null }, ["WHATSAPP", "EMAIL"])} />)
    expect(html).toContain("24h reply window closed")
  })

  it("hides the window on a WhatsApp-opened thread once WhatsApp is no longer a reply channel", () => {
    const html = renderToStaticMarkup(<ContactPanel thread={thread("WHATSAPP", { open: true, expiresAt: null }, ["EMAIL"])} />)
    expect(html).not.toContain("24h reply window")
  })
})
