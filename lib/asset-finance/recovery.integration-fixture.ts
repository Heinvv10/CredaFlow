/**
 * Real-Postgres fixture for the slice 4a recovery suites
 * (RUN_ASSET_FINANCE_RECOVERY_IT): the deal fixture's tenant (staff, supplier,
 * entity, director) plus loans booked straight into the tables with triggers
 * off (test setup only: the booking path has its own suites), each on its own
 * asset and borrower so the one-open-recovery and asset-status rules never
 * collide between cases. Everything else (recoveries, steps, costs, sales)
 * goes through the real triggers. Every value is synthetic. Not a test file.
 */
import { randomUUID } from "node:crypto"
import type { ContractType, PrismaClient, RecoveryRoute, ValuationSource } from "@prisma/client"
import { runWithTenant } from "@/lib/tenant-scope"
import { recordCommercialCancellation } from "./commercial-cancellation"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "./deal.integration-fixture"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { testSetup } from "./lease-servicing.integration-fixture"
import { syntheticSaIdNumber } from "./synthetic-sa-id.integration-fixture"

export type Regime = "NCA" | "NON_NCA"
export interface RecoveryFixture extends DealFixture {
  /** A second staff member besides the deal fixture's officer and admins. */
  attorney: string
}
export interface RecoveryLoan {
  loanId: string
  assetId: string
  regime: Regime
  contractType: ContractType
  /** The borrower's ID number (client) or registration number (entity). */
  borrowerKey: string
  entityId: string | null
  /** A deferred loan (newLoan `deferred`): books the loan in a transaction of the caller's, triggers on. */
  book?: (tx: Pick<PrismaClient, "$executeRawUnsafe">) => Promise<unknown>
}

export const today = () => sastCalendarDate(new Date())
export const day = (offset: number) => fromDayNumber(toDayNumber(today()) + offset)
export const recoveryFixtureTenantId = dealFixtureTenantId

export async function createRecoveryFixture(db: PrismaClient, t: string): Promise<RecoveryFixture> {
  const fx = await createDealFixture(db, t)
  return { ...fx, attorney: fx.supplier }
}

/** A fresh financed asset (its own serial) for a loan. */
export async function newAsset(db: PrismaClient, fx: DealFixture, extra: { registrationNumber?: string } = {}): Promise<string> {
  const token = randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()
  return (await db.financedAsset.create({
    data: {
      tenantId: fx.tenantId, assetClass: "EXCAVATOR", make: "TEST", model: "EX-R", year: 2025, serialNumber: `RCV${token}`,
      cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000, ...extra,
    },
  })).id
}

/**
 * Books an application and loan with triggers off: NCA loans borrow as a
 * fresh consumer, NON_NCA ones as a fresh company (the director is its
 * related client). `contractType` defaults to an instalment sale.
 */
