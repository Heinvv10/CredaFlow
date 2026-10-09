import { describe, it, expect } from "vitest"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import {
  LEAD_OUTREACH,
  LEAD_OUTREACH_KINDS,
  AGENT_NAME_FALLBACK,
  MAX_VAR_LENGTH,
  agentDisplayName,
  sanitiseOutreachVar,
  renderOutreachPreview,
  isLeadOutreachKind,
  isOutreachChannel,
  outreachTemplateKey,
  type LeadOutreachKind,
} from "./lead-outreach-templates"

// A long ZA first name plus the longest value agentDisplayName can yield.
const LONG_VARS = { firstName: "Nomvulakazi", agentName: AGENT_NAME_FALLBACK }

function render(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_m, n: string) => vars[n] ?? `{{${n}}}`)
}

describe("lead outreach copy", () => {
  it("defines exactly the three approved kinds", () => {
    expect(LEAD_OUTREACH_KINDS.sort()).toEqual(["QUALIFICATION", "REENGAGE", "REQUEST_DOCS"])
  })

  it.each(LEAD_OUTREACH_KINDS)("%s renders with no leftover placeholders", (kind) => {
    const out = render(LEAD_OUTREACH[kind].body.WHATSAPP, LONG_VARS)
    // renderTemplate throws on a var it wasn't given, so an unknown
    // placeholder here would be a runtime send failure, not a cosmetic bug.
    expect(out).not.toMatch(/\{\{|\}\}/)
    expect(out).toContain("Nomvulakazi")
    expectNoOtherLender(out)
  })

  it.each(LEAD_OUTREACH_KINDS)("%s tells the recipient how to opt out", (kind) => {
    // The unsubscribe *link* is EMAIL-only (lib/messaging/send.ts), so the
    // WhatsApp body must carry the STOP instruction. It is honoured: the
    // WhatsApp webhook runs STOP_REGEX → handleWaStopInbound, which revokes
    // consent. Only claim an opt-out the system actually implements.
    expect(LEAD_OUTREACH[kind].body.WHATSAPP).toContain("STOP")
  })

  // The SERVICE classification is only lawful while the copy services the
  // lead's own enquiry. Promotional copy would make these POPIA s.69 direct
  // marketing to leads who never consented — and no code path grants
  // MARKETING_GENERAL, so it could never be lawfully sent.
  it.each(LEAD_OUTREACH_KINDS)("%s never promotes a product or quotes a rate", (kind) => {
    const body = LEAD_OUTREACH[kind].body.WHATSAPP.toLowerCase()
    for (const pitch of ["need cash", "rates from", "special offer", "apply now", "% p.a", "discount", "best rate"]) {
      expect(body).not.toContain(pitch)
    }
  })

  it("re-engage is framed around the lead's own open application, with a way out", () => {
    const body = LEAD_OUTREACH.REENGAGE.body.WHATSAPP.toLowerCase()
    expect(body).toContain("still open")
    expect(body).toContain("stop")
  })

  // Three separate false promises got written into this copy before review
  // caught them: a STOP opt-out over a channel with no inbound, a request for
  // ID photos into a webhook that drops media, and an offer to close the lead
  // on STOP when handleWaStopInbound only revokes consent. The copy must
  // promise only what the code actually does, so pin the specific claims that
  // were wrong — a reviewer cannot re-derive this from the templates alone.
  it.each(LEAD_OUTREACH_KINDS)("%s promises no action the system does not perform", (kind) => {
    const body = LEAD_OUTREACH[kind].body.WHATSAPP.toLowerCase()

    // STOP revokes ContactConsent (lib/messaging/wa-stop.ts). It does NOT
    // write Lead.status, so nothing may offer to close/cancel the application.
    for (const unkept of ["close it off", "close your application", "cancel your application"]) {
      expect(body).not.toContain(unkept)
    }

    // The WhatsApp webhook drops any message with no text body, so documents
    // must not be solicited into this channel.
    for (const unkept of ["photos or scans", "send us a photo", "attach"]) {
      expect(body).not.toContain(unkept)
    }
  })
})

describe("agentDisplayName", () => {
  it("uses the first name only", () => {
    expect(agentDisplayName("Pieter van der Merwe")).toBe("Pieter")
    expect(agentDisplayName("Thabo Molefe")).toBe("Thabo")
    expect(agentDisplayName("Naledi")).toBe("Naledi")
  })

  it("falls back for a nameless staff account — never to an email address", () => {
    // User.name is nullable. Leaking the staff work address to every lead
    // would be the obvious wrong fallback.
    expect(agentDisplayName(null)).toBe(AGENT_NAME_FALLBACK)
    expect(agentDisplayName(undefined)).toBe(AGENT_NAME_FALLBACK)
    expect(agentDisplayName("")).toBe(AGENT_NAME_FALLBACK)
    expect(agentDisplayName("   ")).toBe(AGENT_NAME_FALLBACK)
    expect(agentDisplayName(null)).not.toContain("@")
  })

  it("never returns more than the first token", () => {
    expect(agentDisplayName("Pieter van der Merwe")).not.toContain(" ")
  })
})

