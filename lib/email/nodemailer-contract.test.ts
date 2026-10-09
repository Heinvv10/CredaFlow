/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Nodemailer option-contract test — runs against the REAL installed nodemailer.
 *
 * Every other suite that touches the SMTP path replaces `createTransport`
 * wholesale with a `vi.fn()`, so it asserts only what `sendViaSMTP` *passes*.
 * A mock accepts any option name, including ones nodemailer has renamed or
 * dropped — so those suites stay green across a breaking major and prove
 * nothing about whether the message we think we're sending is the message
 * that gets built.
 *
 * Here only the TRANSPORT is swapped, for nodemailer's own in-memory stream
 * transport. The message compiler is the installed nodemailer, so the
 * assertions below are made against real RFC 5322 output. If a future upgrade
 * changes the contract for any option `sendViaSMTP` depends on, this fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { simpleParser, type AddressObject } from "mailparser"

// mailparser types `to` as AddressObject | AddressObject[] (a group address
// yields the array form). Flatten to the address list so recipient-count
// assertions hold in either shape.
const addresses = (a: AddressObject | AddressObject[] | undefined) =>
  (Array.isArray(a) ? a : a ? [a] : []).flatMap((x) => x.value)

const captured = vi.hoisted(() => ({ mime: "" }))

vi.mock("nodemailer", async () => {
  const actual = await vi.importActual<any>("nodemailer")
  return {
    default: {
      createTransport: () => {
        // buffer:true makes info.message the fully compiled MIME message.
        const real = actual.createTransport({ streamTransport: true, buffer: true })
        return {
          sendMail: async (opts: any) => {
            const info = await real.sendMail(opts)
            captured.mime = info.message.toString("utf8")
            return info
          },
          close: () => {},
        }
      },
    },
  }
})

const findUniqueMock = vi.fn()
const emailLogCreateMock = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailConfig: { findUnique: (...a: any[]) => findUniqueMock(...a) },
    emailLog: { create: (...a: any[]) => emailLogCreateMock(...a) },
  },
}))

import { sendEmail } from "./service"

// These suites exercise DISPATCH mechanics against customer@example.com, which
// the recipient allowlist correctly refuses by default (lib/email/recipient-guard.ts).
// Opt out EXPLICITLY rather than adding example.com to the defaults: the point
// of the guard is that a non-production environment reaches nobody it should
// not, and a test fixture is not a reason to widen that. Anyone adding a
// dispatch test has to see this and decide deliberately.
beforeEach(() => {
  process.env.EMAIL_DELIVERY_MODE = "unrestricted"
})
afterEach(() => {
  delete process.env.EMAIL_DELIVERY_MODE
})


const baseConfig = {
  provider: "IMAP_SMTP",
  active: true,
  fromName: "Acme Lending",
  fromAddress: "noreply@lender.example",
  smtpHost: "smtp.lender.example",
  smtpPort: 465,
  smtpUser: "noreply@lender.example",
  smtpPass: "pw",
  useTls: true,
  replyToAddress: null as string | null,
}

const send = (extra: Record<string, unknown> = {}) =>
  sendEmail({ tenantId: "t", to: "customer@example.com", subject: "Your statement", html: "<p>h</p>", ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  captured.mime = ""
  findUniqueMock.mockResolvedValue({ ...baseConfig })
  emailLogCreateMock.mockResolvedValue(undefined)
})

