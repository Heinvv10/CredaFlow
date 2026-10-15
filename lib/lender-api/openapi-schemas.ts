/**
 * OpenAPI 3.1 component schemas for /api/v1: the shapes of
 * lib/lender-api/serializers.ts. lib/lender-api/openapi.test.ts checks every
 * serializer's keys against these properties.
 */
const str = { type: "string" }
const nullableStr = { type: ["string", "null"] }
const dateTime = { type: "string", format: "date-time" }
const nullableDateTime = { type: ["string", "null"], format: "date-time" }
const int = { type: "integer" }
const cents = { type: "integer", description: "Amount in cents (ZAR)." }

const obj = (properties: Record<string, unknown>, optional: string[] = []) => ({
  type: "object",
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  additionalProperties: false,
})

export const schemas = {
  Error: obj({
    error: obj({ code: str, message: str, details: {} }, ["details"]),
  }),
  Client: obj({
    id: str, reference: str, firstName: str, lastName: str,
    idNumberMasked: { type: "string", description: "The ID number with all but the last four characters masked." },
    kycStatus: str, createdAt: dateTime,
    idNumber: { type: "string", description: "Only with the pii:read scope." },
    email: { type: "string", description: "Only with the pii:read scope." },
    phone: { type: "string", description: "Only with the pii:read scope." },
    dateOfBirth: { ...nullableDateTime, description: "Only with the pii:read scope." },
  }, ["idNumber", "email", "phone", "dateOfBirth"]),
  Application: obj({
    id: str, reference: str, clientId: nullableStr, entityId: nullableStr, productId: str,
    status: { type: "string", enum: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "DECLINED", "DISBURSED", "CANCELLED"] },
    appliedAmountCents: cents, appliedTermDays: int, purpose: { ...nullableStr, description: "Only with the pii:read scope (free text)." },
    submittedAt: nullableDateTime, approvedAt: nullableDateTime, disbursedAt: nullableDateTime,
    createdAt: dateTime, updatedAt: dateTime,
  }, ["purpose"]),
  CreateApplication: obj({
    clientId: str, productId: str, appliedAmountCents: cents, appliedTermDays: int,
    purpose: { type: "string", maxLength: 500 },
    loanPurposeCategory: {
      type: ["string", "null"],
      enum: ["DEBT_CONSOLIDATION", "MEDICAL", "EDUCATION", "HOME_IMPROVEMENT", "VEHICLE", "BUSINESS", "HOUSEHOLD", "FUNERAL", "OTHER", null],
    },
  }, ["loanPurposeCategory"]),
  Loan: obj({
    id: str, reference: str, applicationId: str, clientId: nullableStr, entityId: nullableStr, productId: str,
    contractType: str,
    status: { type: "string", enum: ["ACTIVE", "COMPLETED", "DEFAULTED", "PENDING_WRITE_OFF", "WRITTEN_OFF", "RESTRUCTURED", "CANCELLED"] },
    principalCents: cents, totalInterestCents: cents, initiationFeeCents: cents, totalRepayableCents: cents,
    outstandingPrincipalCents: cents, totalPaidCents: cents, arrearsAmountCents: cents, daysInArrears: int,
    interestRatePerMonth: { type: "number" }, interestModel: str,
    startDate: dateTime, maturityDate: dateTime, nextPaymentDate: nullableDateTime, closedAt: nullableDateTime,
    createdAt: dateTime,
  }),
  ScheduleItem: obj({
    id: str, installmentNo: int, dueDate: dateTime, principalDueCents: cents, interestDueCents: cents,
    feesDueCents: cents, creditLifePremiumDueCents: cents, totalDueCents: cents, totalPaidCents: cents,
    status: { type: "string", enum: ["PENDING", "PARTIAL", "PAID", "OVERDUE", "WRITTEN_OFF"] },
    paidAt: nullableDateTime,
  }),
  Payment: obj({
    id: str, loanId: str, amountCents: cents, paymentMethod: str,
    reference: { ...nullableStr, description: "Only with the pii:read scope (free text)." },
    allocationStatus: str, receivedAt: dateTime, reversed: { type: "boolean" }, reversedAt: nullableDateTime,
    createdAt: dateTime,
  }, ["reference"]),
  WebhookEvent: obj({
    id: { type: "string", description: "Stable per event: dedupe on it (delivery is at-least-once)." },
    type: { type: "string", enum: ["application.created", "application.status_changed", "loan.disbursed", "payment.received"] },
    createdAt: dateTime,
    data: { type: "object", description: "The changed object's id and the fields that describe the change; no personal data." },
  }),
} as const

export function listOf(ref: string) {
  return obj({
    data: { type: "array", items: { $ref: `#/components/schemas/${ref}` } },
    nextCursor: { ...nullableStr, description: "Pass as ?cursor= for the next page; null on the last page." },
  })
}
