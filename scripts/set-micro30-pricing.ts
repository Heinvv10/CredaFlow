/**
 * Tenant-gated MICRO30 product change.
 *
 * Dry-run is the default. Apply requires an explicit tenant, approver and
 * change-ticket reference. The write is blocked while any application can
 * still depend on the previous mutable product configuration.
 *
 * Preview:
 *   npx tsx scripts/set-micro30-pricing.ts --tenant-id <tenant-id>
 *
 * Apply after owner approval:
 *   npx tsx scripts/set-micro30-pricing.ts --tenant-id <tenant-id> --apply \
 *     --approved-by owner@example.test --change-ticket STAGING-123
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { runWithTenant } from "@/lib/tenant-scope"
import {
  MICRO30_APPROVED_CONTRACT,
  MICRO30_CODE,
  MICRO30_PROTECTED_APPLICATION_STATUSES,
  micro30ContractIssues,
} from "@/lib/product-config/micro30"

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : null
  return value && !value.startsWith("--") ? value.trim() : null
}

function productEvidence(product: {
  code: string
  name: string
  productType: string
  minAmount: number
  maxAmount: number
  minTermDays: number
  maxTermDays: number
  interestRatePm: number
  interestModel: string
  initiationFeeModel: string
  initiationFeePct: number
  initiationFeeMax: number
  monthlyServiceFee: number
  active: boolean
}) {
  return {
    code: product.code,
    name: product.name,
    productType: product.productType,
    minAmount: product.minAmount,
    maxAmount: product.maxAmount,
    minTermDays: product.minTermDays,
    maxTermDays: product.maxTermDays,
    interestRatePm: product.interestRatePm,
    interestModel: product.interestModel,
    initiationFeeModel: product.initiationFeeModel,
    initiationFeePct: product.initiationFeePct,
    initiationFeeMax: product.initiationFeeMax,
    monthlyServiceFee: product.monthlyServiceFee,
    active: product.active,
  }
}

async function main() {
  const tenantId = option("--tenant-id")
  const apply = process.argv.includes("--apply")
  const approvedBy = option("--approved-by")
  const changeTicket = option("--change-ticket")

  if (!tenantId) throw new Error("--tenant-id is required")
  if (apply && (!approvedBy || !changeTicket)) {
    throw new Error("--apply requires --approved-by and --change-ticket")
  }

  await runWithTenant(tenantId, async () => {
    const products = await prisma.loanProduct.findMany({
      where: {
        tenantId,
        code: { equals: MICRO30_CODE, mode: "insensitive" },
      },
    })
    if (products.length !== 1) {
      throw new Error(
        `Expected exactly one ${MICRO30_CODE} row for tenant ${tenantId}; found ${products.length}`,
      )
    }
    const product = products[0]
    const inFlight = await prisma.loanApplication.findMany({
      where: {
        tenantId,
        productId: product.id,
        status: { in: [...MICRO30_PROTECTED_APPLICATION_STATUSES] },
      },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        reference: true,
        status: true,
        agreementDocumentId: true,
        agreementSignedAt: true,
      },
    })
    const before = productEvidence(product)
    const after = {
      ...before,
      ...MICRO30_APPROVED_CONTRACT,
    }
    const preview = {
      mode: apply ? "apply" : "dry-run",
      tenantId,
      productId: product.id,
      before,
      after,
      currentlyApproved: micro30ContractIssues(before).length === 0,
      protectedApplicationStatuses: MICRO30_PROTECTED_APPLICATION_STATUSES,
      inFlightApplications: inFlight,
    }
    console.log(JSON.stringify(preview, null, 2))

    if (!apply || preview.currentlyApproved) return
    if (inFlight.length > 0) {
      throw new Error(
        `Refusing product change: ${inFlight.length} open application(s) depend on the current pricing`,
      )
    }

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT "id"
        FROM "LoanProduct"
        WHERE "id" = ${product.id}
          AND "tenantId" = ${tenantId}
        FOR UPDATE
      `)
      const current = await tx.loanProduct.findUnique({
        where: { id: product.id, tenantId },
      })
      if (!current) throw new Error("MICRO30 product disappeared during apply")
      if (current.code.trim().toUpperCase() !== MICRO30_CODE) {
        throw new Error("MICRO30 product code changed concurrently; rerun the preview")
      }
      const currentInFlight = await tx.loanApplication.count({
        where: {
          tenantId,
          productId: product.id,
          status: { in: [...MICRO30_PROTECTED_APPLICATION_STATUSES] },
        },
      })
      if (currentInFlight > 0) {
        throw new Error(
          `Refusing product change: ${currentInFlight} application(s) entered flight after preview`,
        )
      }
      if (micro30ContractIssues(current).length === 0) return

      const currentBefore = productEvidence(current)
      const changed = await tx.loanProduct.updateMany({
        where: {
          id: product.id,
          tenantId,
          code: current.code,
          productType: current.productType,
          minTermDays: current.minTermDays,
          maxTermDays: current.maxTermDays,
          interestRatePm: current.interestRatePm,
          interestModel: current.interestModel,
          monthlyServiceFee: current.monthlyServiceFee,
        },
        data: {
          ...MICRO30_APPROVED_CONTRACT,
        },
      })
      if (changed.count !== 1) {
        throw new Error("MICRO30 product changed concurrently; rerun the preview")
      }
      await tx.auditLog.create({
        data: {
          tenantId,
          userId: null,
          userEmail: approvedBy!,
          action: AuditAction.PRODUCT_PRICING_UPDATED,
          entity: "LoanProduct",
          entityId: product.id,
          oldValue: currentBefore,
          newValue: {
            ...currentBefore,
            ...MICRO30_APPROVED_CONTRACT,
            approvedBy,
            changeTicket,
            source: "scripts/set-micro30-pricing.ts",
          },
        },
      })
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  })
}

void main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
