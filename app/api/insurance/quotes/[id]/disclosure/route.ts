// app/api/insurance/quotes/[id]/disclosure/route.ts
//
// Issuing the FAIS disclosure for a QUOTE, and with it the token that binds it.
//
// WHY THIS EXISTS RATHER THAN REUSING policies/draft. That route issues a
// disclosure for ONE life priced from the request body. `bindQuote` requires
// the token to carry the quote's TOTALS — sums across every covered life — so a
// family quote could never obtain a token the bind would accept, and multi-life
// funeral cover, the point of this phase, was unreachable end to end. Every
// layer passed its own tests; nothing exercised the seam.
//
// IT DOES NOT RE-RATE. The quote's lives already carry the premium and the band
// that priced them, persisted at quote time. This renders those figures. That
// is not a shortcut, it is the correct FAIS posture twice over:
//
//   - the client must see the price that was actually quoted and screened, not
//     one re-derived later against a rate card that may since have been
//     retired; and
//   - re-rating here would introduce a SECOND rating date. The quote rates at
//     its `effectiveDate` and this route would rate at `new Date()`, so an
//     age-band boundary crossed between the two would produce a token that
//     silently disagrees with the quote — a mismatch indistinguishable from
//     tampering.
//
// There is therefore exactly one rating event per quote, at creation.

import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import type { PrismaClient } from "@prisma/client"
import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { findLenderIdentity } from "@/lib/config/identity"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { generateFaisDisclosurePdf } from "@/lib/pdf/faisDisclosure"
import { hashDraftToken, signDraftToken } from "@/lib/insurance/disclosure-token"
import { loadEligibilityRules } from "@/lib/insurance/eligibility/rules"
import { evaluate } from "@/lib/insurance/eligibility/evaluate"
import { waitingPeriodEndsFor } from "@/lib/insurance/policy/bind"
import { getLenderLogo } from "@/lib/config/lender-logo"
import { saveFileAt } from "@/lib/storage"

/** Statuses a quote may be disclosed in: priced, and not yet finished with. */
const DISCLOSABLE = ["QUOTED", "ADVICE_RECORDED", "SUBMITTED_TO_INSURER", "ACCEPTED"]

/**
 * How many disclosures one quote may have issued.
 *
 * Each call mints a token with a fresh `iat`, so a fresh signature, so a fresh
 * sha256 filename — N calls write N PDFs under uploads/disclosures/<tenant>/
 * with nothing deduplicating or deleting them. Re-issuing is legitimate (a
 * client loses the document, a figure is corrected upstream), so this is a
 * bound rather than a prohibition, on a shared host where disk has bitten
 * before.
 */
const MAX_DISCLOSURES_PER_QUOTE = 10

