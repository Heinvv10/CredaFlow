import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { notifyPriorLeadDuplicatesBestEffort } from "@/lib/crm/lead-duplicate-notify"
import { deferAfterResponse } from "@/lib/http/after-response"
import { getTenantFromRequest } from "@/lib/tenant"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { verifyTurnstile } from "@/lib/turnstile"
import { limiterAddress } from "@/lib/limiter-address"

const FORM_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 } as const

export async function POST(req: NextRequest) {
  try {
    const ip = callerIp(req)
    const gate = await checkRateLimit(`website:contact:${limiterAddress(ip)}`, FORM_RATE_LIMIT)
    if (!gate.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many submissions. Please try again later." },
        { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
      )
    }

    const body = await req.json()
    const { name, phone, email, message, turnstileToken } = body

    const turnstile = await verifyTurnstile(turnstileToken, ip)
    if (!turnstile.ok) {
      return NextResponse.json(
        { success: false, error: "Verification failed. Please refresh the page and try again." },
        { status: 400 },
      )
    }

    if (!name || !phone || !message) {
      return NextResponse.json({ success: false, error: "Missing required fields" }, { status: 400 })
    }

    const tenant = await getTenantFromRequest(req)
    if (!tenant) {
      return NextResponse.json({ success: false, error: "Service unavailable" }, { status: 503 })
    }

    const [firstName, ...rest] = name.trim().split(" ")
    const lastName = rest.join(" ") || "—"

    const lead = await prisma.lead.create({
      data: {
        tenantId: tenant.id,
        firstName,
        lastName,
        email: email || null,
        phone,
        source: "WEBSITE",
        status: "NEW",
        notes: `General enquiry from website contact form. Message: ${message}`,
        tags: ["contact-form"],
      },
    })

    await prisma.crmActivity.create({
      data: {
        tenantId: tenant.id,
        leadId: lead.id,
        type: "NOTE",
        subject: "Website contact form enquiry",
        notes: `From: ${name} | Phone: ${phone} | Email: ${email || "N/A"}\n\nMessage: ${message}`,
        completedAt: new Date(),
        createdById: "website-system",
      },
    })


    // Returning enquirer: tell whoever owns this person's open lead. Detect-only
    // and best-effort — see lib/crm/lead-duplicate-notify.ts. Awaited so a
    // serverless freeze at response time cannot drop it.
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
    console.error("[website/contact] Error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
