import { beforeAll, afterAll, describe, expect, it, vi } from "vitest"
import { chatInline, chatLinks } from "./chat-format"

beforeAll(() => { vi.stubEnv("NEXT_PUBLIC_WEBSITE_URL", "https://www.acme-lending.example") })
afterAll(() => { vi.unstubAllEnvs() })

const hrefs = (text: string) => chatLinks(text).flatMap((p) => (p.href ? [p.href] : []))

describe("the link allowlist, pinned from the other side", () => {
  it.each(["/api/website/chat/poll", "/api/auth/session", "/admin", "/admin/users", "/dashboard", "/dashboard/loans", "/inbox", "/inbox/123", "/login"])(
    "%s is never linked",
    (path) => {
      expect(hrefs(`See ${path} now`)).toEqual([])
      expect(hrefs(`See ${path}.`)).toEqual([])
    },
  )

  it.each(["/sitemap.xml", "/sites", "/blog", "/blog/fees", "/blogger", "/blog-admin/x", "/portalx", "/portal2/x", "/site.php", "/siteadmin"])(
    "%s does not link as a /site or /portal path",
    (path) => {
      expect(hrefs(`Try ${path} please`)).toEqual([])
    },
  )

  it.each(["/site", "/site/apply", "/portal", "/portal/login"])("%s still links, ending at the path end", (path) => {
    expect(hrefs(`Try ${path} please`)).toEqual([path])
    expect(hrefs(`Try ${path}.`)).toEqual([path])
  })
})

describe("absolute links are held to the same paths", () => {
  const hosts = ["https://acme-lending.example", "https://www.acme-lending.example"]
  it.each(hosts)("%s links for the bare domain and /site, /portal paths only", (host) => {
    for (const ok of [host, `${host}/`, `${host}/site/apply`, `${host}/site/x`, `${host}/portal`, `${host}/site`]) {
      expect(hrefs(`See ${ok} now`)).toEqual([ok])
    }
    for (const bad of ["/admin", "/api/x", "/dashboard", "/login", "/inbox", "/sitemap.xml", "/sites", "/blogger", "/portalx"]) {
      expect(hrefs(`See ${host}${bad} now`)).toEqual([])
      expect(hrefs(`[x](${host}${bad})`)).toEqual([])
    }
  })

  it("https://portal.acme-lending.example links for the bare host and any path", () => {
    for (const ok of ["https://portal.acme-lending.example", "https://portal.acme-lending.example/login", "https://portal.acme-lending.example/apply/start"]) {
      expect(hrefs(`See ${ok} now`)).toEqual([ok])
    }
  })
})

describe("markdown links", () => {
  it("[text](relative allowlisted path) is one link with the text only", () => {
    expect(chatLinks("[Apply here](/site/apply)")).toEqual([{ text: "Apply here", href: "/site/apply" }])
  })

  it("[text](our https URL) is one link with the text only", () => {
    expect(chatLinks("[our site](https://acme-lending.example/site/apply)")).toEqual([
      { text: "our site", href: "https://acme-lending.example/site/apply" },
    ])
  })

  it("keeps the words around it, and links more than one", () => {
    expect(chatLinks("Start [here](/site/apply) or read [fees](/site/contact).")).toEqual([
      { text: "Start " },
      { text: "here", href: "/site/apply" },
      { text: " or read " },
      { text: "fees", href: "/site/contact" },
      { text: "." },
    ])
  })

  it.each([
    ["javascript:alert(1)", "[x](javascript:alert(1))"],
    ["an outside https URL", "[x](https://evil.example)"],
    ["a look-alike host", "[x](https://acme-lending.example.evil.example/site)"],
    ["a path off the list", "[x](/admin)"],
    ["a prefix bleed", "[x](/sitemap.xml)"],
    ["a query on the path", "[x](/site/apply?next=//evil.example)"],
    ["a protocol-relative URL", "[x](//evil.example/site/a)"],
    ["a data URL", "[x](data:text/html,hi)"],
    ["something in front of the path", "[x](#/site/apply)"],
    ["something after the path", "[x](/site/apply.)"],
  ])("a disallowed target (%s) renders only the text: no brackets, no URL, no href", (_n, md) => {
    expect(chatLinks(md)).toEqual([{ text: "x" }])
  })

  it("a link-looking label is never the thing that gets linked", () => {
    expect(chatLinks("[/site/apply](https://evil.example)")).toEqual([{ text: "/site/apply" }])
  })

  it("works inside bold and a list line, and the rest of the line still links", () => {
    expect(chatInline("**[Apply](/site/apply)** or /site/contact")).toEqual([
      { text: "Apply", href: "/site/apply", bold: true },
      { text: " or " },
      { text: "/site/contact", href: "/site/contact" },
    ])
  })

  it("brackets that are not a link stay as typed", () => {
    expect(chatLinks("[a] (b) [c](d e) []()")).toEqual([{ text: "[a] (b) [c](d e) []()" }])
  })

  it("is linear on hostile input", () => {
    const start = performance.now()
    chatLinks(`${"[".repeat(50_000)}x`)
    chatLinks(`[${"a".repeat(50_000)}`)
    chatLinks(`[x](${"/site/".repeat(20_000)}`)
    chatLinks(`${"[a](".repeat(20_000)}`)
    expect(performance.now() - start).toBeLessThan(1_000)
  })
})
