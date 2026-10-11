import { describe, it, expect } from "vitest"
import { extractPlaceholders } from "./template-components"
import { SEED_BRAND_TOKEN, WABA_BODY_TEMPLATES, waTemplateVarsFor, withSeededBrand } from "./template-vars"
import { DEFAULT_MESSAGE_TEMPLATES, defaultTemplateForTenant } from "@/lib/messaging/default-templates"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"

/**
 * The contract that makes "approved at Meta but unfillable" impossible.
 *
 * lib/messaging/send.ts drops a template the moment ANY placeholder in its
 * bodyTemplate is absent or blank in `vars` — silently, falling back to free
 * text in-window and returning WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE outside it. So
 * a body Meta has approved can still never send, and nothing would say why.
 *
 * That is not hypothetical. Every WhatsApp template row shipped with
 * `body = "{{body}}"` — an envelope holding one pre-rendered blob — while
 * lib/notifications.ts supplied exactly `vars: { body }`. Registering the
 * obvious wording with {{firstName}} / {{amount}} would have been approved by
 * Meta and then failed on every single send.
 *
 * This test pins both halves together: for each event, the variables the code
 * supplies must COVER the placeholders its registered body declares. Change
 * either side alone and this fails.
 */
describe("the seeded rows and the module cannot drift", () => {
  // The bodies live in TWO places by necessity: this module (which the
  // contract below pins to the supplied vars) and the MessageTemplate rows a
  // tenant is seeded with, which is what send.ts actually reads. The seed takes
  // its WhatsApp bodies from this module; these tests pin that it still does.
  const EVENT_TO_KEY: Record<string, string> = {
    application_submitted: "application_submitted_whatsapp",
    loan_approved: "loan_approved_whatsapp",
    application_declined: "application_declined_whatsapp",
    loan_disbursed: "loan_disbursed_whatsapp",
    payment_received: "payment_received_whatsapp",
    payment_due_3d: "payment_due_3d_whatsapp",
    agent_reengagement: "agent_reengagement_whatsapp",
    payment_reminder_7d: "payment_reminder_7d_whatsapp",
    payment_reminder_1d: "payment_reminder_1d_whatsapp",
    payment_reminder_0d: "payment_reminder_0d_whatsapp",
    payment_reminder_0d_v2: "payment_reminder_0d_v2_whatsapp",
    payment_reminder_overdue_1d: "payment_reminder_overdue_1d_whatsapp",
    payment_reminder_overdue_3d: "payment_reminder_overdue_3d_whatsapp",
    loan_overdue_1d: "loan_overdue_1d_whatsapp",
    loan_overdue_7d: "loan_overdue_7d_whatsapp",
  }

  it("seeds one row per registered body", () => {
    const seeded = new Set(DEFAULT_MESSAGE_TEMPLATES.map((t) => t.key))
    expect(Object.values(EVENT_TO_KEY).filter((k) => !seeded.has(k))).toEqual([])
  })

  it("every event with a registered body has a key mapping", () => {
    // Adding a body to the module without adding its EVENT_TO_KEY entry would
    // otherwise make the per-event assertion below look up `undefined` and
    // report a confusing "no row for undefined".
    const unmapped = Object.keys(WABA_BODY_TEMPLATES).filter((e) => !EVENT_TO_KEY[e])
    expect(unmapped, "event has a body but no key mapping").toEqual([])
  })

  it.each(Object.keys(WABA_BODY_TEMPLATES))("%s: the seed gives ITS key exactly this body", (event) => {
    const row = DEFAULT_MESSAGE_TEMPLATES.find((t) => t.key === EVENT_TO_KEY[event])
    expect(row, `no seeded row for ${EVENT_TO_KEY[event]}`).toBeDefined()
    expect(row!.channel).toBe("WHATSAPP")
    expect(row!.event).toBe(event)
    // Both `body` and `bodyTemplate` carry the same text — the invariant the
    // WABA editor enforces. If they differed, the first registration would
    // rewrite one underneath the running code.
    expect(row!.body).toBe(WABA_BODY_TEMPLATES[event])
    expect(row!.bodyTemplate).toBe(WABA_BODY_TEMPLATES[event])
  })

  it("replaces the seed-time brand token with the tenant's brand in every field that carries it", () => {
    // SEED_BRAND_TOKEN is not a send-time variable: nothing supplies it, so a
    // stored row still containing it would make renderTemplate THROW.
    const carrying = DEFAULT_MESSAGE_TEMPLATES.filter((t) =>
      [t.subject, t.body, t.bodyTemplate].some((v) => v?.includes(SEED_BRAND_TOKEN)),
    )
    expect(carrying.length, "no row carries the brand — the token test is vacuous").toBeGreaterThan(0)
    for (const t of carrying) {
      const stored = defaultTemplateForTenant(t, BRAND)
      for (const v of [stored.subject, stored.body, stored.bodyTemplate]) {
        expect(v ?? "", `${t.key}: token left in the stored row`).not.toContain(SEED_BRAND_TOKEN)
      }
      expect([stored.subject, stored.body, stored.bodyTemplate].join("\n"), `${t.key}: brand missing`).toContain(BRAND)
    }
  })

  it("stores real newlines, not a backslash followed by n", () => {
    // The SQL seed this replaced needed E'' strings for exactly this reason; a
    // borrower would otherwise receive a literal backslash-n in their message.
    for (const t of DEFAULT_MESSAGE_TEMPLATES) {
      for (const v of [t.subject, t.body, t.bodyTemplate]) {
        expect(v ?? "", `${t.key}: literal \\n`).not.toContain("\\n")
      }
    }
  })
})

