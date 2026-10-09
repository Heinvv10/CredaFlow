import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { InsuredLifeType, QuoteStatus } from "@prisma/client"
import type { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"
import { createQuote, type QuoteLifeRequest } from "@/lib/insurance/quote/create"
import { parseInsuranceDateInput, parseInsuranceExpiryInput } from "@/lib/insurance/parse-date-input"
import { readJsonObject } from "../request-body"
import { deriveDobFromSaId, isValidSaIdNumber } from "@/lib/validation/client-wizard"

const LIFE_TYPES = Object.values(InsuredLifeType) as string[]
const QUOTE_STATUSES = Object.values(QuoteStatus) as string[]

/**
 * How long a quote stays valid when the caller does not say.
 *
 * 30 days: long enough for a client to consider a funeral policy and come
 * back, short enough that the rate card it was priced against is still the one
 * in force. The bind does not re-rate, so this figure IS the window in which a
 * stale price can be sold.
 */
const QUOTE_VALIDITY_DAYS = 30
/** The longest a caller may set. Beyond this, an expiry is a null in disguise. */
const MAX_QUOTE_VALIDITY_DAYS = 365

export async function GET(req: NextRequest) {
  try {
    const guard = await requireApiRole("READONLY")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const clientId = req.nextUrl.searchParams.get("clientId")
      const status = req.nextUrl.searchParams.get("status")

      // Validated rather than cast. `status as never` sent any query string
      // straight to Prisma, which rejects an unknown enum value with a throw —
      // so a typo in a filter was a 500 rather than the 422 it plainly is.
      if (status !== null && !QUOTE_STATUSES.includes(status)) {
        return NextResponse.json(
          { error: `status must be one of ${QUOTE_STATUSES.join(", ")}` },
          { status: 422 }
        )
      }

      const quotes = await prisma.insuranceQuote.findMany({
        where: {
          tenantId: tenant.id,
          ...(clientId ? { clientId } : {}),
          ...(status ? { status: status as QuoteStatus } : {}),
        },
        orderBy: { createdAt: "desc" },
        include: {
          _count: { select: { lives: true } },
          adviceRecord: { select: { id: true, recordedAt: true } },
        },
      })

      return NextResponse.json(quotes)
    })
  } catch (error) {
    // Logged, like every write handler in this file. A 500 on a read that
    // leaves no trace means an operator reports a broken screen and there is
    // nothing to diagnose it with.
    console.error("Failed to fetch quotes:", error)
    return NextResponse.json({ error: "Failed to fetch quotes" }, { status: 500 })
  }
}

/**
 * Parse one life from the request body.
 *
 * Every field is checked here rather than left to Prisma, because a life that
 * reaches the database malformed becomes a covered person with a broken
 * identity — and `InsuredLife.idNumber` is the only handle a POPIA
 * subject-access request has on these rows.
 */