export async function newLoan(
  db: PrismaClient, fx: DealFixture, regime: Regime, contractType: ContractType = "INSTALMENT_SALE", options: { assetId?: string; deferred?: boolean } = {},
): Promise<RecoveryLoan> {
  const token = randomUUID().replaceAll("-", "").slice(0, 12)
  const assetId = options.assetId ?? await newAsset(db, fx)
  let clientId: string | null = null
  let entityId: string | null = null
  let borrowerKey: string
  if (regime === "NCA") {
    borrowerKey = syntheticSaIdNumber()
    clientId = (await db.client.create({
      data: {
        tenantId: fx.tenantId, firstName: "TEST", lastName: `Debtor${token}`, email: `debtor-${token}@client.invalid`, phone: `0003${token.slice(0, 6)}`,
        idNumber: borrowerKey, popiaConsentGiven: true, addressLine1: "9 Synthetic Recovery Road", city: "Johannesburg", postalCode: "2001",
      },
    })).id
  } else {
    borrowerKey = `2099/${token.slice(0, 6)}/05`
    entityId = (await db.businessEntity.create({
      data: { tenantId: fx.tenantId, type: "COMPANY", legalName: `TEST Hauliers ${token} (Pty) Ltd`, registrationNumber: borrowerKey, addressLine1: "9 Synthetic Recovery Road", city: "Johannesburg", postalCode: "2001" },
    })).id
    await db.entityRelationship.create({ data: { tenantId: fx.tenantId, entityId, clientId: fx.director, role: "DIRECTOR" } })
  }
  const lease = contractType === "OPERATING_LEASE" || contractType === "FULL_MAINTENANCE_LEASE"
  const applicationId = `app_rcv_${token}`
  const loanId = `loan_rcv_${token}`
  await testSetup(
    db,
    [`INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "entityId", "productId", "appliedAmount", "appliedTermDays",
        "ncaRegime", "ncaClassificationRule", "ncaClassifiedAt", "ncaClassifiedById", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, 150000000, 1825, $7::"NcaRegime", 'FINANCIALS_UNPROVEN', CURRENT_TIMESTAMP, $8, CURRENT_TIMESTAMP)`,
      applicationId, fx.tenantId, `RCV-${token}`, clientId, entityId, fx.product, regime, fx.officer]
  )
  const loanInsert: [string, ...unknown[]] = [`INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId", "clientId", "entityId", "productId", "principal", "totalInterest", "initiationFee",
        "totalRepayable", "outstandingPrincipal", "startDate", "maturityDate", "interestRatePm", "interestModel", "ncaRegime", "contractType", "assetId", "cpaApplies", "cpaRule", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, 150000000, 1, 0, 150000001, 150000000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP + INTERVAL '5 years', 1.0,
        'DAILY_ACCRUAL', $8::"NcaRegime", $9::"ContractType", $10, $11::boolean, $12, CURRENT_TIMESTAMP)`,
      loanId, fx.tenantId, `RCVL-${token}`, applicationId, clientId, entityId, fx.product, regime, contractType, assetId,
      lease ? true : null, lease ? "CPA_JURISTIC_UNDER_THRESHOLD" : null]
  if (options.deferred) return { loanId, assetId, regime, contractType, borrowerKey, entityId, book: (tx) => tx.$executeRawUnsafe(...loanInsert) }
  await testSetup(db, loanInsert)
  return { loanId, assetId, regime, contractType, borrowerKey, entityId }
}

export const routeOf = (regime: Regime, court = false): RecoveryRoute =>
  regime === "NCA" ? (court ? "NCA_S131_ATTACHMENT" : "NCA_S127_SURRENDER") : (court ? "NON_NCA_COURT_ORDER" : "NON_NCA_VOLUNTARY")

export async function newValuation(
  db: PrismaClient, fx: DealFixture, assetId: string, amountCents = 100_000_000, source: ValuationSource = "ASSESSOR", valuedOn = today(), createdById = fx.adminA,
): Promise<string> {
  return (await db.assetValuation.create({
    data: { tenantId: fx.tenantId, assetId, valuedOn: dbDate(valuedOn), source, valuerName: "TEST Valuers", amountCents, createdById },
  })).id
}

/** A section 129 notice record of a loan: completed `completedDaysAgo` days ago (today by default), or still pending. */
export async function s129Record(
  db: PrismaClient, fx: DealFixture, loanId: string, status: "COMPLETED" | "PENDING" = "COMPLETED", completedDaysAgo = 0,
): Promise<string> {
  return (await db.complianceRecord.create({
    data: {
      tenantId: fx.tenantId, type: "SECTION_129_NOTICE", referenceId: loanId, status,
      completedAt: new Date(Date.now() - completedDaysAgo * 86_400_000),
    },
  })).id
}

export async function newMatter(db: PrismaClient, fx: DealFixture, loanId: string): Promise<string> {
  return (await db.legalMatter.create({ data: { tenantId: fx.tenantId, loanId, createdById: fx.officer } })).id
}

