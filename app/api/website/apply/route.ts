import { NextRequest, NextResponse } from "next/server"
import { requiresPoFundingFacts } from "@/lib/applications/po-funding"
import { prisma } from "@/lib/prisma"
import { getTenantFromRequest } from "@/lib/tenant"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { verifyTurnstile } from "@/lib/turnstile"
import { resolveReferralCode, recordReferralEvent } from "@/lib/referral-agents/referrals"
import { logAudit, logAuditStrict, AuditAction } from "@/lib/audit"
import { isValidSaIdNumber } from "@/lib/validation/client-wizard"
import { generateReference, maskEmail, maskIdNumber } from "@/lib/utils"
import {
  ContactPromotionConflictError,
  resolveContactForLeadConversion,
} from "@/lib/contact/provision"
import { portalContinueUrl } from "@/lib/portal-urls"
import { runWithTenant } from "@/lib/tenant-scope"
import { sendEmail } from "@/lib/email/service"
import { notifyPriorLeadDuplicatesBestEffort } from "@/lib/crm/lead-duplicate-notify"
import { deferAfterResponse } from "@/lib/http/after-response"
import { screenOnSubmit } from "@/lib/screening/on-submit"
import { applicationSubmittedEmail, identityConflictNoticeEmail } from "@/lib/email/templates/portal"
import { getLenderIdentity } from "@/lib/config/identity"
import { htmlToPlainText } from "@/lib/email/html-to-text"
import { creditBlock } from "@/lib/clients/status"
import { sendMessage } from "@/lib/messaging/send"
import { getOrCreateAgentMessageTemplate } from "@/lib/messaging/agent-message-template"
import { Prisma, type Contact } from "@prisma/client"
import {
  AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
  affordabilityExpenseEvidenceNeedsMleJustification,
  affordabilityExpenseEvidenceIsIntact,
  createAffordabilityExpenseEvidence,
  withAffordabilitySnapshot,
} from "@/lib/affordability/snapshot"
import { ownAwareSubmissionSnapshot } from "@/lib/affordability/own-lender-debt-load"
import {
  isUniqueConstraintViolation,
  OPEN_APPLICATION_STATUSES,
} from "@/lib/applications/open-application"
import {
  fingerprintWebsiteSubmission,
  parseWebsiteSubmissionKey,
} from "@/lib/applications/website-submission-idempotency"
import { lockNewApplicationSubmissionEvidence } from "@/lib/applications/submission-lock"
import {
  updateClientWithBiometricIdentityRevocation,
  type BiometricIdentityRevocation,
} from "@/lib/kyc/identity-revocation"

// Public unauthenticated form. Bot defences: rate limit (per-IP) + Cloudflare
// Turnstile challenge token. Rate limit is the cheap first gate; Turnstile
// stops the case where a bot farm rotates IPs.
const FORM_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 } as const

function normaliseProductType(input: unknown): "MICRO" | "PERSONAL" | "PO_FUNDING" | null {
  if (typeof input !== "string") return null
  const upper = input.toUpperCase()
  if (upper === "MICRO") return "MICRO"
  if (upper === "PERSONAL" || upper === "PERSONAL_LOAN") return "PERSONAL"
  if (upper === "PO_FUNDING" || upper === "PO") return "PO_FUNDING"
  return null
}

function mapEmploymentForClient(input: unknown): "EMPLOYED" | "SELF_EMPLOYED" | "PENSIONER" | "UNEMPLOYED" | null {
  if (typeof input !== "string") return null
  const upper = input.toUpperCase().replace("-", "_")
  if (upper === "EMPLOYED") return "EMPLOYED"
  if (upper === "SELF_EMPLOYED") return "SELF_EMPLOYED"
  if (upper === "PENSIONER") return "PENSIONER"
  if (upper === "UNEMPLOYED") return "UNEMPLOYED"
  return null
}

function classifyAgreementType(amountCents: number): "SMALL" | "INTERMEDIATE" | "LARGE" {
  if (amountCents <= 1_500_000) return "SMALL"
  if (amountCents <= 25_000_000) return "INTERMEDIATE"
  return "LARGE"
}

// Fixed-term products use their own single term; variable-term products use
// the client's term exactly (range and presence are enforced by the callers).
function productTerm(product: { minTermDays: number; maxTermDays: number }, appliedTermDays: number): number {
  return product.minTermDays === product.maxTermDays ? product.minTermDays : appliedTermDays
}

function safeMoneyCents(value: unknown): number {
  const amount = Number(value)
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0
}