// REFUSAL PARITY WITH THE BIND — the list every future change must revisit.
//
// This route writes a client-facing regulatory document. The bind is what
// creates cover. If the bind can refuse for a reason this route does not check,
// the failure lands in the worst possible order: the document is rendered,
// written and signed, the client believes they are covered, and only the bind
// refuses — after the conversation is over.
//
// That has now happened TWICE from the same cause: a guard added at the bind
// silently created an upstream hole here. Expiry, then eligibility. The lesson
// generalises past either: ADDING A LATE GUARD CREATES AN UPSTREAM GAP WHEREVER
// A SIDE EFFECT INTERVENES. Note also that no dead-select sweep can find this
// class — the eligibility gap had no select to notice.
//
// So: for every refusal `BindRefusal` gains, decide here whether this route
// owes the same check BEFORE its first filesystem write, and record the answer.
//
//   QUOTE_NOT_FOUND ........ reproduced
//   NOT_PRICED ............. reproduced
//   NO_LIVES ............... reproduced
//   QUOTE_EXPIRED .......... reproduced
//   NOT_ELIGIBLE ........... reproduced (screened against CURRENT terms)
//   WAITING_PERIOD_INVALID . reproduced (the term must be usable)
//   ALREADY_CONVERTED ...... reproduced — a bound quote needs no new disclosure
//   NOT_BINDABLE ........... NOT reproduced, deliberately. It refuses a status
//                            that is not ACCEPTED, but QUOTED and
//                            ADVICE_RECORDED are legitimately disclosable —
//                            disclosure precedes acceptance. DISCLOSABLE is the
//                            correct narrower check and is applied above.
//   START_DATE_OUT_OF_RANGE  n/a — the caller supplies a start date at bind,
//                            not here.
//   TOKEN_* ................ n/a — this route ISSUES the token.

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const { id } = await params

      // Every refusal below is audited through this, because a refused
      // disclosure is a control firing. Repeated attempts to obtain one for an
      // expired, unpriced or DRAFT quote are exactly what an auditor asking
      // "did this gate ever fire?" needs to see, and previously only the
      // SUCCESS path wrote a row.
      const refuse = async (reason: string, error: string, status: number) => {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.INSURANCE_QUOTE_DISCLOSURE_REFUSED,
          entity: "InsuranceQuote",
          entityId: id,
          newValue: { reason, detail: error },
        })
        return NextResponse.json({ error, reason }, { status })
      }

      const quote = await prisma.insuranceQuote.findFirst({
        where: { id, tenantId: tenant.id },
        select: {
          id: true,
          status: true,
          quoteNumber: true,
          clientId: true,
          productId: true,
          advisorId: true,
          totalPremium: true,
          totalSumAssured: true,
          expiresAt: true,
          disclosuresIssued: true,
          convertedPolicyId: true,
          effectiveDate: true,
          client: { select: { firstName: true, lastName: true, idNumber: true } },
          product: { select: { type: true, name: true } },
          advisor: { select: { name: true, email: true } },
          lives: {
            orderBy: [{ lifeType: "asc" }, { createdAt: "asc" }],
            select: {
              firstName: true, lastName: true, lifeType: true,
              relationship: true, sumAssured: true, premiumAmount: true,
              // Selected so this route can RE-SCREEN, not merely render.
              dateOfBirth: true,
            },
          },
        },
      })
      if (!quote) {
        return await refuse("QUOTE_NOT_FOUND", "Quote not found", 404)
      }

      if (!DISCLOSABLE.includes(quote.status)) {
        return await refuse(
          "NOT_DISCLOSABLE",
          `A ${quote.status} quote cannot be disclosed. Only a priced, live quote may be presented to a client.`,
          409,
        )
      }

      // Belt and braces with the status check: the columns are nullable because
      // a DRAFT carries no price, and a disclosure showing a blank premium is a
      // regulatory document that discloses nothing.
      if (quote.totalPremium === null || quote.totalSumAssured === null) {
        return await refuse("NOT_PRICED", "Quote carries no premium, so there is nothing to disclose", 409)
      }

      if (quote.lives.length === 0) {
        return await refuse("NO_LIVES", "Quote covers no lives", 409)
      }

      // An EXPIRED quote gets no disclosure.
      //
      // `bindQuote` already refuses one, so without this the failure lands in
      // the worst possible order: the client-facing FAIS document is rendered,
      // written to disk and presented, the client signs it believing they are
      // covered, and only the bind — after the conversation is over — refuses.
      // A regulatory artefact must never exist for cover that cannot be sold.
      //
      // `expiresAt` was selected here and read by nothing until this check
      // existed, which is the same shape as the B5 defect one layer down.
      const now = new Date()
      if (quote.expiresAt !== null && quote.expiresAt <= now) {
        return await refuse(
          "QUOTE_EXPIRED",
          `This quote expired on ${quote.expiresAt.toISOString()}. Re-quote at current rates before disclosing.`,
          409,
        )
      }

      // Issuance is bounded. Re-issuing is legitimate, issuing without
      // limit is not: each call writes another PDF that nothing deletes.
      if (quote.disclosuresIssued >= MAX_DISCLOSURES_PER_QUOTE) {
        return await refuse(
          "TOO_MANY_DISCLOSURES",
          `This quote has already had ${quote.disclosuresIssued} disclosures issued. Re-quote rather than issuing another.`,
          429,
        )
      }

      // ALREADY_CONVERTED — a quote already bound to a policy needs no further
      // disclosure, and issuing one would put a fresh document in front of a
      // client for cover that has already been sold.
      if (quote.convertedPolicyId) {
        return await refuse(
          "ALREADY_CONVERTED",
          `This quote is already bound to policy ${quote.convertedPolicyId}`,
          409,
        )
      }

      // NOT_ELIGIBLE / WAITING_PERIOD_INVALID — screened against the insurer's
      // CURRENT terms, exactly as the bind does.
      //
      // The quote's stored `eligibilityResult` is NOT evidence here: it records
      // what was true when the quote was created, and the Phase 2 config UI
      // exists precisely so an operator can change those terms afterwards. A
      // document must not be presented to a client for lives the insurer would
      // refuse today.
      // Variance cast for the $extends client, as elsewhere in this module.
      const ruleReader = prisma as unknown as PrismaClient
      const rules = await loadEligibilityRules(ruleReader, {
        tenantId: tenant.id,
        productId: quote.productId,
      })
      const screen = evaluate({
        rules,
        lives: quote.lives.map((life) => ({
          ref: `${life.firstName} ${life.lastName}`,
          lifeType: life.lifeType,
          dateOfBirth: life.dateOfBirth,
          sumAssured: life.sumAssured,
        })),
        effectiveDate: quote.effectiveDate,
      })
      if (!screen.pass) {
        return await refuse(
          "NOT_ELIGIBLE",
          `The insurer's acceptance terms refuse this quote: ${screen.failures.map((f) => f.detail).join("; ")}`,
          409,
        )
      }
      for (const life of quote.lives) {
        const waiting = waitingPeriodEndsFor(rules, life.lifeType, quote.effectiveDate)
        if (!waiting.ok) {
          return await refuse("WAITING_PERIOD_INVALID", waiting.detail, 409)
        }
      }

      // ATOMIC RESERVATION, before a single byte is rendered.
      //
      // The disclosure names the FSP and its licence number: refuse before
      // reserving a slot when the lender identity is not configured.
      const lender = await findLenderIdentity(tenant.id)
      if (!lender) {
        return refuse(
          "LENDER_IDENTITY_NOT_CONFIGURED",
          "Lender identity is not configured. An administrator must complete Settings → Lender identity first.",
          409,
        )
      }

      // One statement closes two holes at once:
      //
      //   - the cap, which a plain read-then-write would let two concurrent
      //     requests both pass; and
      //   - the expiry TOCTOU. `expiresAt` was read above and the PDF is
      //     written below, so a quote expiring in between still got a
      //     client-facing document. Re-asserting it in the WHERE clause means
      //     the slot is only reserved while the quote is genuinely still live.
      //
      // Reserving BEFORE rendering also fails in the safe direction: a crash
      // after this point burns one of the ten rather than leaving a file on
      // disk that no counter knows about.
      const reserved = await prisma.insuranceQuote.updateMany({
        where: {
          id: quote.id,
          tenantId: tenant.id,
          status: quote.status,
          disclosuresIssued: { lt: MAX_DISCLOSURES_PER_QUOTE },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data: { disclosuresIssued: { increment: 1 } },
      })
      if (reserved.count === 0) {
        return await refuse(
          "RESERVATION_LOST",
          "The quote expired, changed status, or reached its disclosure limit while this request was in flight. Re-read it and retry.",
          409,
        )
      }

      // The token carries the quote's OWN persisted totals, plus its identity.
      // `bindQuote` compares every one of these, so the disclosure the client
      // signed is provably the one the policy is bound from.
      const sumAssured = Number(quote.totalSumAssured.toFixed(2))
      const premiumAmount = Number(quote.totalPremium.toFixed(2))

      const draftToken = signDraftToken({
        tenantId: tenant.id,
        clientId: quote.clientId,
        advisorId: quote.advisorId ?? guard.user.id,
        type: quote.product.type,
        sumAssured,
        premiumAmount,
        productId: quote.productId,
        quoteId: quote.id,
      })

      // Stored under sha256(token), NOT under the token itself.
      //
      // The legacy route names the file `<payload>.<sig>.pdf`, which worked
      // only because its payload was small. This one additionally carries the
      // quoteId, and the base64url token then exceeds the 255-byte filename
      // limit — every write failed with ENAMETOOLONG. A hash is fixed-length
      // whatever the payload grows to. The serving route derives the same hash
      // from the token, so the URL is unchanged and legacy files still resolve.
      // Written through lib/storage, so encrypted at rest like every upload.
      const storageRelativePath = `disclosures/${tenant.id}/${hashDraftToken(draftToken)}.pdf`

      const pdfBuffer = await generateFaisDisclosurePdf({
        lender,
        logo: await getLenderLogo(tenant.id),
        client: {
          firstName: quote.client.firstName,
          lastName: quote.client.lastName,
          idNumber: quote.client.idNumber,
        },
        advisor: {
          name: quote.advisor?.name ?? quote.advisor?.email ?? guard.user.email,
          designation: "Insurance Officer",
        },
        product: { type: quote.product.type, name: quote.product.name },
        policyDraft: { sumAssured, premiumAmount },
        // Each life, its cover and its rated premium. A disclosure that showed
        // only the total would misstate who is covered.
        lives: quote.lives.map((life) => ({
          firstName: life.firstName,
          lastName: life.lastName,
          lifeType: life.lifeType,
          relationship: life.relationship,
          sumAssured: Number(life.sumAssured.toFixed(2)),
          premiumAmount: life.premiumAmount === null ? null : Number(life.premiumAmount.toFixed(2)),
        })),
      })

      await saveFileAt(storageRelativePath, pdfBuffer)
      const pdfSha256 = createHash("sha256").update(pdfBuffer).digest("hex")

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.INSURANCE_QUOTE_DISCLOSURE_ISSUED,
        entity: "InsuranceQuote",
        entityId: quote.id,
        newValue: {
          quoteNumber: quote.quoteNumber,
          // The hash of the document actually presented, and the figures on it.
          pdfSha256,
          totalPremium: quote.totalPremium.toFixed(2),
          totalSumAssured: quote.totalSumAssured.toFixed(2),
          lives: quote.lives.length,
        },
      })

      return NextResponse.json(
        {
          quoteId: quote.id,
          draftToken,
          pdfUrl: `/api/insurance/disclosures/${draftToken}`,
          pdfSha256,
          totalPremium: quote.totalPremium.toFixed(2),
          totalSumAssured: quote.totalSumAssured.toFixed(2),
          lives: quote.lives.length,
        },
        { status: 201 }
      )
    })
  } catch (error) {
    console.error("Failed to issue quote disclosure:", error)
    return NextResponse.json({ error: "Failed to issue quote disclosure" }, { status: 500 })
  }
}