/** A step through the guard; `stepDate` defaults to today. */
export async function addStep(
  db: PrismaClient, fx: DealFixture, matterId: string, kind: string, stepDate = today(), extra: Record<string, unknown> = {},
): Promise<string> {
  return (await db.legalMatterStep.create({
    data: { tenantId: fx.tenantId, matterId, kind: kind as never, stepDate: dbDate(stepDate), recordedById: fx.officer, ...extra },
  })).id
}

/** An NCA loan's s127 surrender request (through the guard). */
export async function newSurrender(db: PrismaClient, fx: DealFixture, loan: RecoveryLoan): Promise<string> {
  return (await db.surrenderRequest.create({
    data: {
      tenantId: fx.tenantId, loanId: loan.loanId, assetId: loan.assetId, requestedByType: "STAFF", requestedById: fx.officer, requestedOn: dbDate(today()),
      assetCondition: "Synthetic: fair", valuationDueOn: dbDate(day(5)),
    },
  })).id
}

/** A matter on the loan with a judgment and an attachment order: what an s131 recovery (or a court-order one) stands on. */
export async function courtMatter(db: PrismaClient, fx: DealFixture, loan: RecoveryLoan): Promise<string> {
  const matterId = await newMatter(db, fx, loan.loanId)
  await addStep(db, fx, matterId, "JUDGMENT", today(), { evidenceDocumentId: await legalDocument(db, fx) }) // the court order on file
  await addStep(db, fx, matterId, "ATTACHMENT_ORDER")
  return matterId
}

/** A recovery through the guard (RECOVERED), recovered today unless `extra` says otherwise. */
export async function newRecovery(db: PrismaClient, fx: DealFixture, loan: RecoveryLoan, route: RecoveryRoute, extra: Record<string, unknown> = {}): Promise<string> {
  return (await db.recovery.create({
    data: {
      tenantId: fx.tenantId, loanId: loan.loanId, assetId: loan.assetId, route, recoveredOn: dbDate(today()), location: "TEST Yard", condition: "Synthetic: fair",
      createdById: fx.officer, ...extra,
    },
  })).id
}

/** A legal-document evidence row on a deal-less entity (test setup only). */
export async function legalDocument(db: PrismaClient, fx: DealFixture, docType: "LEGAL_DOCUMENT" | "OTHER" = "LEGAL_DOCUMENT"): Promise<string> {
  return (await db.entityDocument.create({
    data: {
      tenantId: fx.tenantId, entityId: fx.evidenced, docType, fileName: `${docType.toLowerCase()}.pdf`, mimeType: "application/pdf", fileSize: 1,
      storagePath: `/nonexistent/${randomUUID()}.pdf`, contentSha256: "0".repeat(64), uploadedByType: "staff", uploadedById: fx.officer,
    },
  })).id
}

/** A tax invoice for the SAST sale day, to the buyer outside any loan (triggers off: numbering and the VAT-rate rule are not under test here). */
export async function saleInvoice(db: PrismaClient, fx: DealFixture, totalInclVatCents = 120_000_000, loanId: string | null = null): Promise<string> {
  const id = `inv_rcv_${randomUUID().replaceAll("-", "").slice(0, 12)}`
  const number = Math.floor(Math.random() * 1_000_000_000) + 1
  await testSetup(db, [
    `INSERT INTO "TaxInvoice" ("id", "tenantId", "number", "invoiceNumber", "issueDate", "supplyDate", "supplierName", "supplierAddress", "supplierVatNumber",
       "recipientName", "recipientAddress", "vatRate", "totalExclVatCents", "vatCents", "totalInclVatCents", "loanId")
     VALUES ($1, $2, $3, $4, $7::date, $7::date, 'TEST Asset Credit (Pty) Ltd', '1 Synthetic Road', '4000000001', 'TEST Buyer', '2 Buyer Street', 0.15,
       $5::int - $5::int * 15 / 115, $5::int * 15 / 115, $5::int, $6)`,
    id, fx.tenantId, number, `INV-${number}`, totalInclVatCents, loanId, dbDate(today()),
  ])
  return id
}

