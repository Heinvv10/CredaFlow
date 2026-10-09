import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { generateReference } from "@/lib/utils"
import { logAudit, AuditAction } from "@/lib/audit"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { validateAllClient } from "@/lib/validation/client-wizard"
import type {
  ClientWizardData,
  DebtObligationInput,
  ExpenseBreakdownInputs,
} from "@/components/clients/wizard/types"
import { EMPTY_EXPENSE_BREAKDOWN } from "@/components/clients/wizard/types"
import { sumExpenseBreakdown } from "@/lib/affordability/sum-expense-breakdown"
import { syncClientConsent } from "@/lib/consent"
import { provisionContactForClient } from "@/lib/contact/provision"
import {
  uniqueConflictField,
  conflictMessage,
  isContactIdentityConflict,
  findChannelHolder,
  channelConflictMessage,
} from "@/lib/clients/duplicate"

function toCents(v: unknown): number {
  if (v == null) return 0
  const s = String(v).trim()
  if (!s || !/^\d+(\.\d{1,2})?$/.test(s)) return 0
  return Math.round(parseFloat(s) * 100)
}

export async function POST(req: NextRequest) {
  try {
    const guard = await requireApiRole("CREDIT_OFFICER")
    if (guard.error) return guard.error

    // `await` is load-bearing: returning the promise unawaited leaves the
    // catch below dead, so a throw inside this callback escaped to Next and
    // came back as a 500 with an empty body. The caller does res.json() on
    // the error path, which then failed with "Unexpected end of JSON input"
    // and hid the real cause from the operator.
    return await withTenantContext(req, async (tenant) => {
      const data = await req.json()

      // Wizard submissions carry money as Rand strings. Normalise to cents
      // (Int) before validation and persistence. The legacy POST path that
      // sent cents is gone (edit-only uses PUT), so every caller here is
      // expected to be the wizard.
      const monthlyIncomeCents = data.monthlyIncome
        ? Math.round(parseFloat(String(data.monthlyIncome)) * 100)
        : 0
      const grossMonthlyIncomeCents = data.grossMonthlyIncome
        ? Math.round(parseFloat(String(data.grossMonthlyIncome)) * 100)
        : null

      const rawBreakdown = (data.expenseBreakdown ?? {}) as Partial<ExpenseBreakdownInputs>
      const expenseBreakdownInputs: ExpenseBreakdownInputs = {
        ...EMPTY_EXPENSE_BREAKDOWN,
        ...Object.fromEntries(
          Object.entries(rawBreakdown).map(([k, v]) => [k, v == null ? "" : String(v)]),
        ),
      }
      const breakdownCents = {
        housing: toCents(expenseBreakdownInputs.housing),
        transport: toCents(expenseBreakdownInputs.transport),
        food: toCents(expenseBreakdownInputs.food),
        education: toCents(expenseBreakdownInputs.education),
        insurance: toCents(expenseBreakdownInputs.insurance),
        clothing: toCents(expenseBreakdownInputs.clothing),
        entertainment: toCents(expenseBreakdownInputs.entertainment),
        medical: toCents(expenseBreakdownInputs.medical),
        other: toCents(expenseBreakdownInputs.other),
      }
      const monthlyExpensesCents = sumExpenseBreakdown(breakdownCents)

      const debtObligationsRaw: DebtObligationInput[] = Array.isArray(data.debtObligations)
        ? data.debtObligations.map((row: Record<string, unknown>, i: number) => ({
            // rowKey is wizard-local; API never reads it, but the validator
            // expects the field to be present on the type. Synthesise a stable
            // value from the index so validator errors map predictably.
            rowKey: typeof row?.rowKey === "string" ? row.rowKey : `srv-${i}`,
            creditProvider: String(row?.creditProvider ?? ""),
            accountType: String(row?.accountType ?? "OTHER"),
            outstandingBalance: row?.outstandingBalance == null ? "" : String(row.outstandingBalance),
            monthlyInstalment: row?.monthlyInstalment == null ? "" : String(row.monthlyInstalment),
            notes: String(row?.notes ?? ""),
          }))
        : []

      const validationPayload: ClientWizardData = {
        firstName: data.firstName ?? "",
        lastName: data.lastName ?? "",
        idNumber: data.idNumber ?? "",
        dateOfBirth: data.dateOfBirth ?? "",
        gender: data.gender ?? "",
        email: data.email ?? "",
        phone: data.phone ?? "",
        whatsapp: data.whatsapp ?? "",
        addressLine1: data.addressLine1 ?? "",
        suburb: data.suburb ?? "",
        city: data.city ?? "",
        province: data.province ?? "",
        postalCode: data.postalCode ?? "",
        employmentStatus: data.employmentStatus ?? "",
        incomeSourceType: data.incomeSourceType ?? "",
        employerName: data.employerName ?? "",
        employerAddress: data.employerAddress ?? "",
        employmentStartDate: data.employmentStartDate ?? "",
        salaryPaymentDay: data.salaryPaymentDay != null ? String(data.salaryPaymentDay) : "",
        monthlyIncome: data.monthlyIncome != null ? String(data.monthlyIncome) : "",
        grossMonthlyIncome: data.grossMonthlyIncome != null ? String(data.grossMonthlyIncome) : "",
        // Cached scalar — kept on Client for the 6+ downstream readers (M7 NDI
        // calc, portal display, qualify pre-check, reports). The wizard
        // doesn't surface this field; it's derived from `expenseBreakdown`.
        monthlyExpenses: String(monthlyExpensesCents / 100),
        expenseBreakdown: expenseBreakdownInputs,
        debtObligations: debtObligationsRaw,
        bankName: data.bankName ?? "",
        bankAccountNumber: data.bankAccountNumber ?? "",
        bankBranchCode: data.bankBranchCode ?? "",
        accountType: data.accountType ?? "",
        nextOfKinName: data.nextOfKinName ?? "",
        nextOfKinPhone: data.nextOfKinPhone ?? "",
        nextOfKinRelationship: data.nextOfKinRelationship ?? "",
        popiaConsentGiven: data.popiaConsentGiven === true,
      }

      const validationErrors = validateAllClient(validationPayload)
      if (Object.keys(validationErrors).length > 0) {
        return NextResponse.json(
          { error: "Validation failed", errors: validationErrors },
          { status: 400 },
        )
      }

      // Structured persistence: a single ClientExpenseBreakdown row + zero
      // or more ExistingDebtObligation rows. Replaces the prior synthetic-row
      // stopgap (creditProvider = "Pending detail breakdown — …").
      const breakdownCreate = {
        ...breakdownCents,
        belowMleJustification:
          expenseBreakdownInputs.belowMleJustification.trim() || null,
      }
      const debtRowsCreate = debtObligationsRaw
        .filter((d) => d.creditProvider.trim() !== "")
        .map((d) => ({
          creditProvider: d.creditProvider,
          accountType: d.accountType || "OTHER",
          outstandingBalance: toCents(d.outstandingBalance),
          monthlyInstalment: toCents(d.monthlyInstalment),
          notes: d.notes.trim() || null,
        }))

      // Wrap Client + granular ClientConsent in one transaction so a partial
      // failure cannot leave a client with umbrella consent on the Client
      // row but no granular ClientConsent row — that state would let bureau
      // enquiry proceed on the umbrella-fallback while the schema invariant
      // (granular row is authoritative) is silently violated.
      let client
      try {
        client = await prisma.$transaction(async (tx) => {
        const created = await tx.client.create({
          data: {
            tenantId: tenant.id,
            reference: generateReference("CLI"),
            firstName: data.firstName,
            lastName: data.lastName,
            idNumber: data.idNumber,
            dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null,
            gender: data.gender,
            email: data.email,
            phone: data.phone,
            whatsapp: data.whatsapp,
            addressLine1: data.addressLine1 || null,
            suburb: data.suburb,
            city: data.city,
            province: data.province,
            postalCode: data.postalCode,
            employmentStatus: data.employmentStatus,
            employerName: data.employerName,
            employerAddress: data.employerAddress,
            grossMonthlyIncome: grossMonthlyIncomeCents,
            monthlyIncome: monthlyIncomeCents,
            monthlyExpenses: monthlyExpensesCents,
            incomeSourceType: data.incomeSourceType,
            employmentStartDate: data.employmentStartDate ? new Date(data.employmentStartDate) : null,
            salaryPaymentDay: data.salaryPaymentDay ? Number(data.salaryPaymentDay) : null,
            bankName: data.bankName,
            bankAccountNumber: data.bankAccountNumber,
            bankBranchCode: data.bankBranchCode,
            accountType: data.accountType,
            nextOfKinName: data.nextOfKinName,
            nextOfKinPhone: data.nextOfKinPhone,
            nextOfKinRelationship: data.nextOfKinRelationship,
            popiaConsentGiven: data.popiaConsentGiven === true,
            popiaConsentAt: data.popiaConsentGiven === true ? new Date() : null,
            expenseBreakdown: { create: breakdownCreate },
            ...(debtRowsCreate.length > 0 && {
              debtObligations: { create: debtRowsCreate },
            }),
          },
        })

        await syncClientConsent(tx, {
          clientId: created.id,
          popiaConsentGiven: data.popiaConsentGiven === true,
          capturedBy: guard.user.id,
        })

        // Provision Contact + ContactIdentity for the new client so the new-send
        // messaging path (lib/messaging/send.ts) can route transactional notifs
        // by channel-keyed lookup. Idempotent; in-tx so Client + Contact land
        // atomically.
        await provisionContactForClient(tx, {
          tenantId: tenant.id,
          clientId: created.id,
          firstName: created.firstName,
          lastName: created.lastName,
          email: created.email,
          phone: created.phone,
          whatsapp: created.whatsapp,
        })

        return created
        })
      } catch (error) {
        // A unique-constraint violation here is not a fault — it means this
        // person is already on the books. Anything else still escapes to the
        // 500 below, so a real database failure is never disguised as a
        // duplicate.
        const field = uniqueConflictField(error)
        if (!field) throw error

        // The phone/email/WhatsApp is already another contact's — say whose.
        if (isContactIdentityConflict(error)) {
          const holder = await findChannelHolder(prisma, tenant.id, data)
          if (holder) {
            const holderClient = holder.contact.clientId
              ? await prisma.client.findFirst({
                  where: { tenantId: tenant.id, id: holder.contact.clientId },
                  select: { id: true, reference: true, firstName: true, lastName: true },
                })
              : null
            return NextResponse.json(
              {
                error: channelConflictMessage(holder.field, holderClient, holder.contact.leadId !== null),
                field: holder.field,
                existingClient: holderClient,
              },
              { status: 409 },
            )
          }
          // Holder not found: still a duplicate, but its target is
          // ["tenantId", ...] — don't hand that column name to the UI.
          return NextResponse.json(
            { error: conflictMessage(""), field: null, existingClient: null },
            { status: 409 },
          )
        }

        // Scoped to the caller's tenant on purpose. idNumber and email are
        // GLOBALLY unique, so the row that blocked this insert may belong to
        // another tenant — in which case the constraint is real but the client
        // is not ours to name, and returning identity would be a cross-tenant
        // leak. Today there is one tenant and that branch is unreachable; the
        // day there are two it must already be right.
        const existing =
          field === "idNumber"
            ? await prisma.client.findFirst({
                where: { tenantId: tenant.id, idNumber: data.idNumber },
                select: { id: true, reference: true, firstName: true, lastName: true },
              })
            : field === "email"
              ? await prisma.client.findFirst({
                  where: { tenantId: tenant.id, email: data.email },
                  select: { id: true, reference: true, firstName: true, lastName: true },
                })
              : null

        return NextResponse.json(
          { error: conflictMessage(field), field, existingClient: existing },
          { status: 409 }
        )
      }

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.CLIENT_CREATED,
        entity: "Client",
        entityId: client.id,
        newValue: { reference: client.reference, name: `${client.firstName} ${client.lastName}` },
      })

      return NextResponse.json(client)
    })
  } catch (error) {
    console.error("Failed to create client:", error)
    return NextResponse.json(
      { error: "Failed to create client" },
      { status: 500 }
    )
  }
}
