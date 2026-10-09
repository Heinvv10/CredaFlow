import type { Prisma } from "@prisma/client"

export function creditLifeOfferFindFirstArgs(tenantId: string) {
  return {
    where: {
      tenantId,
      type: "CREDIT_LIFE",
      active: true,
      insurerId: { not: null },
      // The DB approval guard's EXISTS ignores blank-named rows. This lookup is
      // ORDERED and returns one row, so without the same exclusion the oldest
      // blank-named product hides a valid younger one and the two disagree
      // about whether cover is on offer. Prisma cannot express BTRIM here, so
      // whitespace-only names still need the caller's trim check.
      name: { not: "" },
      insurer: {
        is: {
          tenantId,
          active: true,
          name: { not: "" },
        },
      },
    },
    orderBy: [
      { createdAt: "asc" },
      { id: "asc" },
    ],
    select: {
      id: true,
      name: true,
      insurerId: true,
      insurer: { select: { name: true } },
    },
  } satisfies Prisma.InsuranceProductFindFirstArgs
}