export async function POST(req: NextRequest) {
  try {
    const ip = callerIp(req)
    const gate = checkRateLimit(`website:apply:${ip}`, FORM_RATE_LIMIT)
    if (!gate.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many submissions. Please try again later." },
        { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
      )
    }

    const body = await req.json()
    const {
      firstName,
      lastName,
      email,
      phone,
      idNumber,
      employmentStatus,
      employerName,
      monthlyIncome,
      monthlyExpenses,
      productType,
      amount,
      termDays,
      purpose,
      turnstileToken,
      popiaConsent,
      source,
      referralCode,
      utmSource,
      utmMedium,
      utmCampaign,
      submissionKey,
    } = body

    let normalisedSubmissionKey: string | null
    try {
      normalisedSubmissionKey = parseWebsiteSubmissionKey(submissionKey)
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid submission request. Please refresh and try again." },
        { status: 400 },
      )
    }
    const submissionFingerprint = normalisedSubmissionKey
      ? fingerprintWebsiteSubmission(body)
      : null

    const turnstile = await verifyTurnstile(turnstileToken, ip)
    if (!turnstile.ok) {
      return NextResponse.json(
        { success: false, error: "Verification failed. Please refresh the page and try again." },
        { status: 400 },
      )
    }

    if (!firstName || !lastName || !phone || !productType) {
      return NextResponse.json({ success: false, error: "Missing required fields" }, { status: 400 })
    }

    // Server-side SA ID checksum. The wizard validates this client-side, but a
    // direct POST could otherwise persist a client + application under an
    // invalid ID (which then can't be KYC-verified). Only enforced when an ID
    // is supplied — a lead-only capture (no ID) is still allowed.
    if (idNumber && !isValidSaIdNumber(String(idNumber).trim())) {
      return NextResponse.json(
        { success: false, error: "Please enter a valid 13-digit South African ID number." },
        { status: 400 },
      )
    }

    const tenant = await getTenantFromRequest(req)
    if (!tenant) {
      return NextResponse.json({ success: false, error: "Service unavailable" }, { status: 503 })
    }

    const reference = `WEB-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`
    const productTypeNormalised = normaliseProductType(productType)
    const requestedAmountCents = safeMoneyCents(amount)
    const declaredIncomeCents = safeMoneyCents(monthlyIncome)
    const declaredExpensesCents = safeMoneyCents(monthlyExpenses)
    const declaredIncomeProvided = Object.prototype.hasOwnProperty.call(body, "monthlyIncome") &&
      monthlyIncome !== null && monthlyIncome !== undefined && monthlyIncome !== ""
    const declaredExpensesProvided = Object.prototype.hasOwnProperty.call(body, "monthlyExpenses") &&
      monthlyExpenses !== null && monthlyExpenses !== undefined && monthlyExpenses !== ""
    // A term counts only when the client sent a whole, positive number of days.
    // Number(true) === 1 and Number("") === 0, so check the type first. A
    // missing/invalid term is never defaulted: variable-term products refuse it
    // below; fixed-term products use their own single term. An out-of-range term
    // on a variable-term product is refused, never clamped.
    const submittedTermDays =
      typeof termDays === "number" || (typeof termDays === "string" && termDays.trim() !== "")
        ? Number(termDays)
        : null
    const hasValidTerm =
      submittedTermDays !== null && Number.isInteger(submittedTermDays) && submittedTermDays > 0
    const appliedTermDays = hasValidTerm ? submittedTermDays : 0
    // Financial evidence is one declaration. Accepting one side and silently
    // combining it with a stored/default value allowed a rejected public
    // request to zero an existing client's approved affordability inputs.
    if (declaredIncomeProvided !== declaredExpensesProvided) {
      return NextResponse.json(
        {
          success: false,
          error: "Monthly income and monthly expenses must be submitted together.",
        },
        { status: 422 },
      )
    }
    if (declaredIncomeProvided && declaredExpensesProvided) {
      const expenseEvidence = createAffordabilityExpenseEvidence({
        monthlyIncome: declaredIncomeCents,
        monthlyExpenses: declaredExpensesCents,
      })
      if (affordabilityExpenseEvidenceNeedsMleJustification(expenseEvidence)) {
        return NextResponse.json(
          {
            success: false,
            error: "Declared living expenses are below the Regulation 23A minimum. Please enter your complete monthly living expenses before submitting.",
            minimumLivingExpenses: expenseEvidence.mle.minimumExpenseCents,
          },
          { status: 422 },
        )
      }
    }

    return await runWithTenant(tenant.id, async () => {
    // Refuse before the Lead is written, so a rejected request leaves nothing
    // behind. Only a request that would go on to create an application needs a
    // term: lead-only captures (no email/ID/amount, no matching product, amount
    // outside the product range) are still accepted without one.
    if (email && idNumber && productTypeNormalised && requestedAmountCents > 0) {
      const termProduct = await prisma.loanProduct.findFirst({
        where: { tenantId: tenant.id, productType: productTypeNormalised, active: true },
        orderBy: { createdAt: "asc" },
      })
      if (
        termProduct &&
        requestedAmountCents >= termProduct.minAmount &&
        requestedAmountCents <= termProduct.maxAmount &&
        termProduct.minTermDays !== termProduct.maxTermDays
      ) {
        if (!hasValidTerm) {
          return NextResponse.json(
            { success: false, error: "Please choose a loan term (a whole number of days) and try again." },
            { status: 400 },
          )
        }
        if (appliedTermDays < termProduct.minTermDays || appliedTermDays > termProduct.maxTermDays) {
          return NextResponse.json(
            {
              success: false,
              error: `Please choose a term between ${termProduct.minTermDays} and ${termProduct.maxTermDays} days for this loan.`,
              termRange: { minTermDays: termProduct.minTermDays, maxTermDays: termProduct.maxTermDays },
            },
            { status: 400 },
          )
        }
      }
    }
    const rawSource = String(source || "WEBSITE").toUpperCase()
    const matchedReferralCode = await resolveReferralCode(prisma, {
      tenantId: tenant.id,
      code: referralCode,
    })
    const leadSource: "WEBSITE" | "WHATSAPP" | "REFERRAL" | "SOCIAL" =
      rawSource === "WHATSAPP" || rawSource === "WA"
        ? "WHATSAPP"
        : referralCode
          ? "REFERRAL"
          : rawSource === "SOCIAL"
            ? "SOCIAL"
            : "WEBSITE"

    const notes = [
      `Product: ${productType}`,
      `Amount: R${Number(amount || 0).toLocaleString()}`,
      hasValidTerm ? `Term: ${submittedTermDays.toLocaleString()} days` : null,
      `Purpose: ${purpose || "Not specified"}`,
      `Employment: ${employmentStatus || "Not specified"}`,
      `Employer: ${employerName || "N/A"}`,
      `Monthly Income: R${Number(monthlyIncome || 0).toLocaleString()}`,
      `Monthly Expenses: R${Number(monthlyExpenses || 0).toLocaleString()}`,
      `ID Number: ${idNumber || "Not provided"}`,
      `Source: ${leadSource}`,
      referralCode ? `Referral Code: ${referralCode}` : null,
      utmSource ? `UTM Source: ${utmSource}` : null,
      utmMedium ? `UTM Medium: ${utmMedium}` : null,
      utmCampaign ? `UTM Campaign: ${utmCampaign}` : null,
      `Reference: ${reference}`,
    ].filter(Boolean).join(" | ")

    // Only applications carrying a referral code get the referral-application
    // tag and referral event — this route also serves unreferred applicants.
    const isReferralApplication = Boolean(referralCode)

    let responseReference = reference
    let leadCreated = false
    let lead: Awaited<ReturnType<typeof prisma.lead.create>>
    try {
      // Persist the enquiry and its initial CRM evidence atomically. Without
      // this boundary, an activity-write failure could leave a Lead behind;
      // the retry would then reuse that Lead and permanently skip the missing
      // activity because it was no longer the creating request.
      lead = await prisma.$transaction(async (tx) => {
        const createdLead = await tx.lead.create({
          data: {
            tenantId: tenant.id,
            submissionKey: normalisedSubmissionKey,
            submissionFingerprint,
            submissionReference: normalisedSubmissionKey ? reference : null,
            firstName,
            lastName,
            email: email || null,
            phone,
            source: leadSource,
            status: "NEW",
            employmentType: employmentStatus || null,
            declaredIncome: declaredIncomeCents || null,
            requestedAmount: requestedAmountCents || null,
            notes,
            tags: [
              "online-application",
              isReferralApplication ? "referral-application" : "",
              productType?.toLowerCase() ?? "",
              matchedReferralCode ? "agent-referral" : "",
              referralCode && !matchedReferralCode ? "unmatched-referral-code" : "",
            ].filter(Boolean),
            referralCodeId: matchedReferralCode?.id ?? null,
          },
        })
        await tx.crmActivity.create({
          data: {
            tenantId: tenant.id,
            leadId: createdLead.id,
            type: "NOTE",
            subject: "Online enquiry received",
            notes: `Website application attempt received. Enquiry reference: ${reference}. ${notes}`,
            completedAt: new Date(),
            createdById: "website-system",
          },
        })
        return createdLead
      })
      leadCreated = true
    } catch (error) {
      if (!normalisedSubmissionKey || !isUniqueConstraintViolation(error)) throw error
      const existingLead = await prisma.lead.findUnique({
        where: {
          tenantId_submissionKey: {
            tenantId: tenant.id,
            submissionKey: normalisedSubmissionKey,
          },
        },
      })
      if (!existingLead) throw error
      lead = existingLead
    }

    if (
      normalisedSubmissionKey &&
      lead.submissionFingerprint !== submissionFingerprint
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "This submission request no longer matches the original application. Refresh before trying again.",
        },
        { status: 409 },
      )
    }
    responseReference = lead.submissionReference || responseReference
    const hasSubmissionKey = normalisedSubmissionKey !== null

    // A response can be lost after the conversion committed. Return the exact
    // original outcome before any new CRM, audit or notification side effect.
    if (
      !leadCreated &&
      lead.convertedToClientId &&
      lead.convertedToApplicationId
    ) {
      const completedApplication = await prisma.loanApplication.findFirst({
        where: {
          id: lead.convertedToApplicationId,
          tenantId: tenant.id,
          clientId: lead.convertedToClientId,
        },
        select: {
          id: true,
          reference: true,
          client: { select: { portalPassword: true } },
        },
      })
      if (completedApplication) {
        return NextResponse.json({
          success: true,
          reference: completedApplication.reference,
          applicationId: completedApplication.id,
          portalAccountStatus: completedApplication.client?.portalPassword
            ? "ready"
            : "activation_required",
        })
      }
    }

    if (leadCreated && isReferralApplication) {
      try {
        await recordReferralEvent(prisma, {
          tenantId: tenant.id,
          eventType: "WEBSITE_APPLICATION",
          source: leadSource,
          referralCode: matchedReferralCode,
          leadId: lead.id,
          attributionRaw: referralCode || null,
          amountCents: Number(amount || 0) > 0 ? Math.round(Number(amount) * 100) : null,
          commissionStatus: "NOT_ELIGIBLE", // funnel/attribution only; commission accrues at disbursement
          qualityFlag: referralCode && !matchedReferralCode ? "UNMATCHED_CODE" : null,
          metadata: {
            productType,
            termDays: hasValidTerm ? submittedTermDays : null,
            reference: responseReference,
            utmSource: utmSource || null,
            utmMedium: utmMedium || null,
            utmCampaign: utmCampaign || null,
          },
        })
      } catch (error) {
        // Lead is already created — don't fail the whole request over a
        // referral-tracking write (e.g. a missing/misconfigured table).
        console.error("[website/apply] Failed to record referral event:", error)
      }
    }

    let applicationId: string | null = null
    // The reference shown to the user for a newly persisted or safely replayed
    // application.
    let portalAccountStatus: "ready" | "activation_required" | "unavailable" = "unavailable"
    let confirmationRequired = false
    // Set by the Contact-provisioning step below (runs before the
    // confirmation-email send further down) when it succeeds. Lets that send
    // route through sendMessage() instead of the legacy direct sendEmail().
    let provisionedContact: Contact | null = null

    if (email && idNumber && productTypeNormalised && requestedAmountCents > 0) {
      const normalisedEmail = String(email).toLowerCase().trim()
      const normalisedIdNumber = String(idNumber).trim()
      // Read the two identity keys while holding the same Lead row lock used by
      // conversion. Under READ COMMITTED, two separate unlocked reads could
      // straddle a winner's commit (email missing, ID present) and manufacture
      // a false identity conflict. A conversion cannot commit its Lead update
      // while this context lock is held, so both identity reads see one coherent
      // pre-conversion state. If the winner committed first, replay it here.
      const submissionContext = await prisma.$transaction(async (tx) => {
        const [lockedLead] = await tx.$queryRaw<Array<{
          id: string
          status: string
          convertedToClientId: string | null
          convertedToApplicationId: string | null
        }>>(Prisma.sql`
          SELECT "id", "status"::text AS "status", "convertedToClientId", "convertedToApplicationId"
          FROM "Lead"
          WHERE "id" = ${lead.id} AND "tenantId" = ${tenant.id}
          FOR UPDATE
        `)
        if (!lockedLead) {
          return { kind: "lead_changed" as const }
        }
        if (
          lockedLead.status === "CONVERTED" ||
          lockedLead.convertedToClientId ||
          lockedLead.convertedToApplicationId
        ) {
          const completedApplication =
            lockedLead.convertedToClientId &&
            lockedLead.convertedToApplicationId
              ? await tx.loanApplication.findFirst({
                  where: {
                    id: lockedLead.convertedToApplicationId,
                    tenantId: tenant.id,
                    clientId: lockedLead.convertedToClientId,
                  },
                  select: {
                    id: true,
                    reference: true,
                    client: { select: { portalPassword: true } },
                  },
                })
              : null
          if (completedApplication) {
            return {
              kind: "idempotent" as const,
              application: completedApplication,
            }
          }
          return { kind: "lead_changed" as const }
        }

        const existingByEmail = await tx.client.findUnique({
          where: { tenantId_email: { tenantId: tenant.id, email: normalisedEmail } },
        })
        const existingById = await tx.client.findUnique({
          where: { tenantId_idNumber: { tenantId: tenant.id, idNumber: normalisedIdNumber } },
        })
        return {
          kind: "proceed" as const,
          existingByEmail,
          existingById,
        }
      })

      if (submissionContext.kind === "lead_changed") {
        return NextResponse.json(
          {
            success: false,
            error: "This lead was already converted by another request. Refresh before continuing.",
          },
          { status: 409 },
        )
      }
      if (submissionContext.kind === "idempotent") {
        return NextResponse.json({
          success: true,
          reference: submissionContext.application.reference,
          applicationId: submissionContext.application.id,
          portalAccountStatus: submissionContext.application.client?.portalPassword
            ? "ready"
            : "activation_required",
        })
      }
      const { existingByEmail, existingById } = submissionContext
      // Require BOTH email and idNumber to resolve to the SAME existing client
      // before treating this as a returning-client update. An anonymous caller
      // who knows only one of the two real values (e.g. a real email + a made-up
      // ID number) must not be able to overwrite a real client's PII or learn
      // their portal-account status. A partial match is treated the same as a
      // full mismatch: skip client linking entirely — the Lead capture above
      // still stands regardless.
      const confirmedExistingClient =
        existingByEmail && existingById && existingByEmail.id === existingById.id ? existingByEmail : null
      const canCreateNewClient = !existingByEmail && !existingById
      const identityConflict = !confirmedExistingClient && !canCreateNewClient

      const rejectOpenApplication = async (args: {
        application: { id: string; reference: string; status: string }
        clientId: string
        productId: string
        requestedTermDays: number
      }) => {
        await logAudit({
          tenantId: tenant.id,
          userEmail: email || "website-system",
          action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
          entity: "LoanApplication",
          entityId: args.application.id,
          newValue: {
            reason: "open_application_exists",
            source: "website_apply",
            leadId: lead.id,
            clientId: args.clientId,
            productId: args.productId,
            existingStatus: args.application.status,
            requestedAmount: requestedAmountCents,
            requestedTermDays: args.requestedTermDays,
          },
          ipAddress: ip,
        })
        return NextResponse.json(
          {
            success: false,
            error: "An application for this product is already in progress. Continue the existing application instead of submitting another one.",
            applicationId: args.application.id,
            reference: args.application.reference,
            status: args.application.status,
          },
          { status: 409 },
        )
      }

      if (identityConflict) {
        // Either a full mismatch (email and idNumber belong to two different
        // existing clients) or a partial match (only one of the two matches
        // a real client) — both are a fraud/typo signal worth a record, even
        // though we deliberately reveal nothing to the caller.
        //
        // Notify the matched existing client at their ON-FILE address (never the
        // freshly-typed address, never on-screen) so a genuine returning customer
        // who applied with a new email / typo'd ID gets a safe route back to their
        // portal. The email-owner wins when both match different clients (case c);
        // otherwise we notify whichever single client matched. The ONE identifier
        // we surface — the mismatched one — is masked. Best-effort: a failure here
        // must never fail the applicant's submission (the Lead already stands).
        // Cooldown: at most one notice per on-file address per 6h, so the public
        // form can't be turned into an inbox-spam vector for a known ID/email.
        const notifyClient = existingByEmail ?? existingById
        let identityNoticeSent = false
        if (notifyClient) {
          try {
            // Atomic 6h per-recipient throttle. Claim a NotificationThrottle row
            // for this recipient's current 6h window BEFORE sending: the unique
            // constraint on (tenantId, channelKey, windowStart) means only ONE
            // concurrent request wins the insert — the rest get P2002 and skip.
            // This closes the check-then-act race a prior findFirst had (two
            // requests could both read "no recent notice" and both send). On a
            // send failure we release the claim so a transient SMTP outage doesn't
            // suppress a genuine retry for the whole window.
            // Fixed 6h bucket (not a sliding window) so the claim is a single
            // atomic unique insert. The only cost is up to ~2 notices across a
            // bucket boundary — an acceptable anti-spam bound.
            const SIX_HOURS_MS = 6 * 60 * 60 * 1000
            const windowStart = new Date(Math.floor(Date.now() / SIX_HOURS_MS) * SIX_HOURS_MS)
            const channelKey = `portal-identity-notice:${notifyClient.email}`

            let claimed = false
            try {
              await prisma.notificationThrottle.create({
                data: { tenantId: tenant.id, channelKey, windowStart },
              })
              claimed = true
            } catch (throttleErr) {
              // P2002 = another request already claimed this recipient+window →
              // cooldown active, skip silently. Anything else is unexpected and
              // bubbles to the best-effort catch below.
              if (
                !(throttleErr instanceof Prisma.PrismaClientKnownRequestError) ||
                throttleErr.code !== "P2002"
              ) {
                throw throttleErr
              }
            }

            if (claimed) {
              // Notified via the email-owner → the mismatched identifier is the
              // typed ID; via the ID-owner → it's the typed email. Mask whichever
              // one we reveal.
              const notifiedViaEmail = Boolean(existingByEmail)
              const identity = await getLenderIdentity(tenant.id)
              const html = identityConflictNoticeEmail(identity, {
                clientName: notifyClient.firstName || "there",
                portalUrl: portalContinueUrl(notifyClient.email, notifyClient.reference),
                maskedOtherLabel: notifiedViaEmail ? "ID number" : "email address",
                maskedOtherValue: notifiedViaEmail
                  ? maskIdNumber(normalisedIdNumber)
                  : maskEmail(normalisedEmail),
              })
              const result = await sendEmail({
                tenantId: tenant.id,
                to: notifyClient.email,
                toName: [notifyClient.firstName, notifyClient.lastName].filter(Boolean).join(" ") || undefined,
                subject: `${identity.tradingName} — a portal sign-in request`,
                html,
                category: "portal-identity-notice",
              })
              identityNoticeSent = result.ok

              if (!result.ok) {
                // Release the claim so a transient send failure doesn't block a
                // genuine retry for the rest of the window. Best-effort.
                await prisma.notificationThrottle
                  .delete({
                    where: {
                      tenantId_channelKey_windowStart: {
                        tenantId: tenant.id,
                        channelKey,
                        windowStart,
                      },
                    },
                  })
                  .catch((releaseErr) => {
                    console.error("[website/apply] failed to release identity-notice throttle claim:", releaseErr)
                  })
              }
            }
          } catch (err) {
            console.error("[website/apply] identity-conflict notice failed:", err)
          }
        }

        await logAudit({
          tenantId: tenant.id,
          userEmail: email || "website-system",
          action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
          entity: "Client",
          newValue: {
            reason: "identity_conflict",
            source: "website_apply",
            leadId: lead.id,
            matchedByEmailClientId: existingByEmail?.id ?? null,
            matchedByIdNumberClientId: existingById?.id ?? null,
            noticeRecipientClientId: notifyClient?.id ?? null,
            noticeSent: identityNoticeSent,
          },
          ipAddress: ip,
        })
      }

      // The public form proves an email+ID pair, not an authenticated portal
      // session. It may create a fresh client's initial financial profile, but
      // it must never rewrite an existing client's decision-bearing income or
      // expenses. If the declaration differs, direct the customer to the
      // authenticated profile flow; otherwise use the stored profile when
      // constructing the immutable submission snapshot below.
      if (
        confirmedExistingClient &&
        ((declaredIncomeProvided && declaredIncomeCents !== confirmedExistingClient.monthlyIncome) ||
          (declaredExpensesProvided && declaredExpensesCents !== confirmedExistingClient.monthlyExpenses))
      ) {
        await logAudit({
          tenantId: tenant.id,
          userEmail: email || "website-system",
          action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
          entity: "Client",
          entityId: confirmedExistingClient.id,
          oldValue: {
            monthlyIncome: confirmedExistingClient.monthlyIncome,
            monthlyExpenses: confirmedExistingClient.monthlyExpenses,
          },
          newValue: {
            reason: "financial_profile_update_requires_authentication",
            source: "website_apply",
            leadId: lead.id,
            declaredMonthlyIncome: declaredIncomeProvided ? declaredIncomeCents : null,
            declaredMonthlyExpenses: declaredExpensesProvided ? declaredExpensesCents : null,
          },
          ipAddress: ip,
        })
        return NextResponse.json(
          {
            success: false,
            error: "Your financial profile differs from this application. Sign in to the client portal to update and verify it before applying.",
          },
          { status: 422 },
        )
      }

      // Detect the common repeat-submission case before changing even the
      // non-financial profile fields. The database index below remains the
      // authority for concurrent requests that both pass this friendly check.
      if (
        !hasSubmissionKey &&
        confirmedExistingClient &&
        !creditBlock(confirmedExistingClient).blocked
      ) {
        const existingProduct = await prisma.loanProduct.findFirst({
          where: { tenantId: tenant.id, productType: productTypeNormalised, active: true },
          orderBy: { createdAt: "asc" },
        })
        if (
          existingProduct &&
          requestedAmountCents >= existingProduct.minAmount &&
          requestedAmountCents <= existingProduct.maxAmount
        ) {
          const requestedTerm = productTerm(existingProduct, appliedTermDays)
          const openApplication = await prisma.loanApplication.findFirst({
            where: {
              tenantId: tenant.id,
              clientId: confirmedExistingClient.id,
              productId: existingProduct.id,
              status: { in: [...OPEN_APPLICATION_STATUSES] },
            },
            select: { id: true, reference: true, status: true },
          })
          if (openApplication) {
            return rejectOpenApplication({
              application: openApplication,
              clientId: confirmedExistingClient.id,
              productId: existingProduct.id,
              requestedTermDays: requestedTerm,
            })
          }
        }
      }

      if (confirmedExistingClient || canCreateNewClient) {
        const websiteBlock = confirmedExistingClient
          ? creditBlock(confirmedExistingClient)
          : { blocked: false as const }
        if (confirmedExistingClient && websiteBlock.blocked) {
          // POPIA + treating-customers-fairly: don't reveal the blacklist or
          // deceased status in the response. Same pattern as
          // app/api/portal/applications/route.ts.
          await logAudit({
            tenantId: tenant.id,
            userEmail: email || "website-system",
            action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
            entity: "LoanApplication",
            newValue: { reason: websiteBlock.auditReason, clientId: confirmedExistingClient.id, source: "website_apply" },
            ipAddress: ip,
          })
        } else {
          const product = await prisma.loanProduct.findFirst({
            where: { tenantId: tenant.id, productType: productTypeNormalised, active: true },
            orderBy: { createdAt: "asc" },
          })

          // PO funding needs the purchase order itself (lib/applications/po-funding.ts),
          // which this form cannot collect: it stays an enquiry (the lead), never an application.
          if (
            product
            && !requiresPoFundingFacts(product.productType)
            && requestedAmountCents >= product.minAmount && requestedAmountCents <= product.maxAmount
          ) {
            // The pre-check above already refused a missing or out-of-range term.
            const term = productTerm(product, appliedTermDays)
            // A same-key retry must reach the Lead row lock below. The original
            // request may have committed its application after this retry read
            // the Lead as NEW; treating that newly visible application as a
            // separate duplicate would return a false 409 and write a false
            // blocked audit instead of replaying the winning 200.
            const openApplication = confirmedExistingClient && !hasSubmissionKey
              ? await prisma.loanApplication.findFirst({
                  where: {
                    tenantId: tenant.id,
                    clientId: confirmedExistingClient.id,
                    productId: product.id,
                    status: { in: [...OPEN_APPLICATION_STATUSES] },
                  },
                  select: { id: true, reference: true, status: true },
                })
              : null

            if (openApplication) {
              return rejectOpenApplication({
                application: openApplication,
                clientId: confirmedExistingClient!.id,
                productId: product.id,
                requestedTermDays: term,
              })
            }

            let submittedTerm = term
            let application: { id: string; reference: string } | null = null
            try {
              const creation = await prisma.$transaction(async (tx) => {
                const [lockedLead] = await tx.$queryRaw<Array<{
                  id: string
                  status: string
                  convertedToClientId: string | null
                  convertedToApplicationId: string | null
                }>>(Prisma.sql`
                  SELECT "id", "status"::text AS "status", "convertedToClientId", "convertedToApplicationId"
                  FROM "Lead"
                  WHERE "id" = ${lead.id} AND "tenantId" = ${tenant.id}
                  FOR UPDATE
                `)
                if (!lockedLead) {
                  return { kind: "lead_changed" as const }
                }
                if (
                  lockedLead.status === "CONVERTED" ||
                  lockedLead.convertedToClientId ||
                  lockedLead.convertedToApplicationId
                ) {
                  const completedApplication =
                    lockedLead.convertedToClientId &&
                    lockedLead.convertedToApplicationId
                      ? await tx.loanApplication.findFirst({
                          where: {
                            id: lockedLead.convertedToApplicationId,
                            tenantId: tenant.id,
                            clientId: lockedLead.convertedToClientId,
                          },
                          select: {
                            id: true,
                            reference: true,
                            client: { select: { portalPassword: true } },
                          },
                        })
                      : null
                  if (completedApplication) {
                    return {
                      kind: "idempotent" as const,
                      application: completedApplication,
                    }
                  }
                  return { kind: "lead_changed" as const }
                }

                let client = confirmedExistingClient
                if (!client) {
                  client = await tx.client.create({
                    data: {
                      tenantId: tenant.id,
                      reference: generateReference("CLI"),
                      firstName,
                      lastName,
                      email: normalisedEmail,
                      phone,
                      idNumber: normalisedIdNumber,
                      employmentStatus: mapEmploymentForClient(employmentStatus),
                      employerName: employerName || null,
                      monthlyIncome: declaredIncomeCents,
                      monthlyExpenses: declaredExpensesCents,
                      // An explicit R0 is a declaration; the column's 0 is not.
                      monthlyExpensesDeclaredAt: declaredExpensesProvided ? new Date() : null,
                      expenseBreakdown: {
                        create: {
                          housing: 0, transport: 0, food: 0, education: 0,
                          insurance: 0, clothing: 0, entertainment: 0, medical: 0,
                          other: declaredExpensesCents,
                        },
                      },
                      popiaConsentGiven: popiaConsent === true,
                      popiaConsentAt: popiaConsent === true ? new Date() : null,
                      referredFromId: lead.id,
                    },
                  })
                }

                const evidenceExists = await lockNewApplicationSubmissionEvidence(tx, {
                  tenantId: tenant.id,
                  clientId: client.id,
                  productId: product.id,
                })
                if (!evidenceExists) throw new Error("WEBSITE_APPLICATION_EVIDENCE_MISSING")

                const [snapshotClient, snapshotProduct] = await Promise.all([
                  tx.client.findUnique({
                    where: { id: client.id, tenantId: tenant.id },
                    include: { debtObligations: true, expenseBreakdown: true },
                  }),
                  tx.loanProduct.findFirst({
                    where: {
                      id: product.id,
                      tenantId: tenant.id,
                      productType: productTypeNormalised,
                      active: true,
                    },
                  }),
                ])
                if (!snapshotClient || !snapshotProduct) {
                  throw new Error("WEBSITE_APPLICATION_EVIDENCE_MISSING")
                }
                if (
                  requestedAmountCents < snapshotProduct.minAmount ||
                  requestedAmountCents > snapshotProduct.maxAmount
                ) {
                  throw new Error("WEBSITE_APPLICATION_PRICING_CHANGED")
                }

                // The pre-check above ran before this transaction; if the product
                // became variable-term since, a missing term must not be defaulted.
                if (!hasValidTerm && snapshotProduct.minTermDays !== snapshotProduct.maxTermDays) {
                  throw new Error("WEBSITE_APPLICATION_PRICING_CHANGED")
                }

                // The range may have narrowed since the pre-check: refuse, never clamp.
                if (
                  snapshotProduct.minTermDays !== snapshotProduct.maxTermDays &&
                  (appliedTermDays < snapshotProduct.minTermDays ||
                    appliedTermDays > snapshotProduct.maxTermDays)
                ) {
                  throw new Error("WEBSITE_APPLICATION_PRICING_CHANGED")
                }
                const lockedTerm = productTerm(snapshotProduct, appliedTermDays)
                const currentOpenApplication = await tx.loanApplication.findFirst({
                  where: {
                    tenantId: tenant.id,
                    clientId: snapshotClient.id,
                    productId: snapshotProduct.id,
                    status: { in: [...OPEN_APPLICATION_STATUSES] },
                  },
                  select: { id: true, reference: true, status: true },
                })
                if (currentOpenApplication) {
                  return {
                    kind: "duplicate" as const,
                    application: currentOpenApplication,
                    requestedTermDays: lockedTerm,
                  }
                }

                const snapshotExpenseEvidence = createAffordabilityExpenseEvidence(snapshotClient)
                if (affordabilityExpenseEvidenceNeedsMleJustification(snapshotExpenseEvidence)) {
                  if (!confirmedExistingClient) throw new Error("WEBSITE_APPLICATION_MLE_INVALID")
                  return { kind: "mle" as const, expenseEvidence: snapshotExpenseEvidence }
                }
                if (!affordabilityExpenseEvidenceIsIntact(snapshotExpenseEvidence)) {
                  if (!confirmedExistingClient) throw new Error("WEBSITE_APPLICATION_EXPENSE_INVALID")
                  return { kind: "expense_invalid" as const }
                }

                let biometricIdentityRevocation: BiometricIdentityRevocation | null = null
                if (confirmedExistingClient) {
                  const identityMutation = await updateClientWithBiometricIdentityRevocation(tx, {
                    tenantId: tenant.id,
                    clientId: confirmedExistingClient.id,
                    previous: snapshotClient,
                    nextSubject: {
                      id: snapshotClient.id,
                      idNumber: snapshotClient.idNumber,
                      firstName,
                      lastName,
                      dateOfBirth: snapshotClient.dateOfBirth,
                    },
                    where: { id: confirmedExistingClient.id, tenantId: tenant.id },
                    data: {
                      firstName,
                      lastName,
                      phone,
                      employmentStatus: mapEmploymentForClient(employmentStatus),
                      employerName: employerName || null,
                      ...(popiaConsent === true
                        ? { popiaConsentGiven: true, popiaConsentAt: new Date() }
                        : {}),
                    },
                    actor: { userId: null, userEmail: email || "website-system" },
                    source: "website_apply_returning_client",
                    ipAddress: ip,
                  })
                  client = identityMutation.client
                  biometricIdentityRevocation = identityMutation.revocation
                }

                const provisioned = await resolveContactForLeadConversion(tx, {
                  tenantId: tenant.id,
                  leadId: lead.id,
                  clientId: client.id,
                  firstName: client.firstName,
                  lastName: client.lastName,
                  email: client.email,
                  phone: client.phone,
                  whatsapp: client.whatsapp,
                  source: "APPLICATION_FORM",
                  // A returning Client can already own the canonical Contact
                  // for an earlier conversion. Preserve that one-to-one
                  // representative link; a brand-new Client must link this
                  // originating Lead on the Contact created in this transaction.
                  reuseExistingClientContact: Boolean(confirmedExistingClient),
                  // A returning applicant may submit a changed phone/email.
                  // Reconcile those identities transactionally so future
                  // messages cannot keep routing to stale channel values.
                  reconcileIdentitiesOnReuse: true,
                })

                await tx.auditLog.create({
                  data: {
                    tenantId: tenant.id,
                    userEmail: email || "website-system",
                    action:
                      provisioned.resolution === "REUSED_CLIENT_CONTACT"
                        ? AuditAction.CONTACT_REUSED_FOR_LEAD_CONVERSION
                        : AuditAction.CONTACT_PROMOTED_LEAD_TO_CLIENT,
                    entity: "Contact",
                    entityId: provisioned.contact.id,
                    oldValue: provisioned.previous ?? Prisma.JsonNull,
                    newValue: {
                      source: "website_apply",
                      conversionLeadId: lead.id,
                      clientId: provisioned.contact.clientId,
                      representativeLeadId: provisioned.contact.leadId,
                      status: provisioned.contact.status,
                      primaryEmail: provisioned.contact.primaryEmail,
                      primaryPhone: provisioned.contact.primaryPhone,
                      primaryWaJid: provisioned.contact.primaryWaJid,
                      created: provisioned.created,
                      resolution: provisioned.resolution,
                      identities: [
                        ...provisioned.preExistingIdentities.map((identity) => ({
                          id: identity.id,
                          channel: identity.channel,
                          disposition: "pre_existing",
                        })),
                        ...provisioned.createdIdentities.map((identity) => ({
                          id: identity.id,
                          channel: identity.channel,
                          disposition: "created",
                        })),
                      ],
                    },
                    ipAddress: ip,
                  },
                })

                if (popiaConsent === true) {
                  await tx.consentRecord.create({
                    data: {
                      tenantId: tenant.id,
                      clientId: client.id,
                      type: "POPIA_APPLICATION",
                      granted: true,
                      ipAddress: ip,
                      method: "website_apply",
                    },
                  })
                }

                await tx.auditLog.create({
                  data: {
                    tenantId: tenant.id,
                    userEmail: email || "website-system",
                    action: confirmedExistingClient ? AuditAction.CLIENT_UPDATED : AuditAction.CLIENT_CREATED,
                    entity: "Client",
                    entityId: client.id,
                    newValue: {
                      source: "website_apply",
                      leadId: lead.id,
                      contactId: provisioned.contact.id,
                      ...(biometricIdentityRevocation && {
                        biometricIdentityEvidence: {
                          reason: biometricIdentityRevocation.reason,
                          subjectFingerprint: biometricIdentityRevocation.currentSubjectFingerprint,
                          invalidatedDocumentIds: biometricIdentityRevocation.invalidatedDocumentIds,
                          invalidatedDocumentCount: biometricIdentityRevocation.invalidatedDocumentCount,
                        },
                      }),
                    },
                    ipAddress: ip,
                  },
                })

                const debtSnapshot = snapshotClient.debtObligations.map((debt) => ({
                  sourceId: debt.id,
                  provider: debt.creditProvider,
                  type: debt.accountType,
                  balance: debt.outstandingBalance,
                  monthlyInstalment: debt.monthlyInstalment,
                  notes: debt.notes,
                }))
                const submittedAt = new Date()
                const submissionSnapshot = await ownAwareSubmissionSnapshot(tx, tenant.id, snapshotClient.id, {
                  capturedAt: submittedAt,
                  capturedById: null,
                  client: snapshotClient,
                  applicationDebts: debtSnapshot,
                  clientDebts: snapshotClient.debtObligations,
                  application: {
                    appliedAmount: requestedAmountCents,
                    appliedTermDays: lockedTerm,
                    productId: snapshotProduct.id,
                    initiationFeePayment: "DEFERRED",
                  },
                  product: {
                    interestRatePm: snapshotProduct.interestRatePm,
                    interestModel: snapshotProduct.interestModel,
                    initiationFeeModel: snapshotProduct.initiationFeeModel,
                    initiationFeePct: snapshotProduct.initiationFeePct,
                    initiationFeeMax: snapshotProduct.initiationFeeMax,
                    monthlyServiceFee: snapshotProduct.monthlyServiceFee,
                    productType: snapshotProduct.productType,
                  },
                })
                const created = await tx.loanApplication.create({
                  data: {
                    tenantId: tenant.id,
                    reference: responseReference,
                    clientId: snapshotClient.id,
                    productId: snapshotProduct.id,
                    appliedAmount: requestedAmountCents,
                    appliedTermDays: lockedTerm,
                    purpose: purpose || null,
                    agreementType: classifyAgreementType(requestedAmountCents),
                    existingDebtObligations: debtSnapshot,
                    totalExistingDebt: submissionSnapshot.inputs.declaredDebtCents,
                    netDisposableIncome: submissionSnapshot.outcome.netDisposableIncomeCents,
                    affordabilityNDI: submissionSnapshot.outcome.ndiAfterLoanCents,
                    affordabilityResult: withAffordabilitySnapshot(
                      null,
                      submissionSnapshot,
                    ) as unknown as Prisma.InputJsonValue,
                    status: "SUBMITTED",
                    submittedAt,
                  },
                  select: { id: true, reference: true },
                })
                await tx.auditLog.create({
                  data: {
                    tenantId: tenant.id,
                    userEmail: email || "website-system",
                    action: AuditAction.APPLICATION_SUBMITTED_BY_CLIENT,
                    entity: "LoanApplication",
                    entityId: created.id,
                    newValue: {
                      reference: created.reference,
                      source: "website_apply",
                      leadId: lead.id,
                      clientId: snapshotClient.id,
                      productId: snapshotProduct.id,
                      productType: snapshotProduct.productType,
                      appliedAmount: requestedAmountCents,
                      appliedTermDays: lockedTerm,
                      snapshotSchemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
                      decisionFingerprint: submissionSnapshot.decisionFingerprint,
                    },
                    ipAddress: ip,
                  },
                })

                // The client link is the durable conversion marker. Commit it
                // with the application so a crash cannot leave a QUALIFIED
                // lead pointing at a client/application that already exists.
                await tx.lead.update({
                  where: { id: lead.id, tenantId: tenant.id },
                  data: {
                    status: "CONVERTED",
                    statusChangedAt: submittedAt,
                    convertedToClientId: snapshotClient.id,
                    convertedToApplicationId: created.id,
                  },
                })
                await tx.auditLog.create({
                  data: {
                    tenantId: tenant.id,
                    userEmail: email || "website-system",
                    action: AuditAction.LEAD_CONVERTED,
                    entity: "Lead",
                    entityId: lead.id,
                    oldValue: { status: "NEW", convertedToClientId: null },
                    newValue: {
                      status: "CONVERTED",
                      convertedToClientId: snapshotClient.id,
                      applicationId: created.id,
                      contactId: provisioned.contact.id,
                    },
                    ipAddress: ip,
                  },
                })
                return {
                  kind: "created" as const,
                  application: created,
                  client,
                  contact: provisioned.contact,
                  requestedTermDays: lockedTerm,
                }
              })

              if (creation.kind === "lead_changed") {
                return NextResponse.json(
                  {
                    success: false,
                    error: "This lead was already converted by another request. Refresh before continuing.",
                  },
                  { status: 409 },
                )
              }
              if (creation.kind === "idempotent") {
                application = creation.application
                responseReference = creation.application.reference
                portalAccountStatus = creation.application.client?.portalPassword
                  ? "ready"
                  : "activation_required"
              }
              if (creation.kind === "duplicate") {
                return rejectOpenApplication({
                  application: creation.application,
                  clientId: confirmedExistingClient!.id,
                  productId: product.id,
                  requestedTermDays: creation.requestedTermDays,
                })
              }
              if (creation.kind === "mle") {
                const snapshotExpenseEvidence = creation.expenseEvidence
                await logAudit({
                  tenantId: tenant.id,
                  userEmail: email || "website-system",
                  action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
                  entity: "LoanApplication",
                  newValue: {
                    reason: "mle_justification_missing",
                    clientId: confirmedExistingClient!.id,
                    source: "website_apply",
                    minimumLivingExpenses: snapshotExpenseEvidence.mle.minimumExpenseCents,
                    declaredLivingExpenses: snapshotExpenseEvidence.statedMonthlyExpensesCents,
                  },
                  ipAddress: ip,
                })
                return NextResponse.json(
                  {
                    success: false,
                    error: "Declared living expenses are below the Regulation 23A minimum. Please update the financial profile before submitting.",
                    minimumLivingExpenses: snapshotExpenseEvidence.mle.minimumExpenseCents,
                  },
                  { status: 422 },
                )
              }
              if (creation.kind === "expense_invalid") {
                await logAudit({
                  tenantId: tenant.id,
                  userEmail: email || "website-system",
                  action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
                  entity: "LoanApplication",
                  newValue: {
                    reason: "expense_evidence_invalid",
                    clientId: confirmedExistingClient!.id,
                    source: "website_apply",
                  },
                  ipAddress: ip,
                })
                return NextResponse.json(
                  {
                    success: false,
                    error: "The scalar and itemised expense evidence is inconsistent. Please update the financial profile before submitting.",
                  },
                  { status: 422 },
                )
              }

              if (creation.kind === "created") {
                application = creation.application
                submittedTerm = creation.requestedTermDays
                responseReference = creation.application.reference
                portalAccountStatus = creation.client.portalPassword ? "ready" : "activation_required"
                provisionedContact = creation.contact
                confirmationRequired = true
              }
            } catch (error) {
              if (error instanceof ContactPromotionConflictError) {
                // The Lead deliberately survives a failed application attempt,
                // but the Client/Application transaction has rolled back. Do
                // not attach the applicant to another person's Contact or
                // expose which channel value collided. Return a truthful,
                // actionable conflict and preserve the staff-review trail.
                await logAuditStrict({
                  tenantId: tenant.id,
                  userEmail: email || "website-system",
                  action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
                  entity: "Lead",
                  entityId: lead.id,
                  newValue: {
                    reason: "contact_promotion_conflict",
                    conflictReason: error.reason,
                    source: "website_apply",
                    reference: responseReference,
                  },
                  ipAddress: ip,
                })
                return NextResponse.json(
                  {
                    success: false,
                    error: "Your application could not be submitted because the contact details need review. Please verify them or contact support.",
                    reference: responseReference,
                    applicationId: null,
                    portalAccountStatus: "unavailable",
                  },
                  { status: 409 },
                )
              }
              if (
                error instanceof Error &&
                (error.message === "WEBSITE_APPLICATION_EVIDENCE_MISSING" ||
                  error.message === "WEBSITE_APPLICATION_PRICING_CHANGED")
              ) {
                return NextResponse.json(
                  {
                    success: false,
                    error: "The loan product or affordability evidence changed while submitting. Please refresh and review the application again.",
                  },
                  { status: 422 },
                )
              }
              if (
                error instanceof Error &&
                (error.message === "WEBSITE_APPLICATION_MLE_INVALID" ||
                  error.message === "WEBSITE_APPLICATION_EXPENSE_INVALID")
              ) {
                return NextResponse.json(
                  {
                    success: false,
                    error: "The affordability evidence is invalid. Please review the financial profile before submitting.",
                  },
                  { status: 422 },
                )
              }
              // The partial unique index is the final authority when two
              // requests pass the friendly pre-check concurrently. Re-read to
              // distinguish that invariant from the separate unique reference.
              if (isUniqueConstraintViolation(error) && confirmedExistingClient) {
                const concurrentApplication = await prisma.loanApplication.findFirst({
                  where: {
                    tenantId: tenant.id,
                    clientId: confirmedExistingClient.id,
                    productId: product.id,
                    status: { in: [...OPEN_APPLICATION_STATUSES] },
                  },
                  select: { id: true, reference: true, status: true },
                })
                if (concurrentApplication) {
                  return rejectOpenApplication({
                    application: concurrentApplication,
                    clientId: confirmedExistingClient.id,
                    productId: product.id,
                    requestedTermDays: submittedTerm,
                  })
                }
              }
              throw error
            }
            if (!application) {
              throw new Error("WEBSITE_APPLICATION_RESULT_MISSING")
            }
            applicationId = application.id
          }
        }
      }
    }

    // send a real confirmation email so the success page's promise is
    // true, but ONLY when an application was actually created (applicationId) —
    // never on an identity conflict, a blacklisted client, or a lead-only
    // submission, so we don't send an official "application received / Status:
    // Submitted" email to an address that did not successfully apply. Fails
    // open: a mail outage must not fail the submission. sendEmail writes an
    // EmailLog row (the send's audit trail); SMTP is the active channel.
    if (email && applicationId && confirmationRequired) {
      try {
        const productLabel =
          productTypeNormalised === "PERSONAL" ? "Personal Loan"
            : productTypeNormalised === "PO_FUNDING" ? "Purchase Order Funding"
              : productTypeNormalised === "MICRO" ? "Short-term Loan"
                : "Loan enquiry"
        // Route at CLICK time via /portal/continue rather than baking the
        // login-vs-register choice here: it re-checks account
        // state when the customer clicks — so a customer who registers between
        // this email going out and clicking it still lands on login, not a stale
        // register link — and matches email+reference to avoid enumeration.
        const emailAddress = String(email).toLowerCase().trim()
        const portalCtaUrl = portalContinueUrl(emailAddress, responseReference)
        const identity = await getLenderIdentity(tenant.id)
        const html = applicationSubmittedEmail(identity, firstName || "there", responseReference, productLabel, requestedAmountCents, portalCtaUrl)

        const contactForConfirmation = provisionedContact as Contact | null
        if (contactForConfirmation?.status === "CLIENT") {
          // Contact was provisioned earlier in this same request — route
          // through sendMessage() so this confirmation persists to the
          // client-record timeline like every other comms send.
          const template = await getOrCreateAgentMessageTemplate(tenant.id, "EMAIL")
          await sendMessage({
            contactId: contactForConfirmation.id,
            channel: "EMAIL",
            template,
            vars: {
              subject: `${identity.tradingName} — application received (${responseReference})`,
              body: htmlToPlainText(html),
              bodyHtml: html,
            },
            toValue: emailAddress,
            category: "application_confirmation",
            applicationId,
            idempotencyKey: `application-confirmation:${applicationId}:EMAIL`,
          })
        } else if (!contactForConfirmation) {
          // Provisioning failed (rare P2002 identity collision, logged
          // above) — fall back to the legacy direct send so the applicant
          // still gets their confirmation. This one won't appear in the
          // client-record timeline since there's no Contact to hang it on.
          await sendEmail({
            tenantId: tenant.id,
            to: emailAddress,
            toName: `${firstName} ${lastName}`.trim(),
            subject: `${identity.tradingName} — application received (${responseReference})`,
            html,
            category: "application_confirmation",
            referenceId: responseReference,
          })
        }
      } catch (error) {
        console.error("[website/apply] Confirmation email failed:", error)
      }
    }

    // Returning applicant: tell whoever is already working this person's open
    // lead that they have come in again. Detect-only — this NEVER touches the
    // lead just created above, and never touches the prior one either.
    //
    // Placed here, after the transaction and after the confirmation email, for
    // three reasons: it must not hold a write transaction open on the
    // origination path; it must not be rolled back with one; and it must not
    // run before the applicant's own confirmation.
    //
    // Nothing about the outcome reaches the response below — the applicant must
    // not be able to learn that we recognise them (enumeration safety).
    // NOT reached by the two early idempotent-replay returns above (the
    // already-converted replay, and the pre-application submissionKey replay).
    // That is correct, not an oversight: a replay is the SAME submission
    // arriving twice, not the person enquiring again, and the agent has already
    // been told. The throttle would suppress it anyway; returning early just
    // avoids the scan.
    //
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
    // PEP / sanctions screening of the applicant; never blocks or fails the submission.
    if (applicationId) {
      const submittedApplicationId = applicationId
      deferAfterResponse(() => screenOnSubmit({ tenantId: tenant.id, applicationId: submittedApplicationId, actor: null }))
    }

    return NextResponse.json({ success: true, reference: responseReference, applicationId, portalAccountStatus })
    })
  } catch (error) {
    console.error("[website/apply] Error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
