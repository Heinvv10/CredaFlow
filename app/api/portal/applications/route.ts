import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma, type LoanPurposeCategory } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { withTenantContext } from "@/lib/tenant"
import { generateReference } from "@/lib/utils"
import { triggerNotification } from "@/lib/notifications"
import { screenOnSubmit } from "@/lib/screening/on-submit"
import { AuditAction } from "@/lib/audit"
import { recordSubmissionRefusal } from "@/lib/learning-loop/submission-refusal"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { resolveReferralCodeById, recordReferralEvent } from "@/lib/referral-agents/referrals"
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
import { lockNewApplicationSubmissionEvidence } from "@/lib/applications/submission-lock"
import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  calculateCreditLifeMonthlyPremiumCents,
  creditLifeOfferMatches,
  CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
  creditLifeOfferedFor,
  isCreditLifeElection,
} from "@/lib/insurance/credit-life-election"
import { isClientPoDocument, parsePoFundingFacts, type PoFundingFacts } from "@/lib/applications/po-funding"
import { creditLifeOfferFindFirstArgs } from "@/lib/insurance/credit-life-offer"
import {
  createCreditLifeDisclosureSha256,
  createCreditLifeNoOfferDisclosureSha256,
} from "@/lib/insurance/credit-life-election.server"
import { creditLifeAutoBundleDecision } from "@/lib/insurance/credit-life-containment"
import { loadOwnLenderArrears, OWN_LENDER_ARREARS_CODE, OWN_LENDER_ARREARS_REASON } from "@/lib/affordability/own-lender-arrears-gate"
import { creditBlock } from "@/lib/clients/status"
import { CONSUMER_PRODUCT_WHERE } from "@/lib/product-config/product-kind"

// Client-portal application submission. Distinct from /api/applications
// (staff-only) and /api/website/apply (anonymous lead capture, creates a
// Lead — not a LoanApplication). This route:
//   - trusts session.user.id as the clientId (no client-supplied id)
//   - resolves the product by tenant-scoped UNIQUE code (never by
//     productType: two products can both be MICRO, and type-based
//     resolution picks whichever row is older). Resolution stays inside the
//     session tenant, so a client cannot reach another tenant's product.
//   - creates a real LoanApplication linked to the Client row, with status
//     SUBMITTED + audit trail

// Per-client CREATE cap for application submission. Six in an hour is well
// above any legitimate use (a single applicant submitting against all three
// products with a couple of typo retries) and well below what would let an
// authenticated client churn LoanApplication rows by cancel-and-resubmit.
// Recorded ONLY on a genuine create (see below) so typos/dupes don't burn it.
const SUBMIT_RATE_LIMIT = { limit: 6, windowMs: 60 * 60 * 1000 } as const

// Cheap per-client REQUEST throttle, checked up-front on every call. Bounds
// total requests — including pre-create failure paths (malformed bodies,
// duplicate-app 409s, and the blacklist branch's audit-log write) — so they
// can't be looped without limit now that the CREATE cap fires late. Generous
// enough (30 / 5 min) never to punish a few typo retries; the create cap
// remains the real churn guard.
const REQUEST_RATE_LIMIT = { limit: 30, windowMs: 5 * 60 * 1000 } as const

const ALLOWED_PURPOSE_CATEGORIES = new Set<LoanPurposeCategory>([
  "DEBT_CONSOLIDATION", "MEDICAL", "EDUCATION", "HOME_IMPROVEMENT",
  "VEHICLE", "BUSINESS", "HOUSEHOLD", "FUNERAL", "OTHER",
])