describe("nodemailer option contract (real compiler)", () => {
  it("accepts the send and returns a provider message id", async () => {
    const r = await send()
    expect(r.ok).toBe(true)
    expect(r.providerOutcome).toBe("ACCEPTED")
    expect(r.messageId).toMatch(/@/)
    expect(captured.mime).not.toBe("")
  })

  it("renders the From display name and the Subject", async () => {
    await send()
    const parsed = await simpleParser(captured.mime)
    expect(parsed.from?.value[0]).toMatchObject({
      name: "Acme Lending",
      address: "noreply@lender.example",
    })
    expect(parsed.subject).toBe("Your statement")
  })

  it("compiles both the html and the text alternative", async () => {
    await send({ html: "<p>hello</p>", text: "hello" })
    const parsed = await simpleParser(captured.mime)
    expect(parsed.html).toContain("hello")
    expect(parsed.text?.trim()).toBe("hello")
  })

  // THE SECURITY-CRITICAL ONE. sendViaSMTP passes a hostile display name as a
  // structured {name,address} rather than interpolating `"name" <addr>`,
  // specifically so a crafted name cannot smuggle a second recipient. That
  // claim is about NODEMAILER's encoder, so only the real encoder can confirm
  // it. Asserting on the parsed address list (not a substring of the raw
  // header) is deliberate: the attacker string legitimately appears INSIDE the
  // quoted display name, so a `not.toContain` check would fail for the wrong
  // reason. What matters is how many addresses a parser extracts.
  it("encodes a hostile display name without smuggling a second recipient", async () => {
    await send({ toName: 'Sipho" <attacker@evil.test>, "' })
    const parsed = await simpleParser(captured.mime)
    expect(addresses(parsed.to)).toHaveLength(1)
    expect(addresses(parsed.to)[0].address).toBe("customer@example.com")
  })

  it("sends a bare address when no display name is given", async () => {
    await send()
    const parsed = await simpleParser(captured.mime)
    expect(addresses(parsed.to)).toHaveLength(1)
    expect(addresses(parsed.to)[0].address).toBe("customer@example.com")
  })

  it("emits Reply-To from the replyTo option", async () => {
    await send({ replyTo: "collections@lender.example" })
    const parsed = await simpleParser(captured.mime)
    expect(parsed.replyTo?.value[0].address).toBe("collections@lender.example")
  })

  it("emits In-Reply-To and References from the threading options", async () => {
    await send({ inReplyTo: "<c1@mail>", references: ["<c1@mail>", "<a1@acme>"] })
    const parsed = await simpleParser(captured.mime)
    expect(parsed.inReplyTo).toBe("<c1@mail>")
    expect(parsed.references).toEqual(["<c1@mail>", "<a1@acme>"])
  })

  it("emits the custom X-Lms-* and List-Unsubscribe headers", async () => {
    await send({
      category: "statement",
      referenceId: "loan-123",
      listUnsubscribeUrl: "https://portal.lender.example/unsub/abc",
    })
    const parsed = await simpleParser(captured.mime)
    expect(parsed.headers.get("x-lms-category")).toBe("statement")
    expect(parsed.headers.get("x-lms-ref")).toBe("loan-123")
    expect(captured.mime).toContain("List-Unsubscribe: <https://portal.lender.example/unsub/abc>")
    expect(captured.mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click")
  })

  it("attaches a Buffer attachment and an inline cid attachment", async () => {
    await send({
      attachments: [
        { filename: "agreement.pdf", content: Buffer.from("%PDF-1.4 fake"), contentType: "application/pdf" },
        { filename: "letterhead.png", content: Buffer.from("\x89PNG fake"), contentType: "image/png", cid: "letterhead" },
      ],
    })
    const parsed = await simpleParser(captured.mime)
    expect(parsed.attachments).toHaveLength(2)

    const pdf = parsed.attachments.find((a) => a.filename === "agreement.pdf")
    expect(pdf?.contentType).toBe("application/pdf")
    expect(pdf?.content.toString()).toBe("%PDF-1.4 fake")
    expect(pdf?.contentDisposition).toBe("attachment")

    const png = parsed.attachments.find((a) => a.filename === "letterhead.png")
    expect(png?.contentType).toBe("image/png")
    expect(png?.contentDisposition).toBe("inline")
    // cid is what makes <img src="cid:letterhead"> resolve in the client.
    expect(png?.cid).toBe("letterhead")
  })
})