describe("outreachTemplateKey", () => {
  it("keys per channel — MessageTemplate is unique on (tenantId, key)", () => {
    expect(outreachTemplateKey("QUALIFICATION", "WHATSAPP")).toBe("lead_qualification_whatsapp")
    expect(outreachTemplateKey("REQUEST_DOCS", "WHATSAPP")).toBe("lead_request_docs_whatsapp")
  })

  it("produces a distinct key for every kind", () => {
    const keys = LEAD_OUTREACH_KINDS.map((k) => outreachTemplateKey(k, "WHATSAPP"))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe("input guards", () => {
  it("accepts only the three kinds", () => {
    expect(isLeadOutreachKind("QUALIFICATION")).toBe(true)
    expect(isLeadOutreachKind("REENGAGE")).toBe(true)
    expect(isLeadOutreachKind("ANYTHING_ELSE")).toBe(false)
    expect(isLeadOutreachKind(null)).toBe(false)
    expect(isLeadOutreachKind(123)).toBe(false)
  })

  it("rejects a prototype-chain key masquerading as a kind", () => {
    // `in` walks the prototype chain — guard against "constructor"/"toString".
    expect(isLeadOutreachKind("constructor")).toBe(false)
    expect(isLeadOutreachKind("toString")).toBe(false)
  })

  it("accepts WhatsApp only — SMS and EMAIL are not outreach channels", () => {
    expect(isOutreachChannel("WHATSAPP")).toBe(true)
    // SMS is send-only in this system: no inbound webhook exists, so the
    // lead's reply AND their STOP would be silently dropped. Every outreach
    // body asks for a reply, so SMS must not be sendable until inbound lands.
    expect(isOutreachChannel("SMS")).toBe(false)
    expect(isOutreachChannel("EMAIL")).toBe(false)
    expect(isOutreachChannel(undefined)).toBe(false)
  })
})

describe("LEAD_OUTREACH shape", () => {
  it.each(LEAD_OUTREACH_KINDS)("%s carries a label and description for the button", (kind: LeadOutreachKind) => {
    expect(LEAD_OUTREACH[kind].label.length).toBeGreaterThan(0)
    expect(LEAD_OUTREACH[kind].description.length).toBeGreaterThan(0)
    expect(LEAD_OUTREACH[kind].kind).toBe(kind)
  })
})

// The rendered WhatsApp body IS the sink — no HTML needed, because the message
// text is itself the payload. Lead.firstName is typed by a member of the
// public into app/api/website/apply (truthiness check only, no length cap,
// phone unverified), so without sanitising, one staff click delivers
// attacker-authored text from the lender's verified WhatsApp identity.
describe("sanitiseOutreachVar — the outbound body is the sink", () => {
  const SMISH =
    "Thabo\n\nAcme Lending: your payout is on hold, pay the R250 release fee to 123456789"

  it("flattens the newlines an attacker uses to author their own paragraphs", () => {
    const out = sanitiseOutreachVar(SMISH)
    expect(out).not.toContain("\n")
    expect(out).not.toContain("\r")
  })

  it("strips CR, LF, line/paragraph separators and control characters", () => {
    for (const ch of ["\n", "\r", "\r\n", "\u2028", "\u2029", "\u0000", "\u001F", "\u0085"]) {
      expect(sanitiseOutreachVar(`a${ch}b`)).toBe("a b")
    }
  })

  it("caps length so a long payload cannot pad the body", () => {
    const out = sanitiseOutreachVar("A".repeat(500))
    expect(out.length).toBeLessThanOrEqual(MAX_VAR_LENGTH)
  })

  it("keeps the attack payload out of the rendered body end to end", () => {
    const body = renderOutreachPreview("REENGAGE", { firstName: SMISH, agentName: "Thabo" })
    expect(body).not.toContain("\n")
    // Truncation must remove the fraud instruction, not merely reflow it onto
    // one line — a single-line smish is still a smish.
    expect(body).not.toContain("release fee")
    expect(body).not.toContain("123456789")
  })

  it("leaves an ordinary name untouched", () => {
    expect(sanitiseOutreachVar("Nomvulakazi")).toBe("Nomvulakazi")
    expect(sanitiseOutreachVar("  Jean-Pierre  ")).toBe("Jean-Pierre")
    expect(sanitiseOutreachVar("Thabo  Molefe")).toBe("Thabo Molefe")
  })

  it("preview and payload cannot diverge — both use the same sanitiser", () => {
    // If they diverged, staff would approve one text and the lead receive
    // another — exactly the blind click the preview exists to remove.
    const preview = renderOutreachPreview("QUALIFICATION", { firstName: SMISH, agentName: "Thabo" })
    expect(preview).toContain(sanitiseOutreachVar(SMISH))
  })
})

describe("agentDisplayName — never publishes a staff email", () => {
  it("refuses a name that is actually an email address", () => {
    // User.name is free text from the admin form with no format validation,
    // so "thabo@lender.example" has no whitespace to split on and would
    // otherwise be published verbatim to every lead.
    expect(agentDisplayName("thabo@lender.example")).toBe(AGENT_NAME_FALLBACK)
    expect(agentDisplayName("Thabo thabo@lender.example")).toBe("Thabo")
  })

  it("strips newlines out of a staff-supplied name too", () => {
    expect(agentDisplayName("Thabo\nAcme Lending: pay here")).toBe("Thabo")
  })
})

describe("renderOutreachPreview — placeholder resolution", () => {
  it("does not resolve a prototype-chain placeholder", () => {
    // `safe[name] ?? fallback` would return Object's constructor for a
    // {{constructor}} placeholder. Unreachable (bodies are code constants)
    // but it is the same footgun isLeadOutreachKind guards six lines away.
    const out = renderOutreachPreview("QUALIFICATION", { firstName: "Nomvula", agentName: "Thabo" })
    expect(out).not.toContain("function Object")
    expect(out).not.toContain("[native code]")
  })
})
