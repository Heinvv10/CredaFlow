import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {
  messageTemplate: { findUnique: vi.fn(), update: vi.fn() },
} }))
vi.mock("./graph-templates", () => ({ createWabaTemplate: vi.fn() }))
vi.mock("@/lib/whatsapp-cloud-config", () => ({ getWabaTemplateCreds: vi.fn() }))

import { prisma } from "@/lib/prisma"
import { createWabaTemplate } from "./graph-templates"
import { getWabaTemplateCreds } from "@/lib/whatsapp-cloud-config"
import { submitTemplateForApproval, wabaFieldsChanged } from "./template-submit"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getWabaTemplateCreds).mockResolvedValue({ wabaId: "WABA1", accessToken: "TOK" })
})

describe("wabaFieldsChanged", () => {
  it("is true when a WABA-relevant field differs, false otherwise", () => {
    const base = { wabaTemplateName: "a", language: "en", headerContent: null, bodyTemplate: "x", footer: null, buttons: null }
    expect(wabaFieldsChanged(base, { ...base, bodyTemplate: "y" })).toBe(true)
    expect(wabaFieldsChanged(base, { ...base })).toBe(false)
    expect(wabaFieldsChanged(null, base)).toBe(true)
  })
})

describe("submitTemplateForApproval", () => {
  it("creates the template in Meta and stores providerTemplateId + PENDING", async () => {
    vi.mocked(prisma.messageTemplate.findUnique).mockResolvedValue({
      id: "tpl1", tenantId: "tn1", wabaTemplateName: "review_ask", language: "en",
      product: "GENERAL", bodyTemplate: "Hi {{name}}", headerContent: null,
    } as never)
    vi.mocked(createWabaTemplate).mockResolvedValue({ id: "TID", status: "PENDING" })

    const r = await submitTemplateForApproval("tn1", "tpl1")

    expect(createWabaTemplate).toHaveBeenCalledWith(
      { wabaId: "WABA1", accessToken: "TOK" },
      expect.objectContaining({ name: "review_ask", language: "en" }),
    )
    expect(prisma.messageTemplate.update).toHaveBeenCalledWith({
      where: { id: "tpl1", tenantId: "tn1" },
      data: { providerTemplateId: "TID", providerStatus: "PENDING" },
    })
    expect(r).toEqual({ submitted: true, providerStatus: "PENDING" })
  })

  it("skips templates without a wabaTemplateName", async () => {
    vi.mocked(prisma.messageTemplate.findUnique).mockResolvedValue({ id: "tpl1", tenantId: "tn1", wabaTemplateName: null } as never)
    const r = await submitTemplateForApproval("tn1", "tpl1")
    expect(r).toEqual({ submitted: false })
    expect(createWabaTemplate).not.toHaveBeenCalled()
  })

  // The CREATE endpoint takes the definition shape. Sending the send-time
  // shape ({type:"body", parameters:[…]}) is what the removed UNTESTED marker
  // warned about — Meta rejects it.
  it("submits Meta's definition shape, not the send-time parameter shape", async () => {
    vi.mocked(prisma.messageTemplate.findUnique).mockResolvedValue({
      id: "tpl1", tenantId: "tn1", wabaTemplateName: "review_ask", language: "en",
      bodyTemplate: "Hi {{name}}, ref {{ref}}", headerContent: "Update {{name}}",
      footer: "Acme Lending", buttons: null,
    } as never)
    vi.mocked(createWabaTemplate).mockResolvedValue({ id: "TID", status: "PENDING" })

    await submitTemplateForApproval("tn1", "tpl1")

    expect(createWabaTemplate).toHaveBeenCalledWith(
      { wabaId: "WABA1", accessToken: "TOK" },
      {
        name: "review_ask", language: "en", category: "UTILITY",
        components: [
          { type: "HEADER", format: "TEXT", text: "Update {{1}}", example: { header_text: ["name"] } },
          { type: "BODY", text: "Hi {{1}}, ref {{2}}", example: { body_text: [["name", "ref"]] } },
          { type: "FOOTER", text: "Acme Lending" },
        ],
      },
    )
  })

  // An empty buttons array means "no buttons" — a natural default once the
  // template editor ships. It must stay submittable.
  it("submits normally when buttons is an empty array", async () => {
    vi.mocked(prisma.messageTemplate.findUnique).mockResolvedValue({
      id: "tpl1", tenantId: "tn1", wabaTemplateName: "review_ask", language: "en",
      bodyTemplate: "Hi {{name}}", headerContent: null, footer: null, buttons: [],
    } as never)
    vi.mocked(createWabaTemplate).mockResolvedValue({ id: "TID", status: "PENDING" })

    await expect(submitTemplateForApproval("tn1", "tpl1")).resolves.toEqual({
      submitted: true, providerStatus: "PENDING",
    })
    expect(createWabaTemplate).toHaveBeenCalled()
  })

  // A non-array JSON value is a shape we cannot translate at all — refuse it
  // rather than dropping it, same as a populated array.
  it("refuses a non-array buttons value", async () => {
    vi.mocked(prisma.messageTemplate.findUnique).mockResolvedValue({
      id: "tpl1", tenantId: "tn1", wabaTemplateName: "review_ask", language: "en",
      bodyTemplate: "Hi {{name}}", headerContent: null, footer: null, buttons: { type: "QUICK_REPLY" },
    } as never)

    await expect(submitTemplateForApproval("tn1", "tpl1")).rejects.toThrow(/button/i)
    expect(createWabaTemplate).not.toHaveBeenCalled()
  })

  it("submits stored buttons as a BUTTONS component", async () => {
    vi.mocked(prisma.messageTemplate.findUnique).mockResolvedValue({
      id: "tpl1", tenantId: "tn1", wabaTemplateName: "review_ask", language: "en",
      bodyTemplate: "Hi {{name}}", headerContent: null, footer: null,
      buttons: [
        { type: "QUICK_REPLY", text: "Yes" },
        { type: "URL", text: "View statement", url: "https://portal.x.co.za/loans" },
      ],
    } as never)
    vi.mocked(createWabaTemplate).mockResolvedValue({ id: "TID", status: "PENDING" })

    await submitTemplateForApproval("tn1", "tpl1")

    expect(createWabaTemplate).toHaveBeenCalledWith(
      { wabaId: "WABA1", accessToken: "TOK" },
      expect.objectContaining({
        components: [
          { type: "BODY", text: "Hi {{1}}", example: { body_text: [["name"]] } },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Yes" },
              { type: "URL", text: "View statement", url: "https://portal.x.co.za/loans" },
            ],
          },
        ],
      }),
    )
  })

  // A template we cannot faithfully build must not cost a credential read.
  it("validates the payload before reading credentials", async () => {
    vi.mocked(prisma.messageTemplate.findUnique).mockResolvedValue({
      id: "tpl1", tenantId: "tn1", wabaTemplateName: "review_ask", language: "en",
      bodyTemplate: "Hi {{name}}", headerContent: null, footer: null,
      buttons: [{ type: "QUICK_REPLY", text: "x".repeat(26) }],
    } as never)

    await expect(submitTemplateForApproval("tn1", "tpl1")).rejects.toThrow(/25/)
    expect(getWabaTemplateCreds).not.toHaveBeenCalled()
  })

  // An untranslatable buttons value must fail loud, not be silently dropped —
  // Meta would otherwise approve a template the operator never sees rendered.
  it("refuses a buttons value Meta would reject", async () => {
    vi.mocked(prisma.messageTemplate.findUnique).mockResolvedValue({
      id: "tpl1", tenantId: "tn1", wabaTemplateName: "review_ask", language: "en",
      bodyTemplate: "Hi {{name}}", headerContent: null, footer: null,
      buttons: [{ type: "QUICK_REPLY", text: "x".repeat(26) }],
    } as never)

    await expect(submitTemplateForApproval("tn1", "tpl1")).rejects.toThrow(/25/)
    expect(createWabaTemplate).not.toHaveBeenCalled()
  })
})
