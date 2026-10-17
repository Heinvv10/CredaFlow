import type { Prisma } from "@prisma/client"

/** Booked legacy applications are servicing records, even if their stored stage is DRAFT. */
export const UNBOOKED_PIPELINE_FILTER = {
  status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"] },
  loan: null,
} satisfies Prisma.LoanApplicationWhereInput
