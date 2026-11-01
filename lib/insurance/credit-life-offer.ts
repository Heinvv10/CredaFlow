import type { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { creditLifeOfferableUnder } from "@/lib/non-nca-documents/regime-evidence"

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

/**
 * The credit-life offer for an application, or null. Every read that decides what a client is offered comes through here,
 * so a screen and the server it posts to cannot disagree: outside the NCA's regime there is none, whatever rows exist.
 * `regime`: the application's stamped regime; absent for one not created yet.
 */
export async function loadCreditLifeOffer(
  db: Pick<typeof prisma, "insuranceProduct">,
  tenantId: string,
  regime?: string | null,
) {
  if (!creditLifeOfferableUnder(regime)) return null
  return db.insuranceProduct.findFirst(creditLifeOfferFindFirstArgs(tenantId))
}
