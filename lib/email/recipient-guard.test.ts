import { describe, it, expect } from "vitest"

/** Tests pass explicit, partial environments; NodeJS.ProcessEnv requires NODE_ENV. */
const INTERNAL = "lender.example, acme.example"
const env = (e: Record<string, string> = {}) =>
  ({ EMAIL_INTERNAL_DOMAINS: INTERNAL, ...e }) as unknown as NodeJS.ProcessEnv
const bareEnv = (e: Record<string, string> = {}) => e as unknown as NodeJS.ProcessEnv
import {
  allowedDomains,
  blockedMessage,
  checkRecipient,
  deliveryMode,
  recipientDomainOf,
  extractAddressCandidates,
} from "./recipient-guard"

/**
 * Public consumer domains a non-production environment must never deliver
 * Section 129 statutory demands to. Every one must be refused by default.
 *
 * SYNTHETIC LOCAL PARTS ON PURPOSE. Real recipient addresses must not be
 * committed: they identify individuals, and pinning them in a repository — next
 * to a comment saying they received a debt-collection demand — would publish
 * that association to everyone with repository or history access, permanently.
 * The DOMAIN is the part under test; the mailbox is not.
 */
const PUBLIC_MAILBOXES = ["blocked.recipient@outlook.com", "blocked.recipient@gmail.com"]

/** The public domains the seed used to carry. */
const PUBLIC_DOMAINS = [
  "someone@gmail.com",
  "someone@outlook.com",
  "someone@yahoo.com",
  "someone@icloud.com",
  "someone@webmail.co.za",
  "someone@hotmail.com",
]

describe("delivery mode", () => {
  it("defaults to allowlist when nothing is configured — a new environment starts SAFE", () => {
    expect(deliveryMode(env())).toBe("allowlist")
  })

  it("only the exact string opts out, so a typo cannot silently open delivery", () => {
    for (const v of ["unresticted", "UNRESTRICTED", "true", "1", "yes", " unrestricted"]) {
      expect(deliveryMode(env({ EMAIL_DELIVERY_MODE: v }))).toBe("allowlist")
    }
    expect(deliveryMode(env({ EMAIL_DELIVERY_MODE: "unrestricted" }))).toBe("unrestricted")
  })

  it("NODE_ENV=production does NOT open delivery — staging sets it too", () => {
    // Staging and production run the same image and both set
    // NODE_ENV=production. A guard keyed on it would be absent exactly where
    // it is needed.
    expect(deliveryMode(env({ NODE_ENV: "production" }))).toBe("allowlist")
  })
})

describe("the incident must not be repeatable", () => {
  it.each(PUBLIC_MAILBOXES)("refuses %s by default", (address) => {
    const d = checkRecipient(address, env())
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe("recipient_domain_not_allowlisted")
  })

  it.each(PUBLIC_DOMAINS)("refuses %s by default", (address) => {
    expect(checkRecipient(address, env()).allowed).toBe(false)
  })

  it("production, explicitly opted out, still reaches real customers", () => {
    for (const address of [...PUBLIC_MAILBOXES, ...PUBLIC_DOMAINS]) {
      expect(checkRecipient(address, env({ EMAIL_DELIVERY_MODE: "unrestricted" })).allowed).toBe(true)
    }
  })
})

describe("allowlist matching", () => {
  it("permits company domains and their subdomains", () => {
    for (const a of ["ops@lender.example", "noreply@acme.example", "x@mail.lender.example"]) {
      expect(checkRecipient(a, env()).allowed).toBe(true)
    }
  })

  it("permits .invalid, which RFC 2606 guarantees can never resolve", () => {
    expect(checkRecipient("sipho.nkosi@lender-e2e.invalid", env()).allowed).toBe(true)
  })

  it("does NOT admit a lookalike domain that merely ends with an allowed one", () => {
    // A plain endsWith() would let an attacker-registered "notlender.co.za"
    // or "evil-lender.co.za" through. The match is on a dot boundary.
    for (const a of ["x@notlender.co.za", "x@evillender.co.za", "x@lender.example.attacker.com"]) {
      expect(checkRecipient(a, env()).allowed).toBe(false)
    }
  })

  it("honours extra domains from EMAIL_RECIPIENT_ALLOWLIST", () => {
    const allow = env({ EMAIL_RECIPIENT_ALLOWLIST: "internal.example, partner.example ,@other.example" })
    for (const a of ["staff@internal.example", "ai@partner.example", "x@other.example"]) {
      expect(checkRecipient(a, allow).allowed).toBe(true)
    }
    // …and adding one does not open everything else
    expect(checkRecipient("someone@gmail.com", allow).allowed).toBe(false)
  })

  it("with EMAIL_INTERNAL_DOMAINS unset, only .invalid is reachable — unconfigured fails closed", () => {
    expect(allowedDomains(bareEnv())).toEqual(["invalid"])
    expect(checkRecipient("ops@lender.example", bareEnv()).allowed).toBe(false)
    expect(checkRecipient("x@nobody.invalid", bareEnv()).allowed).toBe(true)
  })

  it("keeps the defaults even when an allowlist is supplied", () => {
    expect(allowedDomains(env({ EMAIL_RECIPIENT_ALLOWLIST: "internal.example" }))).toEqual(
      expect.arrayContaining(["lender.example", "acme.example", "invalid", "internal.example"]),
    )
  })
})