function classifyAgreementType(amountCents: number): "SMALL" | "INTERMEDIATE" | "LARGE" {
  if (amountCents <= 1_500_000) return "SMALL"
  if (amountCents <= 25_000_000) return "INTERMEDIATE"
  return "LARGE"
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "CLIENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const sessionClientId = session.user.id

  // Up-front request throttle (separate from the create cap below). Keeps
  // pre-create failure paths — including the blacklist branch's audit write —
  // from being looped without limit.
  const reqGate = await checkRateLimit(`portal:apply:req:${sessionClientId}`, REQUEST_RATE_LIMIT)
  if (!reqGate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down and try again shortly." },
      { status: 429, headers: { "Retry-After": String(reqGate.retryAfterSeconds) } },
    )
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const productCode = typeof body.productCode === "string" ? body.productCode.trim() : ""
  if (!productCode || productCode.length > 40) {
    return NextResponse.json(
      { error: "productCode is required." },
      { status: 400 },
    )
  }

  // amount arrives as rand (string or number) from the form; coerce to cents
  const amountRand = Number(body.amount)
  if (!Number.isFinite(amountRand) || amountRand <= 0) {
    return NextResponse.json({ error: "amount must be a positive number (in rand)." }, { status: 400 })
  }
  const appliedAmount = Math.round(amountRand * 100)
  if (appliedAmount < 1) {
    return NextResponse.json({ error: "amount must be a positive number (in rand)." }, { status: 400 })
  }

  const purpose = typeof body.purpose === "string" ? body.purpose.trim() : ""
  if (purpose.length < 3 || purpose.length > 500) {
    return NextResponse.json({ error: "purpose must be 3–500 characters." }, { status: 400 })
  }

  let loanPurposeCategory: LoanPurposeCategory | null = null
  if (body.loanPurposeCategory != null && body.loanPurposeCategory !== "") {
    if (typeof body.loanPurposeCategory !== "string"
        || !ALLOWED_PURPOSE_CATEGORIES.has(body.loanPurposeCategory as LoanPurposeCategory)) {
      return NextResponse.json({ error: "loanPurposeCategory invalid." }, { status: 400 })
    }
    loanPurposeCategory = body.loanPurposeCategory as LoanPurposeCategory
  }

  const affordabilityDeclared = body.affordabilityDeclared === true
  const pasqDeliveryUnderstood = body.pasqDeliveryUnderstood === true
  if (!affordabilityDeclared || !pasqDeliveryUnderstood) {
    return NextResponse.json(
      { error: "Both the affordability declaration and confirmation that the PASQ will be reviewed later are required." },
      { status: 400 },
    )
  }

  return withTenantContext(req, async (tenant) => {
    // With no active credit-life product the apply screen renders no election
    // block, so there is no choice for the client to submit. The transaction
    // below re-reads the offer under lock; this only decides whether the
    // client was expected to send one at all.
    const offerConfiguredAtRequest = await prisma.insuranceProduct.findFirst(
      creditLifeOfferFindFirstArgs(tenant.id),
    )
    // Never silently rewrite an election the consumer actually stated. A stale
    // tab or a replayed body can post ACCEPTED with no product configured, and
    // recording that as DECLINED would put an untrue attribution into the
    // CREDIT_LIFE_ELECTION_RECORDED audit row. The staff path already 422s
    // here; match it. Absent (the apply screen renders no election block when
    // nothing is offered) still defaults to a decline.
    if (!offerConfiguredAtRequest && body.creditLifeElection === "ACCEPTED") {
      return NextResponse.json(
        { error: "No credit-life product is configured, so cover cannot be added." },
        { status: 422 },
      )
    }
    // The apply screen initialises its election state to "" and posts it
    // verbatim when no offer block ever rendered. An empty string is NOT a
    // stated election — but `?? "DECLINED"` only catches null/undefined, so
    // "" would fall through to isCreditLifeElection and 400 EVERY no-offer
    // portal submission. Blank means
    // absent; a stated ACCEPTED is still refused above, and a stated
    // DECLINED passes through untouched.
    const statedElection = body.creditLifeElection === "" ? undefined : body.creditLifeElection
    // A configured product is no offer at or below the threshold (B6): such an
    // application is a no-offer one, whatever the screen disclosed.
    const principalOfferable = creditLifeOfferedFor(true, appliedAmount)
    const offerAtRequest = creditLifeOfferedFor(Boolean(offerConfiguredAtRequest), appliedAmount)
    const creditLifeElection = offerAtRequest
      ? statedElection
      : (statedElection ?? "DECLINED")
    if (
      !isCreditLifeElection(creditLifeElection)
      || (offerAtRequest && body.creditLifeDisclosureAcknowledged !== true)
    ) {
      return NextResponse.json(
        { error: "Choose whether to accept or decline the credit-life offer and acknowledge the exact product, insurer, and premium before the PASQ step." },
        { status: 400 },
      )
    }
    const creditLifeAvailability = creditLifeAutoBundleDecision(appliedAmount)
    if (creditLifeElection === "ACCEPTED" && !creditLifeAvailability.eligible) {
      return NextResponse.json(
        {
          error: "Credit-life cover is not available for this application. Choose to proceed without cover.",
        },
        { status: 422 },
      )
    }
    const client = await prisma.client.findFirst({
      where: { id: sessionClientId, tenantId: tenant.id },
      include: { debtObligations: true, expenseBreakdown: true },
    })
    if (!client) {
      return NextResponse.json({ error: "Client record not found." }, { status: 404 })
    }

    const block = creditBlock(client)
    if (block.blocked) {
      // POPIA + treating-customers-fairly: don't reveal the blacklist status.
      // The client gets the same message they'd see if a defaulted loan blocked
      // them; ops follows up via the audit trail. The same reasoning covers a
      // recorded death — whoever is at the keyboard is not the person whose
      // status this is, so the reason stays in the audit row only.
      await recordSubmissionRefusal({
        tenantId: tenant.id,
        userEmail: session.user.email ?? undefined,
        action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
        entity: "LoanApplication",
        newValue: { reason: block.auditReason, clientId: client.id },
        ipAddress: callerIp(req),
      }, { tenantId: tenant.id, channel: "PORTAL", reason: block.auditReason, subject: { clientId: client.id } })
      return NextResponse.json(
        { error: "We cannot accept a new application at this time. Please contact us." },
        { status: 422 },
      )
    }

    // Overdue on a loan with this lender: no new credit until it is paid up.
    // Staff-side applications only warn; the portal refuses. A loader fallback
    // (unreadable approved application) gives null and does not block.
    const ownLenderArrears = await loadOwnLenderArrears(prisma, tenant.id, client.id)
    if (ownLenderArrears) {
      await recordSubmissionRefusal({
        tenantId: tenant.id,
        userEmail: session.user.email ?? undefined,
        action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
        entity: "LoanApplication",
        newValue: { reason: OWN_LENDER_ARREARS_REASON, clientId: client.id, days: ownLenderArrears.days },
        ipAddress: callerIp(req),
      }, { tenantId: tenant.id, channel: "PORTAL", reason: OWN_LENDER_ARREARS_REASON, subject: { clientId: client.id } })
      return NextResponse.json(
        {
          error: "New applications open once your account is up to date. Please make a payment on your overdue loan.",
          code: OWN_LENDER_ARREARS_CODE,
        },
        { status: 422 },
      )
    }

    if (!client.idNumber || client.idNumber.trim() === "") {
      // Empty-string is reachable via legacy or partial-onboarding paths even
      // though the column is NOT NULL. NCA s.81 affordability + bureau pulls
      // need an SA ID.
      return NextResponse.json(
        { error: "Your SA ID number is required before you can apply. Please complete your profile." },
        { status: 422 },
      )
    }

    // Mirror the client-side apply gate (PortalApplyProductClient disables Submit
    // when monthlyIncome <= 0). A direct API caller must not create an application
    // with no declared income: staff affordability review + the NDI snapshot are
    // the real gate, but the UI and API must agree.
    if (client.monthlyIncome <= 0) {
      return NextResponse.json(
        { error: "Please add your monthly income to your profile before you can apply." },
        { status: 422 },
      )
    }
    const expenseEvidence = createAffordabilityExpenseEvidence(client)
    if (affordabilityExpenseEvidenceNeedsMleJustification(expenseEvidence)) {
      return NextResponse.json(
        {
          error: "Your declared living expenses are below the Regulation 23A minimum and need a documented justification. Please update your financial profile before applying.",
          minimumLivingExpenses: expenseEvidence.mle.minimumExpenseCents,
        },
        { status: 422 },
      )
    }
    if (!affordabilityExpenseEvidenceIsIntact(expenseEvidence)) {
      return NextResponse.json(
        {
          error: "Your scalar and itemised expense evidence is incomplete or inconsistent. Please update your financial profile before applying.",
        },
        { status: 422 },
      )
    }

    // Resolve the EXACT product the portal page displayed, by tenant-scoped
    // unique code. Type-based resolution with creation-order tiebreak is
    // correct only by accident while each productType has one row.
    const product = await prisma.loanProduct.findFirst({
      where: { tenantId: tenant.id, code: productCode, active: true, ...CONSUMER_PRODUCT_WHERE },
    })
    if (!product) {
      return NextResponse.json(
        { error: "This loan product is not currently available." },
        { status: 422 },
      )
    }

    if (appliedAmount < product.minAmount || appliedAmount > product.maxAmount) {
      return NextResponse.json(
        {
          error: `Amount must be between R${(product.minAmount / 100).toLocaleString()} and R${(product.maxAmount / 100).toLocaleString()} for ${product.name}.`,
        },
        { status: 400 },
      )
    }

    // termDays: optional for products with a fixed term (min == max).
    let appliedTermDays: number
    if (product.minTermDays === product.maxTermDays) {
      appliedTermDays = product.minTermDays
    } else {
      const requestedTerm = Number(body.termDays)
      if (!Number.isInteger(requestedTerm) || requestedTerm <= 0) {
        return NextResponse.json({ error: "termDays must be a positive integer." }, { status: 400 })
      }
      if (requestedTerm < product.minTermDays || requestedTerm > product.maxTermDays) {
        return NextResponse.json(
          { error: `Term must be between ${product.minTermDays} and ${product.maxTermDays} days for ${product.name}.` },
          { status: 400 },
        )
      }
      appliedTermDays = requestedTerm
    }

    // PO funding is business credit tied to a confirmed order (lib/applications/po-funding.ts).
    let poFacts: PoFundingFacts | null = null
    if (product.productType === "PO_FUNDING") {
      const parsed = parsePoFundingFacts(body, loanPurposeCategory)
      if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
      // The document itself is checked inside the create transaction, below.
      poFacts = parsed.facts
    }

    // Block new applications if client has a defaulted loan (mirrors staff
    // endpoint behaviour — defaults must be resolved by ops before a new
    // application is accepted).
    const hasDefault = await prisma.loan.findFirst({
      where: { clientId: client.id, tenantId: tenant.id, status: "DEFAULTED" },
      select: { id: true },
    })
    if (hasDefault) {
      return NextResponse.json(
        { error: "You have a defaulted loan on file. Please contact us to resolve it before applying for new credit." },
        { status: 422 },
      )
    }

    // Prevent duplicate in-flight applications for the same product.
    const openApplication = await prisma.loanApplication.findFirst({
      where: {
        tenantId: tenant.id,
        clientId: client.id,
        productId: product.id,
        status: { in: [...OPEN_APPLICATION_STATUSES] },
      },
      select: { id: true, reference: true, status: true },
    })
    if (openApplication) {
      return NextResponse.json(
        {
          error: `You already have an in-progress application for this product (${openApplication.reference}). Please wait for it to be finalised.`,
          existingApplicationId: openApplication.id,
        },
        { status: 409 },
      )
    }

    let application: { id: string; reference: string; status: string }
    let submittedClient = client
    let submittedProduct = product
    try {
      const creation = await prisma.$transaction(async (tx) => {
        const evidenceExists = await lockNewApplicationSubmissionEvidence(tx, {
          tenantId: tenant.id,
          clientId: client.id,
          productId: product.id,
        })
        if (!evidenceExists) {
          return { ok: false as const, status: 422, body: { error: "Application evidence is no longer available. Please refresh and try again." } }
        }
        // Under the client-evidence lock DELETE /api/documents/[id] also takes,
        // so the purchase order cannot be deleted between this check and the
        // insert that names it (that route then refuses: it is referenced).
        if (poFacts && !(await isClientPoDocument(tx, { tenantId: tenant.id, clientId: client.id, documentId: poFacts.poDocumentId }))) {
          return { ok: false as const, status: 422, body: { error: "Upload the purchase order document again: the one sent was not found." } }
        }

        const [currentClient, currentProduct] = await Promise.all([
          tx.client.findFirst({
            where: { id: client.id, tenantId: tenant.id },
            include: { debtObligations: true, expenseBreakdown: true },
          }),
          tx.loanProduct.findFirst({
            where: { id: product.id, tenantId: tenant.id, code: productCode, active: true, ...CONSUMER_PRODUCT_WHERE },
          }),
        ])
        if (!currentClient || !currentProduct) {
          return { ok: false as const, status: 422, body: { error: "Application evidence is no longer available. Please refresh and try again." } }
        }
        // The client discloses the product identity ONLY when an offer block
        // rendered. Requiring it unconditionally would make every no-offer
        // submission die here with "offer is incomplete".
        const disclosedCreditLifeProductId =
          principalOfferable
          && typeof body.creditLifeProductId === "string" && body.creditLifeProductId.trim() !== ""
            ? body.creditLifeProductId
            : null
        if (offerAtRequest && disclosedCreditLifeProductId === null) {
          return {
            ok: false as const,
            status: 422,
            body: { error: "The disclosed credit-life offer is incomplete. Refresh and try again." },
          }
        }
        if (disclosedCreditLifeProductId !== null) {
          await tx.$queryRaw(Prisma.sql`
            SELECT product."id"
            FROM "InsuranceProduct" AS product
            JOIN "Insurer" AS insurer
              ON insurer."id" = product."insurerId"
              AND insurer."tenantId" = product."tenantId"
            WHERE product."id" = ${disclosedCreditLifeProductId}
              AND product."tenantId" = ${tenant.id}
              AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
              AND product."active" = TRUE
              AND insurer."tenantId" = ${tenant.id}
              AND insurer."active" = TRUE
            FOR SHARE OF product, insurer
          `)
        }
        // With a disclosed identity, re-read THAT product under the lock.
        // With none, re-read whether ANY offer exists now — cover appearing
        // mid-flight must surface as the explicit 409 below. (The DB guard,
        // guardLoanApplicationCreditLifeOffer, only re-validates the
        // disclosure at APPROVED/DISBURSED entry, so this 409 is the sole
        // submission-time gate.) Explicit branches: Prisma silently DROPS an
        // `id: undefined` filter, which would "work" only by
        // accident.
        const currentCreditLifeProduct = await tx.insuranceProduct.findFirst({
          where: disclosedCreditLifeProductId !== null ? {
            id: disclosedCreditLifeProductId,
            tenantId: tenant.id,
            type: "CREDIT_LIFE",
            active: true,
            insurerId: { not: null },
            insurer: {
              is: {
                tenantId: tenant.id,
                active: true,
              },
            },
          } : {
            tenantId: tenant.id,
            type: "CREDIT_LIFE",
            active: true,
            insurerId: { not: null },
            insurer: {
              is: {
                tenantId: tenant.id,
                active: true,
              },
            },
          },
          select: {
            id: true,
            name: true,
            insurerId: true,
            insurer: {
              select: {
                id: true,
                tenantId: true,
                active: true,
                name: true,
              },
            },
          },
        })
        // No active credit-life product means there was no cover to offer, so
        // there is nothing to elect on. Record the no-offer disclosure rather
        // than blocking the application.
        const creditLifeProductUsable = Boolean(
          currentCreditLifeProduct?.insurerId
          && currentCreditLifeProduct.insurer
          && currentCreditLifeProduct.insurer.id
            === currentCreditLifeProduct.insurerId
          && currentCreditLifeProduct.insurer.tenantId === tenant.id
          && currentCreditLifeProduct.insurer.active
          && currentCreditLifeProduct.name.trim() !== ""
          && currentCreditLifeProduct.insurer.name.trim() !== "",
        )
        if (!creditLifeProductUsable && currentCreditLifeProduct) {
          // A product row exists but is unusable (inactive insurer, blank
          // name). That is a broken offer, not an absent one -- fail closed,
          // with copy that matches what this applicant actually did: on the
          // no-disclosure path nothing was "disclosed" to go stale.
          return {
            ok: false as const,
            status: 422,
            body: {
              error: disclosedCreditLifeProductId !== null
                ? "The disclosed credit-life product or insurer is no longer available. Refresh and review the current offer."
                : "The credit-life offer is not correctly configured. Contact your consultant before submitting.",
            },
          }
        }
        const creditLifeOffered = creditLifeProductUsable && principalOfferable
        if (!creditLifeOffered && creditLifeElection === "ACCEPTED") {
          return {
            ok: false as const,
            status: 422,
            body: { error: "No credit-life product is configured, so cover cannot be added." },
          }
        }
        if (!creditLifeOffered && disclosedCreditLifeProductId !== null) {
          return {
            ok: false as const,
            status: 409,
            body: { error: "The credit-life offer changed before submission. Refresh and review the current exact premium before acknowledging the PASQ." },
          }
        }
        if (creditLifeOffered && disclosedCreditLifeProductId === null) {
          return {
            ok: false as const,
            status: 409,
            body: { error: "Credit-life cover became available before submission. Refresh the application and review the current offer." },
          }
        }
        const creditLifeMonthlyPremiumCents = creditLifeOffered
          ? calculateCreditLifeMonthlyPremiumCents(appliedAmount)
          : 0
        const creditLifeOffer = creditLifeOffered && currentCreditLifeProduct?.insurer
          ? {
              productId: currentCreditLifeProduct.id,
              productName: currentCreditLifeProduct.name,
              insurerId: currentCreditLifeProduct.insurerId as string,
              insurerName: currentCreditLifeProduct.insurer.name,
              monthlyPremiumCents: creditLifeMonthlyPremiumCents,
            }
          : null
        if (creditLifeOffer && !creditLifeOfferMatches({
          productId: body.creditLifeProductId,
          productName: body.creditLifeProductName,
          insurerId: body.creditLifeInsurerId,
          insurerName: body.creditLifeInsurerName,
          monthlyPremiumCents: body.creditLifeMonthlyPremiumCents,
          version: body.creditLifeDisclosureVersion,
        }, creditLifeOffer)) {
          return {
            ok: false as const,
            status: 409,
            body: { error: "The credit-life offer changed before submission. Refresh and review the current exact premium before acknowledging the PASQ." },
          }
        }
        const currentBlock = creditBlock(currentClient)
        if (currentBlock.blocked) {
          return {
            ok: false as const,
            status: 422,
            body: { error: "We cannot accept a new application at this time. Please contact us." },
            auditReason: currentBlock.auditReason,
          }
        }
        // Re-check under the lock: a loan can fall overdue after the early check.
        if (await loadOwnLenderArrears(tx, tenant.id, currentClient.id)) {
          return {
            ok: false as const,
            status: 422,
            body: {
              error: "New applications open once your account is up to date. Please make a payment on your overdue loan.",
              code: OWN_LENDER_ARREARS_CODE,
            },
            auditReason: OWN_LENDER_ARREARS_REASON,
          }
        }
        if (!currentClient.idNumber || currentClient.idNumber.trim() === "") {
          return { ok: false as const, status: 422, body: { error: "Your SA ID number is required before you can apply. Please complete your profile." } }
        }
        if (currentClient.monthlyIncome <= 0) {
          return { ok: false as const, status: 422, body: { error: "Please add your monthly income to your profile before you can apply." } }
        }

        const currentExpenses = createAffordabilityExpenseEvidence(currentClient)
        if (affordabilityExpenseEvidenceNeedsMleJustification(currentExpenses)) {
          return {
            ok: false as const,
            status: 422,
            body: {
              error: "Your declared living expenses are below the Regulation 23A minimum and need a documented justification. Please update your financial profile before applying.",
              minimumLivingExpenses: currentExpenses.mle.minimumExpenseCents,
            },
          }
        }
        if (!affordabilityExpenseEvidenceIsIntact(currentExpenses)) {
          return { ok: false as const, status: 422, body: { error: "Your scalar and itemised expense evidence is incomplete or inconsistent. Please update your financial profile before applying." } }
        }
        if (appliedAmount < currentProduct.minAmount || appliedAmount > currentProduct.maxAmount) {
          return {
            ok: false as const,
            status: 400,
            body: { error: `Amount must be between R${(currentProduct.minAmount / 100).toLocaleString()} and R${(currentProduct.maxAmount / 100).toLocaleString()} for ${currentProduct.name}.` },
          }
        }

        let lockedTermDays: number
        if (currentProduct.minTermDays === currentProduct.maxTermDays) {
          lockedTermDays = currentProduct.minTermDays
        } else {
          const requestedTerm = Number(body.termDays)
          if (!Number.isInteger(requestedTerm) || requestedTerm <= 0) {
            return { ok: false as const, status: 400, body: { error: "termDays must be a positive integer." } }
          }
          if (requestedTerm < currentProduct.minTermDays || requestedTerm > currentProduct.maxTermDays) {
            return {
              ok: false as const,
              status: 400,
              body: { error: `Term must be between ${currentProduct.minTermDays} and ${currentProduct.maxTermDays} days for ${currentProduct.name}.` },
            }
          }
          lockedTermDays = requestedTerm
        }

        const [currentDefault, currentOpenApplication] = await Promise.all([
          tx.loan.findFirst({
            where: { clientId: currentClient.id, tenantId: tenant.id, status: "DEFAULTED" },
            select: { id: true },
          }),
          tx.loanApplication.findFirst({
            where: {
              tenantId: tenant.id,
              clientId: currentClient.id,
              productId: currentProduct.id,
              status: { in: [...OPEN_APPLICATION_STATUSES] },
            },
            select: { id: true, reference: true, status: true },
          }),
        ])
        if (currentDefault) {
          return { ok: false as const, status: 422, body: { error: "You have a defaulted loan on file. Please contact us to resolve it before applying for new credit." } }
        }
        if (currentOpenApplication) {
          return {
            ok: false as const,
            status: 409,
            body: {
              error: `You already have an in-progress application for this product (${currentOpenApplication.reference}). Please wait for it to be finalised.`,
              existingApplicationId: currentOpenApplication.id,
            },
          }
        }

        // Consume the create budget only after the locked revalidation proves
        // this request is genuinely ready to create.
        const gate = await checkRateLimit(`portal:apply:${sessionClientId}`, SUBMIT_RATE_LIMIT)
        if (!gate.allowed) {
          return {
            ok: false as const,
            status: 429,
            body: { error: "You've submitted several applications in a short window. Please wait before submitting another." },
            retryAfter: gate.retryAfterSeconds,
          }
        }

        const totalExistingDebt = currentClient.debtObligations.reduce(
          (sum, debt) => sum + debt.monthlyInstalment,
          0,
        )
        const debtSnapshot = currentClient.debtObligations.map((debt) => ({
          sourceId: debt.id,
          provider: debt.creditProvider,
          type: debt.accountType,
          balance: debt.outstandingBalance,
          monthlyInstalment: debt.monthlyInstalment,
          notes: debt.notes,
        }))
        const submittedAt = new Date()
        const creditLifeDisclosureVersion = creditLifeOffer
          ? CREDIT_LIFE_DISCLOSURE_VERSION
          : CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION
        const creditLifeDisclosureSha256 = creditLifeOffer
          ? createCreditLifeDisclosureSha256({
              version: CREDIT_LIFE_DISCLOSURE_VERSION,
              election: creditLifeElection,
              principalCents: appliedAmount,
              termDays: lockedTermDays,
              ...creditLifeOffer,
            })
          : createCreditLifeNoOfferDisclosureSha256({
              version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
              election: "DECLINED",
              principalCents: appliedAmount,
              termDays: lockedTermDays,
            })
        const submissionSnapshot = await ownAwareSubmissionSnapshot(tx, tenant.id, currentClient.id, {
          capturedAt: submittedAt,
          capturedById: currentClient.id,
          client: currentClient,
          applicationDebts: debtSnapshot,
          clientDebts: currentClient.debtObligations,
          application: {
            appliedAmount,
            appliedTermDays: lockedTermDays,
            productId: currentProduct.id,
            initiationFeePayment: "DEFERRED",
            creditLifeMonthlyPremiumCents:
              creditLifeElection === "ACCEPTED"
                ? creditLifeMonthlyPremiumCents
                : 0,
          },
          product: {
            interestRatePm: currentProduct.interestRatePm,
            interestModel: currentProduct.interestModel,
            initiationFeeModel: currentProduct.initiationFeeModel,
            initiationFeePct: currentProduct.initiationFeePct,
            initiationFeeMax: currentProduct.initiationFeeMax,
            monthlyServiceFee: currentProduct.monthlyServiceFee,
            productType: currentProduct.productType,
          },
        })
        const created = await tx.loanApplication.create({
          data: {
            tenantId: tenant.id,
            reference: generateReference("APP"),
            clientId: currentClient.id,
            productId: currentProduct.id,
            appliedAmount,
            appliedTermDays: lockedTermDays,
            purpose,
            loanPurposeCategory,
            ...poFacts,
            agreementType: classifyAgreementType(appliedAmount),
            existingDebtObligations: debtSnapshot,
            totalExistingDebt,
            netDisposableIncome: submissionSnapshot.outcome.netDisposableIncomeCents,
            affordabilityNDI: submissionSnapshot.outcome.ndiAfterLoanCents,
            affordabilityResult: withAffordabilitySnapshot(
              null,
              submissionSnapshot,
            ) as unknown as Prisma.InputJsonValue,
            status: "SUBMITTED",
            submittedAt,
            clientAffordabilityDeclaredAt: submittedAt,
            creditLifeElection,
            creditLifeProductId: creditLifeOffer?.productId ?? null,
            creditLifeProductName: creditLifeOffer?.productName ?? null,
            creditLifeInsurerId: creditLifeOffer?.insurerId ?? null,
            creditLifeInsurerName: creditLifeOffer?.insurerName ?? null,
            creditLifeMonthlyPremiumCents,
            creditLifeDisclosureVersion,
            creditLifeDisclosureSha256,
            creditLifeDisclosureAcknowledgedAt: submittedAt,
            creditLifeDisclosureAcknowledgedBy: currentClient.id,
          },
          select: { id: true, reference: true, status: true },
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userEmail: session.user.email ?? null,
            action: AuditAction.APPLICATION_SUBMITTED_BY_CLIENT,
            entity: "LoanApplication",
            entityId: created.id,
            newValue: {
              reference: created.reference,
              clientId: currentClient.id,
              productId: currentProduct.id,
              productType: currentProduct.productType,
              appliedAmount,
              appliedTermDays: lockedTermDays,
              pasqDeliveryNoticeAcceptedByClient: true,
              affordabilityDeclaredByClient: true,
              snapshotSchemaVersion: AFFORDABILITY_SNAPSHOT_SCHEMA_VERSION,
              decisionFingerprint: submissionSnapshot.decisionFingerprint,
            },
            ipAddress: callerIp(req),
          },
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            userEmail: session.user.email ?? null,
            action: AuditAction.CREDIT_LIFE_ELECTION_RECORDED,
            entity: "LoanApplication",
            entityId: created.id,
            newValue: {
              election: creditLifeElection,
              ...(creditLifeOffer ?? {}),
              disclosureVersion: creditLifeDisclosureVersion,
              disclosureSha256: creditLifeDisclosureSha256,
              acknowledgedAt: submittedAt.toISOString(),
              acknowledgedBy: currentClient.id,
            },
            ipAddress: callerIp(req),
          },
        })
        return {
          ok: true as const,
          application: created,
          client: currentClient,
          product: currentProduct,
          appliedTermDays: lockedTermDays,
        }
      })

      if (!creation.ok) {
        // Audit on the PRESENCE of a reason, not on one specific spelling of
        // it. Matching the literal "client_blacklisted" meant the second block
        // reason to exist (client_deceased) would have returned 422 with no
        // audit row at all — a submission refused and no record of why.
        if (creation.auditReason) {
          await recordSubmissionRefusal({
            tenantId: tenant.id,
            userEmail: session.user.email ?? undefined,
            action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
            entity: "LoanApplication",
            newValue: { reason: creation.auditReason, clientId: client.id },
            ipAddress: callerIp(req),
          }, { tenantId: tenant.id, channel: "PORTAL", reason: creation.auditReason, subject: { clientId: client.id } })
        }
        return NextResponse.json(
          creation.body,
          {
            status: creation.status,
            ...(creation.retryAfter !== undefined && {
              headers: { "Retry-After": String(creation.retryAfter) },
            }),
          },
        )
      }
      application = creation.application
      submittedClient = creation.client
      submittedProduct = creation.product
      appliedTermDays = creation.appliedTermDays
    } catch (error) {
      // The partial unique index closes the check-then-create race. Verify the
      // competing row exists before mapping P2002 to this domain-specific 409,
      // because the globally unique reference can also raise P2002.
      if (isUniqueConstraintViolation(error)) {
        const concurrentApplication = await prisma.loanApplication.findFirst({
          where: {
            tenantId: tenant.id,
            clientId: client.id,
            productId: product.id,
            status: { in: [...OPEN_APPLICATION_STATUSES] },
          },
          select: { id: true, reference: true, status: true },
        })
        if (concurrentApplication) {
          await recordSubmissionRefusal({
            tenantId: tenant.id,
            userEmail: session.user.email ?? undefined,
            action: AuditAction.APPLICATION_SUBMISSION_BLOCKED,
            entity: "LoanApplication",
            entityId: concurrentApplication.id,
            newValue: {
              reason: "open_application_exists",
              source: "portal_apply_concurrent",
              clientId: client.id,
              productId: product.id,
              existingStatus: concurrentApplication.status,
              requestedAmount: appliedAmount,
              requestedTermDays: appliedTermDays,
            },
            ipAddress: callerIp(req),
          }, {
            tenantId: tenant.id,
            channel: "PORTAL",
            reason: "open_application_exists",
            subject: { clientId: client.id },
            existingApplicationId: concurrentApplication.id,
          })
          return NextResponse.json(
            {
              error: `You already have an in-progress application for this product (${concurrentApplication.reference}). Please wait for it to be finalised.`,
              existingApplicationId: concurrentApplication.id,
            },
            { status: 409 },
          )
        }
      }
      throw error
    }

    // Referral-agent repeat-loan attribution: if this client was originally referred
    // by an agent (durable link on Client.referralCodeId), credit that
    // agent for their REPEAT loans. The acquisition (first loan) is already
    // credited by the signup enquiry event (WEBSITE_APPLICATION) in
    // /api/website/apply, so we only fire once the client is a genuine
    // repeat borrower (holds a prior Loan) — otherwise the first loan would be
    // double-credited and metadata.repeatLoan would be untrue. Subject to the
    // same active-agent / active-code gate. This event is attribution/analytics
    // only (NOT_ELIGIBLE) — it carries no commission; commission for the loan now
    // accrues at DISBURSEMENT as a PENDING CONVERTED event (see
    // lib/referral-agents/commission.ts recordDisbursementCommission), which is what
    // LOAN_ADMIN approves. Non-fatal: a referral bookkeeping write must never fail
    // a real application.
    if (submittedClient.referralCodeId) {
      try {
        const priorLoanCount = await prisma.loan.count({
          where: { tenantId: tenant.id, clientId: submittedClient.id },
        })
        if (priorLoanCount > 0) {
          const referralCode = await resolveReferralCodeById(prisma, {
            tenantId: tenant.id,
            id: submittedClient.referralCodeId,
          })
          if (referralCode) {
            await recordReferralEvent(prisma, {
              tenantId: tenant.id,
              eventType: "WEBSITE_APPLICATION",
              source: "PORTAL",
              referralCode,
              amountCents: appliedAmount,
              commissionStatus: "NOT_ELIGIBLE", // repeat-loan attribution only; commission accrues at disbursement
              metadata: {
                applicationId: application.id,
                applicationReference: application.reference,
                productType: submittedProduct.productType,
                repeatLoan: true,
              },
            })
          }
        }
      } catch (err) {
        console.error("[portal/applications] referral-agent attribution failed:", err)
      }
    }

    triggerNotification({
      tenantId: tenant.id,
      event: "application_submitted",
      loanId: application.id,
      clientId: submittedClient.id,
    }).catch((err) => {
      console.error("[portal/applications] application_submitted notification failed:", err)
    })
    // PEP / sanctions screening; never blocks or fails the submission.
    void screenOnSubmit({ tenantId: tenant.id, applicationId: application.id, actor: null })

    return NextResponse.json(application, { status: 201 })
  })
}
