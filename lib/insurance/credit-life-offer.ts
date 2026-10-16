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
      // The bundled-policy guard refuses a sale against a product without
      // positive configured terms, so such a product is never offered.
      premiumAmount: { gt: 0 },
      sumAssured: { gt: 0 },
      insurer: {
        is: {
          tenantId,
          active: true,
          name: { not: "" },
        },
      },
      // A lender with no FSP number issues no insurance, so it offers no cover
      // (Fair Score audit goal §2a.2). The identity writer stores a cleared
      // number as null; "" is excluded as well.
      tenant: { config: { is: { AND: [{ fscaNumber: { not: null } }, { NOT: { fscaNumber: "" } }] } } },
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
