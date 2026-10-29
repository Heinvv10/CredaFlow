import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { notifyPriorLeadDuplicatesBestEffort } from "@/lib/crm/lead-duplicate-notify"
import { deferAfterResponse } from "@/lib/http/after-response"
import { getTenantFromRequest } from "@/lib/tenant"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { verifyTurnstile } from "@/lib/turnstile"
import { AuditAction } from "@/lib/audit"

const FORM_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 } as const

const MAX_NAME = 120
const MAX_PHONE = 32
const MAX_EMAIL = 254 // RFC 5321 maximum

/**
 * Short-term insurance enquiries from the public product page.
 *
 * Deliberately creates a Lead ONLY — never a Client, and never matched against
 * an existing one. app/api/website/apply/route.ts requires BOTH email and ID
 * number to resolve to the same existing client before it will link one,
 * because an anonymous caller who knows only one real value must not be able to
 * overwrite a real client's PII. This form does not collect an ID number at
 * all, so it can never satisfy that guard — which makes "Lead only" the only
 * safe option, not a limitation. Staff convert the lead to a client through the
 * CRM, where the action is authenticated and audited.
 */
const COVER_TYPES = ["MOTOR", "HOME", "CONTENTS", "OTHER"] as const
type CoverType = (typeof COVER_TYPES)[number]

const COVER_LABELS: Record<CoverType, string> = {
  MOTOR: "Vehicle",
  HOME: "Home / buildings",
  CONTENTS: "Household contents",
  OTHER: "Not sure yet",
}

export async function POST(req: NextRequest) {
  try {
    const ip = callerIp(req)
    const gate = await checkRateLimit(`website:insurance-enquiry:${ip}`, FORM_RATE_LIMIT)
    if (!gate.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many submissions. Please try again later." },
        { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
      )
    }

    const body = await req.json()
    const { name, phone, email, coverType, consent, turnstileToken } = body

    const turnstile = await verifyTurnstile(turnstileToken, ip)
    if (!turnstile.ok) {
      return NextResponse.json(
        { success: false, error: "Verification failed. Please refresh the page and try again." },
        { status: 400 },
      )
    }

    if (!name || !phone) {
      return NextResponse.json({ success: false, error: "Name and phone number are required" }, { status: 400 })
    }

    // The columns are unbounded TEXT and this endpoint is unauthenticated, so
    // without a cap a caller can write arbitrarily large rows. The limits are
    // generous enough that no real person hits them.
    if (
      String(name).length > MAX_NAME
      || String(phone).length > MAX_PHONE
      || (email && String(email).length > MAX_EMAIL)
    ) {
      return NextResponse.json({ success: false, error: "One or more fields is too long." }, { status: 400 })
    }

    // POPIA: the enquiry exists only because the person agreed to be contacted
    // about it. Recording a lead without that agreement would be processing
    // without a lawful basis, so this is a hard gate, not a UI nicety.
    if (consent !== true) {
      return NextResponse.json(
        { success: false, error: "Please agree to be contacted about your enquiry." },
        { status: 400 },
      )
    }

    // Uppercased first so a differently-cased value from a non-browser caller
    // resolves to the type it names instead of silently becoming OTHER. The
    // whitelist still decides — anything unrecognised is OTHER.
    const requestedCover = String(coverType ?? "").trim().toUpperCase()
    const cover: CoverType = COVER_TYPES.includes(requestedCover as CoverType)
      ? (requestedCover as CoverType)
      : "OTHER"

    const tenant = await getTenantFromRequest(req)
    if (!tenant) {
      return NextResponse.json({ success: false, error: "Service unavailable" }, { status: 503 })
    }

    const [firstName, ...rest] = String(name).trim().split(" ")
    const lastName = rest.join(" ") || "—"

    // All three writes are one transaction. The consent is the lawful basis for
    // holding this person's details, so its evidence must not be able to go
    // missing while the details persist: logAudit() swallows failures and would
    // leave a Lead with no record that consent was ever given. Writing the audit
    // row via `tx` means the enquiry and its justification commit together or
    // not at all — the same treatment consent gets in
    // app/api/website/apply/route.ts.
    const lead = await prisma.$transaction(async (tx) => {
      const created = await tx.lead.create({
        data: {
          tenantId: tenant.id,
          firstName,
          lastName,
          email: email || null,
          phone,
          // LeadSource is a CHANNEL (MANUAL/WEBSITE/WHATSAPP/…), not a product,
          // so the product interest goes in tags — same convention as the
          // website contact form.
          source: "WEBSITE",
          status: "NEW",
          notes: `Short-term insurance enquiry from the website. Interested in: ${COVER_LABELS[cover]}.`,
          tags: ["insurance-enquiry", `cover:${cover.toLowerCase()}`],
        },
      })

      await tx.crmActivity.create({
        data: {
          tenantId: tenant.id,
          leadId: created.id,
          type: "NOTE",
          subject: "Website short-term insurance enquiry",
          notes: `From: ${name} | Phone: ${phone} | Email: ${email || "N/A"}\nCover interest: ${COVER_LABELS[cover]}`,
          completedAt: new Date(),
          createdById: "website-system",
        },
      })

      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          userEmail: email || "website-system",
          action: AuditAction.INSURANCE_ENQUIRY_CAPTURED,
          entity: "Lead",
          entityId: created.id,
          ipAddress: ip,
          newValue: {
            source: "website_insurance_enquiry",
            coverType: cover,
            contactConsent: true,
            consentCapturedAt: new Date().toISOString(),
          },
        },
      })

      return created
    })

    // Returning enquirer: tell whoever owns this person's open lead.
    // Detect-only and best-effort — see lib/crm/lead-duplicate-notify.ts.
    // OUTSIDE the transaction above: a notification must not hold a write
    // transaction open, and must not be rolled back with one.
    // Runs AFTER the response is sent. Not a detail: on a match this does a
    // throttle write, a Notification insert and a real SMTP send, and three of
    // these five routes send no email at all when there is no match. Awaiting
    // it would make a recognised submission measurably slower than an
    // unrecognised one — a timing oracle for the exact fact this route must
    // never reveal (enumeration safety). Response timing is identical either
    // way.
    //
    // deferAfterResponse (Next's after()) rather than a bare floating
    // promise: the runtime keeps the invocation alive until the callback
    // settles, so deferring the notice does not drop it.
    deferAfterResponse(() => notifyPriorLeadDuplicatesBestEffort(
      { id: lead.id, firstName, lastName, phone },
      tenant.id,
    ))

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[website/insurance-enquiry] Error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
