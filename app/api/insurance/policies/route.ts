import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { Prisma, InsurancePolicyType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { premiumCommission } from "@/lib/insurance/commission"
import { hashDraftToken, verifyDraftToken } from "@/lib/insurance/disclosure-token"
import { sastMonthStart, sastParts } from "@/lib/date/sast"
import { policyNumberPrefix } from "@/lib/insurance/policy/bind"

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const policies = await prisma.insurancePolicy.findMany({
        where: { tenantId: tenant.id },
        orderBy: { createdAt: "desc" },
        include: { client: { select: { firstName: true, lastName: true } } },
      })
      return NextResponse.json(policies)
    })
  } catch {
    return NextResponse.json({ error: "Failed to fetch policies" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      let body: Record<string, unknown>
      try {
        body = await req.json()
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 422 })
      }

      // ── Task 8: FAIS gate ──────────────────────────────────────────────────────
      const { faisDisclosureAt, faisDisclosurePdfUrl, draftToken } = body as {
        faisDisclosureAt?: unknown
        faisDisclosurePdfUrl?: unknown
        draftToken?: unknown
      }

      if (!faisDisclosureAt || !faisDisclosurePdfUrl || !draftToken) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_FAIS_GATE_REJECTED,
          entity: "InsurancePolicy",
          newValue: { reason: "fais_required", advisorId: body.advisorId ?? null },
        })
        return NextResponse.json(
          { error: "FAIS disclosure required: faisDisclosureAt, faisDisclosurePdfUrl, and draftToken must be provided" },
          { status: 422 }
        )
      }

      // Verify the draft token
      const verification = verifyDraftToken(String(draftToken))
      if (!verification.ok) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_FAIS_GATE_REJECTED,
          entity: "InsurancePolicy",
          newValue: { reason: "invalid_token", advisorId: body.advisorId ?? null },
        })
        return NextResponse.json(
          { error: "Invalid or expired FAIS disclosure token" },
          { status: 422 }
        )
      }

      // Verify tenantId in token matches this request's tenant
      if (verification.payload.tenantId !== tenant.id) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_FAIS_GATE_REJECTED,
          entity: "InsurancePolicy",
          newValue: { reason: "tenant_mismatch", advisorId: body.advisorId ?? null },
        })
        return NextResponse.json(
          { error: "FAIS disclosure token does not belong to this tenant" },
          { status: 422 }
        )
      }

      // Verify pdfUrl matches /api/insurance/disclosures/<token>
      const expectedPdfUrl = `/api/insurance/disclosures/${draftToken}`
      if (String(faisDisclosurePdfUrl) !== expectedPdfUrl) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_FAIS_GATE_REJECTED,
          entity: "InsurancePolicy",
          newValue: { reason: "invalid_pdf_url", advisorId: body.advisorId ?? null },
        })
        return NextResponse.json(
          { error: "faisDisclosurePdfUrl does not match the provided draftToken" },
          { status: 422 }
        )
      }

      // A QUOTE'S DISCLOSURE MAY NOT BE REDEEMED HERE.
      //
      // This route never consults the quote — it has no reference to quoteId,
      // InsuranceQuote or InsuranceAdviceRecord anywhere. So a disclosure minted
      // for a quote could be spent here instead of at the bind, producing an
      // ACTIVE policy with a premium schedule and an advisor commission and NO
      // record of advice: the FAIS obligation skipped in three requests, because
      // the advice gate lives on the bind path this sequence never touches.
      //
      // Refused on the presence of `quoteId` alone, NOT on the quote's status.
      // Status-based reasoning would close today's instance and leave the class
      // open — this route exists for single-life standalone policies and has no
      // business redeeming a quote's disclosure whatever state that quote is in.
      //
      // It is also the completion of the asymmetry the bind already enforces: a
      // legacy token cannot bind a quote, and now a quote token cannot make a
      // legacy policy. Each path redeems only the disclosures issued for it.
      if (verification.payload.quoteId) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_FAIS_GATE_REJECTED,
          entity: "InsurancePolicy",
          newValue: {
            reason: "quote_token_on_legacy_path",
            quoteId: verification.payload.quoteId,
            advisorId: body.advisorId ?? null,
          },
        })
        return NextResponse.json(
          {
            error: "This disclosure was issued for a quote. Bind it with POST /api/insurance/quotes/{id}/bind, which enforces the record of advice.",
            reason: "QUOTE_TOKEN_NOT_REDEEMABLE_HERE",
          },
          { status: 422 }
        )
      }

      // Hash-match critical fields: body sends cents, token payload is rands
      const bodyClientId = typeof body.clientId === "string" ? body.clientId : null
      const bodyAdvisorId = typeof body.advisorId === "string" ? body.advisorId : null
      const bodyType = typeof body.type === "string" ? body.type : null
      const bodySumAssuredCents = typeof body.sumAssured === "number" ? body.sumAssured : null
      const bodyPremiumCents = typeof body.premiumAmount === "number" ? body.premiumAmount : null
      const bodyProductId = typeof body.productId === "string" ? body.productId : null

      const p = verification.payload
      const sumAssuredRands = bodySumAssuredCents !== null ? bodySumAssuredCents / 100 : null
      const premiumRands = bodyPremiumCents !== null ? bodyPremiumCents / 100 : null

      const hashMismatch =
        bodyClientId !== p.clientId ||
        bodyAdvisorId !== p.advisorId ||
        bodyType !== p.type ||
        sumAssuredRands !== p.sumAssured ||
        premiumRands !== p.premiumAmount ||
        bodyProductId !== p.productId

      if (hashMismatch) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_FAIS_GATE_REJECTED,
          entity: "InsurancePolicy",
          newValue: { reason: "hash_mismatch", advisorId: body.advisorId ?? null },
        })
        return NextResponse.json(
          { error: "Policy fields do not match the FAIS disclosure that was presented to the client" },
          { status: 422 }
        )
      }

      // Coerce policySource to STANDALONE — client cannot bypass gate by claiming bundle
      const policySource = "STANDALONE" as const

      // Server-stamp the disclosure timestamp. The body must include
      // faisDisclosureAt (presence-checked above) as proof the client went
      // through the disclosure flow, but the persisted value is stamped here
      // so callers cannot backdate or post-date the regulatory acknowledgement.
      const serverFaisDisclosureAt = new Date()

      // R-09: token replay protection. The token is HMAC-signed and has a
      // 1-hour TTL, but nothing in the token itself records whether it has
      // been used. A persisted sha256(token) on InsurancePolicy with a
      // unique index turns the second use into a hard 422.
      const draftTokenHash = hashDraftToken(String(draftToken))
      const replayed = await prisma.insurancePolicy.findUnique({
        where: { faisDraftTokenHash: draftTokenHash },
        select: { id: true },
      })
      if (replayed) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_FAIS_GATE_REJECTED,
          entity: "InsurancePolicy",
          newValue: { reason: "token_replay", advisorId: body.advisorId ?? null },
        })
        return NextResponse.json(
          { error: "This FAIS disclosure token has already been used to bind a policy. Issue a fresh disclosure." },
          { status: 422 }
        )
      }

      // ── End FAIS gate ──────────────────────────────────────────────────────────

      // Use clientId from verified token payload (more secure than body.clientEmail)
      const verifiedClientId = verification.payload.clientId

      const client = await prisma.client.findFirst({
        where: { tenantId: tenant.id, id: verifiedClientId },
      })
      if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })

      // Backward-compat: if clientEmail was also sent, assert it matches the token-verified client
      if (body.clientEmail && client.email !== body.clientEmail) {
        await logAudit({
          tenantId: tenant.id,
          userId: guard.user?.id,
          userEmail: guard.user?.email,
          action: AuditAction.INSURANCE_FAIS_GATE_REJECTED,
          entity: "InsurancePolicy",
          newValue: { reason: "hash_mismatch", advisorId: body.advisorId ?? null },
        })
        return NextResponse.json(
          { error: "clientEmail does not match the client in the FAIS disclosure token" },
          { status: 422 }
        )
      }

      if (body.advisorId) {
        const advisor = await prisma.user.findFirst({
          where: { id: String(body.advisorId), tenantId: tenant.id },
          select: { id: true },
        })
        if (!advisor) {
          return NextResponse.json({ error: "Advisor not found" }, { status: 404 })
        }
      }

      // ── Task 5: Cover range server-side validation ────────────────────────────
      const sumAssured = (body.sumAssured as number) / 100
      const premiumAmount = (body.premiumAmount as number) / 100

      if (body.type === "LIFE_INSURANCE") {
        if (sumAssured < 100000 || sumAssured > 5000000) {
          return NextResponse.json(
            { error: "Life Insurance sum assured must be between R100,000 and R5,000,000" },
            { status: 400 }
          )
        }
      }

      if (body.type === "CREDIT_LIFE" && body.linkedLoanRef) {
        // Resolve the linked loan to check the outstanding principal
        const loan = await prisma.loan.findFirst({
          where: { tenantId: tenant.id, reference: String(body.linkedLoanRef) },
          select: { principal: true, outstandingPrincipal: true },
        })
        if (loan) {
          const loanAmount = loan.outstandingPrincipal / 100
          if (sumAssured > loanAmount) {
            return NextResponse.json(
              { error: `Credit Life sum assured (R${sumAssured.toLocaleString("en-ZA")}) cannot exceed the linked loan outstanding balance (R${loanAmount.toLocaleString("en-ZA")})` },
              { status: 400 }
            )
          }
        }
      }

      const type = body.type as string
      const prefix = policyNumberPrefix(type)

      const startDate = new Date(body.startDate as string)
      const renewalDate = new Date(startDate)
      renewalDate.setFullYear(renewalDate.getFullYear() + 1)

      // A fraction of the premium (0.15 = 15%), 0 to 1. Absent, the old default.
      const requestedRate = body.commissionRate ?? 0.15
      if (typeof requestedRate !== "number" || !Number.isFinite(requestedRate) || requestedRate < 0 || requestedRate > 1) {
        return NextResponse.json({ error: "commissionRate must be a number from 0 to 1 (a fraction of the premium)" }, { status: 400 })
      }

      // A catalogue product's own rate wins, so the policy's commission and the
      // advisor's commission row are computed from the same figure.
      let productCommissionRate = requestedRate
      if (body.productId) {
        const product = await prisma.insuranceProduct.findFirst({
          where: { id: String(body.productId), tenantId: tenant.id },
          select: { commissionRate: true },
        })
        if (!product) {
          return NextResponse.json({ error: "Insurance product not found" }, { status: 404 })
        }
        productCommissionRate = Number(product.commissionRate)
      }
      const commissionRate = productCommissionRate
      const commissionAmount = premiumCommission(premiumAmount, commissionRate)

      // count() and create() can't be atomic without a per-tenant sequence,
      // so two concurrent POSTs for the same prefix can derive the same
      // policyNumber and the second create() throws P2002 against
      // @@unique([tenantId, policyNumber]). Re-read count() and retry up to
      // MAX_ATTEMPTS times before giving up with 409.
      const MAX_ATTEMPTS = 3
      let policy: Awaited<ReturnType<typeof prisma.insurancePolicy.create>> | undefined
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const count = await prisma.insurancePolicy.count({ where: { tenantId: tenant.id } })
        const policyNumber = `${prefix}-${String(count + 1).padStart(4, "0")}`

        try {
          policy = await prisma.$transaction(async (tx) => {
            const created = await tx.insurancePolicy.create({
              data: {
                tenantId: tenant.id,
                policyNumber,
                clientId: client.id,
                type: body.type as InsurancePolicyType,
                status: "ACTIVE",
                premiumAmount,
                sumAssured,
                startDate,
                renewalDate,
                insurer: (body.insurer as string) || null,
                commissionRate,
                commissionAmount,
                productId: (body.productId as string) || null,
                advisorId: (body.advisorId as string) || null,
                // Task 8: FAIS gate fields — policySource coerced to STANDALONE,
                // faisDisclosureAt is server-stamped (client-supplied value is
                // presence-only proof of flow and intentionally discarded here).
                policySource,
                faisDisclosureAt: serverFaisDisclosureAt,
                faisDisclosurePdfUrl: String(faisDisclosurePdfUrl),
                faisDraftTokenHash: draftTokenHash,
                // Risk fields
                vehicleRegNumber: (body.vehicleRegNumber as string) || null,
                vehicleValue: body.vehicleValue ? parseFloat(String(body.vehicleValue)) : null,
                vehicleUse: (body.vehicleUse as string) || null,
                propertyAddress: (body.propertyAddress as string) || null,
                constructionType: (body.constructionType as string) || null,
                propertyValue: body.propertyValue ? parseFloat(String(body.propertyValue)) : null,
              },
            })

            // Auto-generate monthly premium schedule (12 months)
            const termMonths = 12
            // The 1st of each of the next 12 SAST months. Built with local
            // `setMonth`/`setDate(1)` this landed a day out for a policy
            // started late in a South African evening — 22:30 SAST is already
            // the next day in Johannesburg but still the current one in UTC,
            // so the premium fell due on the 2nd. These rows are WRITTEN, so
            // the error was durable rather than a display artefact.
            const { year: startYear, month: startMonth } = sastParts(startDate)
            const premiumSchedule = Array.from({ length: termMonths }, (_, i) => {
              const dueDate = sastMonthStart(startYear, startMonth + i + 1)
              return {
                tenantId: tenant.id,
                policyId: created.id,
                amount: premiumAmount,
                dueDate,
                status: "DUE" as const,
              }
            })

            await tx.premiumPayment.createMany({ data: premiumSchedule })

            // ── Task 6: AdvisorCommission on bind ─────────────────────────────────
            if (body.advisorId && productCommissionRate > 0) {
              // SAST accrual period. Built from LOCAL parts this pushed a
              // commission bound between 00:00 and 02:00 SAST on the 1st into
              // the PREVIOUS month's statement — a payable in the wrong period.
              const { year, month } = sastParts(new Date())
              const period = `${year}-${String(month + 1).padStart(2, "0")}`
              const commissionAmountForAdvisor = parseFloat((premiumAmount * productCommissionRate).toFixed(2))

              try {
                await tx.advisorCommission.create({
                  data: {
                    tenantId: tenant.id,
                    advisorId: String(body.advisorId),
                    policyId: created.id,
                    period,
                    amount: commissionAmountForAdvisor,
                    rate: productCommissionRate,
                    premiumBase: premiumAmount,
                    status: "PENDING",
                  },
                })
              } catch {
                // Unique constraint: commission already exists for this period — skip silently
              }
            }

            return created
          })
          break
        } catch (err) {
          const target =
            err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && Array.isArray(err.meta?.target)
              ? (err.meta.target as string[])
              : null

          // R-09: token-hash collision is the racy form of the replay check
          // above (TOCTOU between findUnique and create). Surface it the same
          // way as the pre-check path: 422 + audit + bail. Do NOT retry.
          if (target?.includes("faisDraftTokenHash")) {
            await logAudit({
              tenantId: tenant.id,
              userId: guard.user?.id,
              userEmail: guard.user?.email,
              action: AuditAction.INSURANCE_FAIS_GATE_REJECTED,
              entity: "InsurancePolicy",
              newValue: { reason: "token_replay", advisorId: body.advisorId ?? null },
            })
            return NextResponse.json(
              { error: "This FAIS disclosure token has already been used to bind a policy. Issue a fresh disclosure." },
              { status: 422 }
            )
          }

          if (!target?.includes("policyNumber")) {
            throw err
          }
          // policyNumber collision — fall through to the next attempt, or
          // exit the loop with `policy` still undefined on the final attempt
          // so the 409 path below handles it.
        }
      }

      if (!policy) {
        return NextResponse.json(
          { error: "Could not assign a unique policy number, please retry" },
          { status: 409 }
        )
      }

      // Task 8: Audit successful FAIS disclosure acknowledgement
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_FAIS_DISCLOSURE_ACKNOWLEDGED,
        entity: "InsurancePolicy",
        entityId: policy.id,
        newValue: {
          advisorId: body.advisorId ?? null,
          clientId: client.id,
          faisDisclosureAt: serverFaisDisclosureAt.toISOString(),
          faisDisclosurePdfUrl,
        },
      })

      return NextResponse.json({ success: true, policyNumber: policy.policyNumber })
    })
  } catch (error) {
    console.error("Policy creation error:", error)
    return NextResponse.json({ error: "Failed to create policy" }, { status: 500 })
  }
}