// Checks below run on the body AS STORED, i.e. after the seed has replaced
// SEED_BRAND_TOKEN with a tenant's brand — that is what send.ts and Meta see.
const BRAND = ACME_LENDER.tradingName

describe("WABA body templates vs the vars the code supplies", () => {
  const EVENTS = Object.keys(WABA_BODY_TEMPLATES) as Array<keyof typeof WABA_BODY_TEMPLATES>

  it("covers every event that has a registered body", () => {
    // A body with no event to fill it is a template that can never send.
    expect(EVENTS.length).toBeGreaterThan(0)
  })

  it.each(EVENTS)("%s: supplied vars cover every placeholder in the body", (event) => {
    const placeholders = extractPlaceholders(withSeededBrand(WABA_BODY_TEMPLATES[event], BRAND))
    const supplied = Object.keys(
      waTemplateVarsFor(event, {
        firstName: "Thabo",
        reference: "LN-001",
        amount: "R1 000,00",
        outstanding: "R500,00",
        dueDate: "2026-09-01",
        supportPhone: "+27 11 555 0100",
        daysOverdue: "60",
      }),
    )
    const missing = placeholders.filter((p) => !supplied.includes(p))
    expect(missing, `${event} body needs vars the code never supplies`).toEqual([])
  })

  it.each(EVENTS)("%s: body is not only variables — Meta rejects that", (event) => {
    // Meta's API rejects a body of exactly
    // "{{body}}": error_subcode 2388047, "The message body can't have more
    // than two consecutive newline characters, ONLY HAVE PARAMETERS, or have
    // more than 10 emojis."
    const body = withSeededBrand(WABA_BODY_TEMPLATES[event], BRAND)
    const withoutVars = body.replace(/\{\{[^}]+\}\}/g, "").trim()
    expect(withoutVars.length, `${event} body is only variables`).toBeGreaterThan(20)
  })

  it.each(EVENTS)("%s: body neither starts nor ends with a variable — Meta rejects that", (event) => {
    // Meta refuses leading or trailing parameters. The collections copy this
    // was carried from ended on `${lenderName}` / `${phone}`, so the rule is
    // pinned here rather than discovered in App Review.
    const body = withSeededBrand(WABA_BODY_TEMPLATES[event], BRAND).trim()
    expect(body.startsWith("{{"), `${event} starts with a variable`).toBe(false)
    expect(body.endsWith("}}"), `${event} ends with a variable`).toBe(false)
  })

  it.each(EVENTS)("%s: body has no run of 3+ newlines — Meta rejects that too", (event) => {
    // Same error_subcode as above: "can't have more than two consecutive
    // newline characters". The existing free-text copy uses \n\n throughout,
    // which is legal; three would not be.
    expect(/\n{3,}/.test(WABA_BODY_TEMPLATES[event]), `${event} has 3+ consecutive newlines`).toBe(false)
  })

  it.each(EVENTS)("%s: body carries at most 10 emoji — Meta's third limit", (event) => {
    const emoji = WABA_BODY_TEMPLATES[event].match(/\p{Extended_Pictographic}/gu) ?? []
    expect(emoji.length).toBeLessThanOrEqual(10)
  })

  it("supplies no blank var for a fully-populated event", () => {
    // send.ts treats present-but-blank as missing ("a present-but-empty value
    // is not a value"), so a var that is always "" is as bad as an absent one.
    for (const event of EVENTS) {
      const vars = waTemplateVarsFor(event, {
        firstName: "Thabo",
        reference: "LN-001",
        amount: "R1 000,00",
        outstanding: "R500,00",
        dueDate: "2026-09-01",
        supportPhone: "+27 11 555 0100",
        daysOverdue: "60",
      })
      const blank = Object.entries(vars).filter(([, v]) => v.trim() === "").map(([k]) => k)
      expect(blank, `${event} supplies blank var(s)`).toEqual([])
    }
  })
})
