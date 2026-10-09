import { beforeAll, afterAll, describe, expect, it, vi } from "vitest"
import { chatBlocks, chatInline, chatLinks } from "./chat-format"

beforeAll(() => { vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "https://www.acme-lending.example") })
afterAll(() => { vi.unstubAllEnvs() })

const t = (text: string) => ({ text })

describe("chatBlocks", () => {
  it("a documents answer seen on staging: an intro paragraph and a bullet list", () => {
    const reply = "You'll usually need these documents:\n\n- A valid South African ID\n- Recent proof of income (a payslip or bank statements)\n- Three months' bank statements\n\nA consultant can confirm what applies to you."
    expect(chatBlocks(reply)).toEqual([
      { kind: "p", lines: [[t("You'll usually need these documents:")]] },
      { kind: "ul", items: [[t("A valid South African ID")], [t("Recent proof of income (a payslip or bank statements)")], [t("Three months' bank statements")]] },
      { kind: "p", lines: [[t("A consultant can confirm what applies to you.")]] },
    ])
  })

  it("a rates answer seen on staging: bullets that start in bold", () => {
    const reply = "- **Short-term loans:** 5% per month, accrued daily\n- **Personal loans:** see the product page"
    expect(chatBlocks(reply)).toEqual([
      {
        kind: "ul",
        items: [
          [{ text: "Short-term loans:", bold: true }, t(" 5% per month, accrued daily")],
          [{ text: "Personal loans:", bold: true }, t(" see the product page")],
        ],
      },
    ])
  })

  it("keeps single line breaks inside a paragraph and splits paragraphs on a blank line", () => {
    expect(chatBlocks("Line one\nLine two\n\nNext paragraph")).toEqual([
      { kind: "p", lines: [[t("Line one")], [t("Line two")]] },
      { kind: "p", lines: [[t("Next paragraph")]] },
    ])
  })

  it("takes -, * and • as bullets, and a blank line between items does not break the list", () => {
    expect(chatBlocks("* one\n\n• two\n-   three")).toEqual([{ kind: "ul", items: [[t("one")], [t("two")], [t("three")]] }])
  })

  it("numbered lists keep their first number", () => {
    expect(chatBlocks("Steps:\n1. Apply online\n2. Upload documents")).toEqual([
      { kind: "p", lines: [[t("Steps:")]] },
      { kind: "ol", start: 1, items: [[t("Apply online")], [t("Upload documents")]] },
    ])
    expect(chatBlocks("3. Sign")).toEqual([{ kind: "ol", start: 3, items: [[t("Sign")]] }])
  })

  it("a line after a list starts a paragraph, and a bullet after a numbered item starts a new list", () => {
    expect(chatBlocks("1. one\n- dash\nafter")).toEqual([
      { kind: "ol", start: 1, items: [[t("one")]] },
      { kind: "ul", items: [[t("dash")]] },
      { kind: "p", lines: [[t("after")]] },
    ])
  })

  it("anything else stays literal: headings, unpaired asterisks, a dash with no space, windows line ends", () => {
    expect(chatBlocks("# Heading\n**not closed\n-no space\r\n5*3 = 15")).toEqual([
      { kind: "p", lines: [[t("# Heading")], [t("**not closed")], [t("-no space")], [t("5*3 = 15")]] },
    ])
  })
})

describe("chatInline", () => {
  it("bolds what sits between double asterisks and leaves no asterisks behind", () => {
    expect(chatInline("Fees are **capped** by **the NCA**.")).toEqual([
      t("Fees are "), { text: "capped", bold: true }, t(" by "), { text: "the NCA", bold: true }, t("."),
    ])
  })

  it("links inside bold text are links and bold", () => {
    expect(chatInline("**Apply at /site/apply**")).toEqual([
      { text: "Apply at ", bold: true }, { text: "/site/apply", href: "/site/apply", bold: true },
    ])
  })
})

describe("chatLinks", () => {
  const href = (text: string) => chatLinks(text).filter((p) => p.href).map((p) => p.href)

  it.each([
    ["/site/apply", "/site/apply"],
    ["/site", "/site"],
    ["/portal", "/portal"],
    ["/site/calculators", "/site/calculators"],
    ["/portal/login", "/portal/login"],
    ["https://acme-lending.example/site/apply", "https://acme-lending.example/site/apply"],
    ["https://www.acme-lending.example/site/contact", "https://www.acme-lending.example/site/contact"],
    ["https://portal.acme-lending.example/", "https://portal.acme-lending.example/"],
    ["https://acme-lending.example", "https://acme-lending.example"],
    ["info@acme-lending.example", "mailto:info@acme-lending.example"],
    ["complaints.team@acme-lending.example", "mailto:complaints.team@acme-lending.example"],
  ])("links %s", (text, expected) => {
    expect(chatLinks(`See ${text} for more`)).toEqual([t("See "), { text, href: expected }, t(" for more")])
  })

  it("keeps trailing punctuation out of the link", () => {
    expect(chatLinks("Apply at /site/apply.")).toEqual([t("Apply at "), { text: "/site/apply", href: "/site/apply" }, t(".")])
    expect(href("(see /site/contact), then /portal/login, or info@acme-lending.example.")).toEqual(["/site/contact", "/portal/login", "mailto:info@acme-lending.example"])
    expect(href("Is it https://acme-lending.example/site/apply?")).toEqual(["https://acme-lending.example/site/apply"])
  })

  it.each([
    ["another domain", "https://evil.example/site/apply"],
    ["a protocol-relative url", "//evil.example/x"],
    ["a protocol-relative path", "//site/x"],
    ["a javascript: url", "javascript:/site/x"],
    ["a query string", "/site/apply?next=https://evil.example"],
    ["a fragment", "/site/apply#x"],
    ["a file extension", "/site/apply.html"],
    ["a path that only starts like ours", "/sites/x"],
    ["a longer first segment", "/blogger"],
    ["plain http", "http://acme-lending.example/site/apply"],
    ["our name inside another host", "https://acme-lending.example.evil.example/site"],
    ["our name as a subdomain of another", "https://www.acme-lending.example-evil.example/"],
    ["userinfo before another host", "https://acme-lending.example@evil.example/"],
    ["a port", "https://acme-lending.example:8443/site"],
    ["another subdomain", "https://admin.acme-lending.example/site"],
    ["an email on another domain", "help@evil.example"],
    ["an email on a lookalike domain", "help@acme-lending.example.evil.example"],
    ["a mailto already written", "mailto:info@acme-lending.example"],
    ["a path glued to a word", "evil.example/site/apply"],
  ])("does not link %s", (_name, text) => {
    expect(href(`x ${text} y`)).toEqual([])
  })

  it("returns plain text untouched, and nothing for nothing", () => {
    expect(chatLinks("No links here.")).toEqual([t("No links here.")])
    expect(chatLinks("")).toEqual([])
  })
})