/** Removes the recovery rows (triggers off), then the lease and deal fixtures'. */
export async function cleanupRecoveryRows(db: PrismaClient, tenantId: string): Promise<void> {
  await db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.recoveryRefund.deleteMany({ where: { tenantId } }),
    db.recoveryVatEvent.deleteMany({ where: { tenantId } }),
    db.recoveryCost.deleteMany({ where: { tenantId } }),
    db.remarketingSale.deleteMany({ where: { tenantId } }),
    db.recovery.deleteMany({ where: { tenantId } }),
    db.legalMatterStep.deleteMany({ where: { tenantId } }),
    db.legalMatter.deleteMany({ where: { tenantId } }),
    db.assetMeterReading.deleteMany({ where: { tenantId } }),
    db.entityDocument.deleteMany({ where: { tenantId } }),
  ])
}

export async function cleanupRecoveryFixture(db: PrismaClient, tenantId: string): Promise<void> {
  await cleanupRecoveryRows(db, tenantId)
  await cleanupDealFixture(db, { tenantId })
}

/** Align a synthetic recovery account's cash schedule with its loan snapshot. */
export async function alignRecoveryFixtureSchedule(db: PrismaClient, loanId: string): Promise<void> {
  const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId }, select: { ncaRegime: true } })
  if (loan.ncaRegime !== "NON_NCA") return
  await testSetup(db,
    [`DELETE FROM "RepaymentSchedule" WHERE "loanId" = $1`, loanId],
    [`INSERT INTO "RepaymentSchedule" ("id", "tenantId", "loanId", "installmentNo", "dueDate", "principalDue", "interestDue", "feesDue", "totalDue")
      SELECT $2, "tenantId", "id", 1, "maturityDate", "principal", "totalInterest", "totalRepayable" - "principal" - "totalInterest", "totalRepayable" FROM "Loan" WHERE "id" = $1`, loanId, `rs_${randomUUID().replaceAll("-", "").slice(0, 18)}`],
  )
}


/** Explicit cancellation evidence for synthetic recovery accounts, before their sale. */
export async function recordFixtureCommercialCancellation(db: PrismaClient, fx: DealFixture, loanId: string, cancelledOn = today()): Promise<void> {
  const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId }, include: { assetFinanceDeal: { select: { id: true } }, commercialCancellationEvent: true } })
  if (loan.ncaRegime !== "NON_NCA" || loan.contractType !== "INSTALMENT_SALE" || loan.commercialCancellationEvent) return
  if (await db.repaymentSchedule.count({ where: { loanId } }) === 0) await alignRecoveryFixtureSchedule(db, loanId)
  await testSetup(db, [`UPDATE "LoanApplication" SET "status" = 'DISBURSED', "approvedAt" = CURRENT_TIMESTAMP, "approvedById" = $2,
    "disbursedAt" = CURRENT_TIMESTAMP, "repaymentMethod" = 'EFT' WHERE "id" = $1`, loan.applicationId, fx.adminA])
  const evidence = await db.entityDocument.create({ data: { tenantId: fx.tenantId, entityId: loan.entityId, dealId: loan.assetFinanceDeal?.id,
    docType: "LEGAL_DOCUMENT", fileName: "TEST-cancellation-evidence.pdf", mimeType: "application/pdf", fileSize: 1, storagePath: "/nonexistent/TEST-cancellation.pdf",
    contentSha256: "0".repeat(64), uploadedByType: "staff", uploadedById: fx.adminA } })
  const result = await runWithTenant(fx.tenantId, () => recordCommercialCancellation({ tenantId: fx.tenantId, userId: fx.adminA }, loanId,
    { cancelledOn, evidenceDocumentId: evidence.id, basis: "TEST written termination effective on the recorded date", cancellationConfirmed: true }))
  if (result.kind !== "done") throw new Error(`Synthetic cancellation failed: ${JSON.stringify(result)}`)
}