function parseLife(raw: unknown, index: number): { ok: true; life: QuoteLifeRequest } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `lives[${index}] must be an object` }
  }
  const life = raw as Record<string, unknown>

  const firstName = typeof life.firstName === "string" ? life.firstName.trim() : ""
  const lastName = typeof life.lastName === "string" ? life.lastName.trim() : ""
  const relationship = typeof life.relationship === "string" ? life.relationship.trim() : ""
  if (!firstName || !lastName || !relationship) {
    return { ok: false, error: `lives[${index}] requires firstName, lastName and relationship` }
  }

  const lifeType = typeof life.lifeType === "string" ? life.lifeType : ""
  if (!LIFE_TYPES.includes(lifeType)) {
    return { ok: false, error: `lives[${index}].lifeType must be one of ${LIFE_TYPES.join(", ")}` }
  }

  const dateOfBirth = new Date(String(life.dateOfBirth))
  if (Number.isNaN(dateOfBirth.getTime())) {
    return { ok: false, error: `lives[${index}].dateOfBirth is not a valid date` }
  }

  if (typeof life.sumAssured !== "number" && typeof life.sumAssured !== "string") {
    return { ok: false, error: `lives[${index}].sumAssured is required` }
  }

  return {
    ok: true,
    life: {
      ref: typeof life.ref === "string" && life.ref.trim() ? life.ref.trim() : `life-${index + 1}`,
      // Nullable by design: a spouse or child covered by a funeral quote is
      // usually not a Client, and inventing one would pollute the live
      // duplicate-ID and returning-applicant identity logic.
      clientId: typeof life.clientId === "string" && life.clientId ? life.clientId : null,
      firstName,
      lastName,
      idNumber: typeof life.idNumber === "string" && life.idNumber.trim() ? life.idNumber.trim() : null,
      dateOfBirth,
      relationship,
      lifeType: lifeType as InsuredLifeType,
      sumAssured: life.sumAssured,
    },
  }
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const parsedBody = await readJsonObject(req)
      if (!parsedBody.ok) {
        return NextResponse.json({ error: parsedBody.error }, { status: 422 })
      }
      const body = parsedBody.body

      const clientId = typeof body.clientId === "string" ? body.clientId : null
      const productId = typeof body.productId === "string" ? body.productId : null
      if (!clientId || !productId) {
        return NextResponse.json({ error: "clientId and productId are required" }, { status: 422 })
      }

      if (!Array.isArray(body.lives) || body.lives.length === 0) {
        return NextResponse.json({ error: "lives must be a non-empty array" }, { status: 422 })
      }

      const lives: QuoteLifeRequest[] = []
      for (const [index, raw] of body.lives.entries()) {
        const parsed = parseLife(raw, index)
        if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 422 })
        lives.push(parsed.life)
      }

      // A date-only `effectiveDate` naming today resolves to now, not to
      // midnight — otherwise a rate card activated this morning cannot be
      // quoted against today. See `parseInsuranceDateInput`.
      const effectiveDate = body.effectiveDate
        ? parseInsuranceDateInput(String(body.effectiveDate))
        : new Date()
      if (effectiveDate === null) {
        return NextResponse.json({ error: "effectiveDate is not a valid date" }, { status: 422 })
      }

      // EXPIRY IS PROVISIONED, NOT VOLUNTEERED.
      //
      // A null default would leave BOTH guards that enforce it — at
      // disclosure and at bind — written `expiresAt !== null && ...`. So
      // omitting one field would arm nothing: the quote stayed disclosable and
      // bindable for ever, at a price its rate card produced on the day it was
      // written. The bind deliberately does not re-rate, so a card retired
      // eighteen months ago would still have sold at its old premium.
      //
      // Enforcing without provisioning is not enough —
      // it arms the guard only for quotes whose author volunteers the field.
      //
      // A bare date here is an END boundary, so it means the last day the quote
      // is valid — `parseInsuranceExpiryInput`, NOT the sibling helper used for
      // `effectiveDate`. That one resolves a bare date to the first instant of
      // the day, which for an expiry kills the quote before the day it names
      // has begun.
      const expiresAt = body.expiresAt
        ? parseInsuranceExpiryInput(String(body.expiresAt))
        : new Date(effectiveDate.getTime() + QUOTE_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
      if (expiresAt === null) {
        return NextResponse.json({ error: "expiresAt is not a valid date" }, { status: 422 })
      }
      // A quote that is already expired when created is not a quote.
      if (expiresAt <= effectiveDate) {
        return NextResponse.json(
          { error: "expiresAt must be after the quote's effective date" },
          { status: 422 }
        )
      }
      // And an absurd horizon is the same defect wearing a value: a quote valid
      // for a decade is a null expiry with extra steps.
      const maxExpiry = new Date(effectiveDate.getTime() + MAX_QUOTE_VALIDITY_DAYS * 24 * 60 * 60 * 1000)
      if (expiresAt > maxExpiry) {
        return NextResponse.json(
          { error: `expiresAt may be at most ${MAX_QUOTE_VALIDITY_DAYS} days after the effective date` },
          { status: 422 }
        )
      }

      // Tenant-scoped lookups: another tenant's client or product is a 404,
      // never a 403 that would confirm the id exists.
      const [client, product] = await Promise.all([
        prisma.client.findFirst({ where: { id: clientId, tenantId: tenant.id }, select: { id: true } }),
        prisma.insuranceProduct.findFirst({ where: { id: productId, tenantId: tenant.id }, select: { id: true } }),
      ])
      if (!client) return NextResponse.json({ error: "Client not found" }, { status: 404 })
      if (!product) return NextResponse.json({ error: "Insurance product not found" }, { status: 404 })

      // A covered life that claims to BE an existing client must be one of THIS
      // tenant's clients.
      //
      // `parseLife` only checks that `lives[].clientId` is a non-empty string —
      // that is a shape check, not an authorisation check. `InsuredLife` has no
      // `tenantId` of its own and is scoped through its parent quote, and the
      // `Client` FK carries no tenant constraint at the DB level, so the
      // tenant-scoped check on the QUOTE's client above proves nothing about
      // the lives'. Without this, an officer at tenant A could attach tenant
      // B's client id to a covered life: the row would persist, survive to
      // ACTIVE on a bound policy, and stand as a false record linking a real
      // person to a policy they never agreed to — a POPIA data-integrity
      // defect, and a live landmine for the first read path that joins
      // InsuredLife.client back to Client.
      //
      // One query over the DISTINCT ids, compared as a set, so every life is
      // validated rather than the first — a loop that returned early on the
      // first hit would leave later lives unchecked.
      const lifeClientIds = [...new Set(
        lives.map((life) => life.clientId).filter((id): id is string => typeof id === "string")
      )]
      // dateOfBirth is selected as well as id: see the B3 block below, where a
      // covered life that IS a client takes its DOB from this row rather than
      // from the request.
      const knownById = new Map<string, { id: string; dateOfBirth: Date | null }>()
      if (lifeClientIds.length > 0) {
        const known = await prisma.client.findMany({
          where: { id: { in: lifeClientIds }, tenantId: tenant.id },
          select: { id: true, dateOfBirth: true },
        })
        for (const row of known) knownById.set(row.id, row)
        const knownIds = new Set(known.map((row) => row.id))
        const unknown = lifeClientIds.filter((id) => !knownIds.has(id))
        if (unknown.length > 0) {
          // 404, not 403, matching the lookups above: a tenant-scoped miss must
          // not confirm that the id exists somewhere else.
          const refs = lives.filter((life) => life.clientId && unknown.includes(life.clientId)).map((life) => life.ref)
          return NextResponse.json(
            { error: `Client not found for covered life ${refs.join(", ")}` },
            { status: 404 }
          )
        }
      }

      // B3 — a date of birth is EVIDENCE, not a caller assertion.
      //
      // `parseLife` only checks the DOB parses. Age is the primary rating axis
      // on an age-banded card, so an unverified DOB is a price the client
      // chooses: quote a 78-year-old as born in 1985 and they land in a cheap
      // band, clear MAX_ENTRY_AGE, bind, and the InsuredLife row carries the
      // false date as the policy record of who is covered.
      //
      // Two sources of truth are used where they exist, in order:
      //
      //   1. The linked Client row. If a life claims to BE a client, that
      //      client's stored DOB wins outright — the draft path already reads
      //      `client.dateOfBirth` from the database, and having the two paths
      //      disagree about whether a DOB is trusted input is the actual defect.
      //   2. The SA ID number's YYMMDD prefix, which covers the majority of
      //      lives — a spouse, child or parent who is not a Client at all and
      //      for whom this is the only verification available.
      //
      // `deriveDobFromSaId` from lib/validation/client-wizard.ts is used rather
      // than the one in lib/integrations/experian-input.ts: that one resolves
      // the century by assuming an adult aged 18-100, which is wrong for every
      // CHILD life a funeral quote covers.
      // WHERE NEITHER IS AVAILABLE, THE DOB IS SIMPLY UNVERIFIED. A life with
      // no `clientId` and no `idNumber` — a child too young to have been issued
      // one, say — is priced on the age the caller stated, and nothing here
      // pretends otherwise. Saying so plainly matters more than it looks: the
      // next reader must not infer from the presence of this block that every
      // life's age has been checked.
      for (const life of lives) {
        if (life.clientId) {
          const known = knownById.get(life.clientId)
          if (!known?.dateOfBirth) {
            return NextResponse.json(
              { error: `Covered life ${life.ref} is linked to a client with no date of birth on record, so their age cannot be verified` },
              { status: 422 }
            )
          }
          life.dateOfBirth = known.dateOfBirth
        }

        if (life.idNumber) {
          if (!isValidSaIdNumber(life.idNumber)) {
            return NextResponse.json(
              { error: `Covered life ${life.ref} has an invalid SA ID number` },
              { status: 422 }
            )
          }
          const fromId = deriveDobFromSaId(life.idNumber)
          if (fromId && fromId !== life.dateOfBirth.toISOString().slice(0, 10)) {
            return NextResponse.json(
              { error: `Covered life ${life.ref}: date of birth ${life.dateOfBirth.toISOString().slice(0, 10)} does not match the ID number, which encodes ${fromId}` },
              { status: 422 }
            )
          }
        }
      }

      // `prisma` is a $extends client; its generic delegate signatures are not
      // assignable to the plain `PrismaClient` delegates the quote store is
      // typed against. Runtime shape is identical — this is a variance cast
      // only, and the same one app/(dashboard)/settings/insurance/page.tsx makes.
      const quoteStore = prisma as unknown as PrismaClient

      const result = await createQuote(quoteStore, {
        tenantId: tenant.id,
        clientId,
        productId,
        advisorId: guard.user?.id ?? null,
        effectiveDate,
        expiresAt,
        lives,
      })

      // A malformed request never became a quote, so there is nothing to audit
      // and nothing to return but the reason.
      if (result.quoteId === null) {
        return NextResponse.json({ error: result.detail }, { status: 422 })
      }

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        // A quote that could not be priced or screened is audited under its own
        // action, carrying the failures — that row is the evidence of what the
        // insurer's configuration refused.
        action: result.ok ? AuditAction.INSURANCE_QUOTE_CREATED : AuditAction.INSURANCE_QUOTE_DRAFTED,
        entity: "InsuranceQuote",
        entityId: result.quoteId,
        newValue: {
          quoteNumber: result.quoteNumber,
          status: result.status,
          reason: result.reason,
          rateTableId: result.rateTableId,
          totalPremium: result.totalPremium,
          totalSumAssured: result.totalSumAssured,
          eligibility: result.eligibility,
          ratingFailures: result.ratingFailures,
        },
      })

      // 201 either way: the quote WAS created. A DRAFT that could not be priced
      // is a real persisted record the operator has to act on, not a failed
      // request — returning 4xx would tell the caller nothing was written when
      // something was.
      return NextResponse.json(
        {
          id: result.quoteId,
          quoteNumber: result.quoteNumber,
          status: result.status,
          sellable: result.ok,
          reason: result.reason,
          totalPremium: result.totalPremium,
          totalSumAssured: result.totalSumAssured,
          rateTableId: result.rateTableId,
          eligibility: result.eligibility,
          ratingFailures: result.ratingFailures,
        },
        { status: 201 }
      )
    })
  } catch (error) {
    console.error("Failed to create insurance quote:", error)
    return NextResponse.json({ error: "Failed to create quote" }, { status: 500 })
  }
}