describe("address parsing refuses rather than guesses", () => {
  it("takes the LAST @, so a quoted local part cannot smuggle a domain", () => {
    expect(recipientDomainOf('"victim@gmail.com"@lender.example')).toBe("lender.example")
    // and the reverse must NOT be admitted by the allowlist
    expect(checkRecipient('"ops@lender.example"@gmail.com', env()).allowed).toBe(false)
  })

  it.each(["", "no-at-sign", "trailing@", "@leading"])("refuses unparseable %s", (address) => {
    const d = checkRecipient(address, env())
    expect(d.allowed).toBe(false)
    // "@leading" parses to an empty domain; either reason is a refusal.
    expect(["recipient_address_unparseable", "recipient_domain_not_allowlisted"]).toContain(d.reason)
  })

  it("is case-insensitive on the domain", () => {
    expect(checkRecipient("OPS@LENDER.EXAMPLE", env()).allowed).toBe(true)
    expect(checkRecipient("SOMEONE@GMAIL.COM", env()).allowed).toBe(false)
  })
})

describe("the block explains itself to whoever finds it", () => {
  it("names the domain, the mode, what is permitted, and how to change it", () => {
    const address = "blocked.recipient@outlook.com"
    const msg = blockedMessage(address, checkRecipient(address, env()))
    expect(msg).toContain("outlook.com")
    expect(msg).toContain("allowlist")
    expect(msg).toContain("EMAIL_DELIVERY_MODE=unrestricted")
    expect(msg).toContain("lender.example")
  })
})

describe("a recipient LIST cannot smuggle a stranger past the guard", () => {
  // `to` is typed as one string, but SMTP accepts a list and nodemailer expands
  // it. A check that looked at the last mailbox saw only the allowlisted one
  // and delivered to both. Reachable: CRM messaging forwards a lead's email
  // value straight into `to`, unconstrained.
  it("refuses when ANY mailbox in the list is disallowed", () => {
    for (const list of [
      "victim@gmail.com, ops@lender.example",
      "ops@lender.example, victim@gmail.com",
      "ops@lender.example; victim@gmail.com",
      "ops@lender.example, a@lender.example, victim@outlook.com",
    ]) {
      const d = checkRecipient(list, env())
      expect(d.allowed).toBe(false)
      expect(d.blockedRecipients?.[0]).toMatch(/gmail\.com|outlook\.com/)
    }
  })

  it("allows a list where every mailbox is allowlisted", () => {
    expect(checkRecipient("ops@lender.example, a@acme.example", env()).allowed).toBe(true)
  })

  it("does not treat a comma inside a quoted display name as a separator", () => {
    expect(checkRecipient('"Doe, John" <john@lender.example>', env()).allowed).toBe(true)
    expect(checkRecipient('"Doe, John" <john@gmail.com>', env()).allowed).toBe(false)
  })

  it("reads the address out of a display-name form rather than the label", () => {
    expect(checkRecipient("Lender Ops <victim@gmail.com>", env()).allowed).toBe(false)
    expect(checkRecipient("ops@lender.example <victim@gmail.com>", env()).allowed).toBe(false)
  })

  it("refuses a SPACE-separated pair — nodemailer dispatches the FIRST one", () => {
    // Verified against nodemailer/lib/addressparser: it resolves
    // "victim@gmail.com ops@lender.example" to ["victim@gmail.com"], i.e. the
    // victim, while a comma-splitter saw one allowlisted mailbox.
    expect(checkRecipient("victim@gmail.com ops@lender.example", env()).allowed).toBe(false)
    expect(checkRecipient("ops@lender.example victim@gmail.com", env()).allowed).toBe(false)
  })

  it("extracts every @-bearing token, whatever the separator", () => {
    expect(extractAddressCandidates("a@x.com, b@y.com; c@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"])
    expect(extractAddressCandidates('"A, B" <a@x.com>, c@z.com')).toEqual(["a@x.com", "c@z.com"])
    expect(extractAddressCandidates("a@x.com\tb@y.com\nc@z.com")).toEqual(["a@x.com", "b@y.com", "c@z.com"])
  })
})

describe("differential: whatever nodemailer would dispatch, this guard checked", () => {
  // The guard deliberately does not replicate a mailbox parser. This proves the
  // weaker property that actually matters: for every address nodemailer's own
  // parser would put on the wire, our candidate extraction saw it too — so an
  // address can never be dispatched without having been allowlisted.
  //
  // Two prior revisions failed exactly here, each bypassed by a separator the
  // hand-rolled parser did not model.
  const ADVERSARIAL = [
    "victim@gmail.com ops@lender.example",
    "ops@lender.example victim@gmail.com",
    "victim@gmail.com, ops@lender.example",
    "ops@lender.example, victim@gmail.com",
    "ops@lender.example; victim@gmail.com",
    '"Doe, John" <victim@gmail.com>',
    "Ops <victim@gmail.com>",
    "victim@gmail.com <ops@lender.example>",
    "ops@lender.example\tvictim@gmail.com",
    "  victim@gmail.com  ",
  ]

  it.each(ADVERSARIAL)("covers every dispatched address in %j", async (value) => {
    const { default: addressparser } = await import("nodemailer/lib/addressparser/index.js")
    const dispatched: string[] = (addressparser(value) as { address?: string }[])
      .map((a) => (a.address ?? "").toLowerCase())
      .filter(Boolean)
    const seen = extractAddressCandidates(value).map((a) => a.toLowerCase())
    for (const addr of dispatched) {
      expect(seen).toContain(addr)
    }
  })

  it("refuses every adversarial value that carries a public mailbox", () => {
    for (const value of ADVERSARIAL) {
      expect(checkRecipient(value, env()).allowed).toBe(false)
    }
  })
})
