/**
 * Run only against a throwaway, fully migrated PostgreSQL database:
 *
 *   RUN_CREDIT_LIFE_GUARD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/insurance/credit-life-containment-migration.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"

const RUN = process.env.RUN_CREDIT_LIFE_GUARD_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

type ElectionFixture = boolean | "missing" | "malformed"

type Foundation = {
  tenantId: string
  loanProductId: string
  insuranceProductId: string
}

type AgreementScenario = Foundation & {
  label: string
  clientId: string
  applicationId: string
  loanId: string
  artifactId: string
  documentId: string
  documentSha256: string
  documentStoragePath: string
  documentFileName: string
  documentFileSize: number
  startDate: Date
  maturityDate: Date
}

async function createFoundation(label: string): Promise<Foundation> {
  const tenantId = `tenant_credit_life_${label}_${token}`
  const loanProductId = `loan_product_credit_life_${label}_${token}`
  const insuranceProductId = `insurance_product_credit_life_${label}_${token}`

  await prisma.tenant.create({
    data: { id: tenantId, slug: `credit-life-${label}-${token}`, name: `Credit life ${label}` },
  })
  await prisma.loanProduct.create({
    data: {
      id: loanProductId,
      tenantId,
      code: `CL-${label}-${token}`,
      name: `Credit life ${label} loan`,
      productType: "MICRO",
      minAmount: 100_000,
      maxAmount: 1_000_000,
      minTermDays: 1,
      maxTermDays: 365,
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL",
    },
  })
  await prisma.insuranceProduct.create({
    data: {
      id: insuranceProductId,
      tenantId,
      code: `CL-COVER-${label}-${token}`,
      name: `Credit life cover ${label}`,
      type: "CREDIT_LIFE",
      premiumAmount: 22.5,
      sumAssured: 5_000,
      active: true,
    },
  })
  return { tenantId, loanProductId, insuranceProductId }
}

async function createAgreementScenario(
  foundation: Foundation,
  label: string,
  election: ElectionFixture,
): Promise<AgreementScenario> {
  const {
    tenantId,
    loanProductId,
    insuranceProductId,
  } = foundation
  const clientId = `client_credit_life_${label}_${token}`
  const applicationId = `application_credit_life_${label}_${token}`
  const loanId = `loan_credit_life_${label}_${token}`
  const artifactId = `artifact_credit_life_${label}_${token}`
  const documentId = `document_credit_life_${label}_${token}`
  const documentSha256 = label.charCodeAt(0).toString(16).padStart(2, "0").repeat(32)
  const documentStoragePath = `/tmp/credit-life-${label}-${token}.pdf`
  const documentFileName = `credit-agreement-${applicationId}.pdf`
  const documentFileSize = 4096
  const startDate = new Date("2026-07-22T00:00:00.000Z")
  const maturityDate = new Date("2026-08-22T00:00:00.000Z")

  await prisma.client.create({
    data: {
      id: clientId,
      tenantId,
      reference: `CLIENT-${label}-${token}`,
      idNumber: `ID-${label}-${token}`,
      firstName: "Synthetic",
      lastName: label,
      email: `credit-life-${label}-${token}@example.invalid`,
      phone: "+27820000000",
    },
  })
  await prisma.loanApplication.create({
    data: {
      id: applicationId,
      tenantId,
      reference: `APP-${label}-${token}`,
      clientId,
      productId: loanProductId,
      appliedAmount: 500_000,
      appliedTermDays: 31,
      status: "APPROVED",
      agreementDocumentId: documentId,
      agreementDocumentSha256: documentSha256,
      agreementSignedAt: startDate,
      agreementSignedMethod: "portal",
      agreementSignedByIp: "192.0.2.10",
      agreementSignatureData: `Synthetic ${label}`,
    },
  })
  await prisma.clientDocument.create({
    data: {
      id: documentId,
      tenantId,
      clientId,
      docType: "CREDIT_AGREEMENT",
      fileUrl: `/api/documents/${documentId}/view`,
      fileName: documentFileName,
      fileSize: documentFileSize,
      mimeType: "application/pdf",
      storagePath: documentStoragePath,
      contentSha256: documentSha256,
      extractionStatus: "skipped",
      verified: true,
      verifiedAt: startDate,
      signatureState: "signed",
      signedAt: startDate,
    },
  })

  if (election !== "missing") {
    await prisma.complianceRecord.create({
      data: {
        id: artifactId,
        tenantId,
        type: "AGREEMENT_ARTIFACT",
        referenceId: applicationId,
        status: "COMPLETED",
        completedAt: startDate,
        data: {
          kind: "CREDIT_AGREEMENT_ARTIFACT",
          lifecycle: "COMPLETED",
          applicationId,
          documentId,
          documentSha256,
          storagePath: documentStoragePath,
          fileName: documentFileName,
          fileSize: documentFileSize,
          creditLifeAutoBundleEligible: election === "malformed" ? "true" : election,
        },
      },
    })
  }

  return {
    tenantId,
    loanProductId,
    insuranceProductId,
    label,
    clientId,
    applicationId,
    loanId,
    artifactId,
    documentId,
    documentSha256,
    documentStoragePath,
    documentFileName,
    documentFileSize,
    startDate,
    maturityDate,
  }
}

function loanData(scenario: AgreementScenario) {
  return {
    id: scenario.loanId,
    tenantId: scenario.tenantId,
    reference: `LOAN-${scenario.label}-${token}`,
    applicationId: scenario.applicationId,
    clientId: scenario.clientId,
    productId: scenario.loanProductId,
    principal: 500_000,
    totalInterest: 10_000,
    initiationFee: 0,
    totalRepayable: 510_000,
    outstandingPrincipal: 500_000,
    startDate: scenario.startDate,
    maturityDate: scenario.maturityDate,
    interestRatePm: 0.05,
    interestModel: "DAILY_ACCRUAL" as const,
    monthlyServiceFee: 0,
    agreementDocId: scenario.documentId,
  }
}

function policyData(scenario: AgreementScenario, includeProduct = true) {
  return {
    tenantId: scenario.tenantId,
    clientId: scenario.clientId,
    policyNumber: `CL-${scenario.label}-${token}`,
    type: "CREDIT_LIFE" as const,
    status: "ACTIVE" as const,
    premiumAmount: 22.5,
    sumAssured: 5_000,
    linkedLoanId: scenario.loanId,
    startDate: scenario.startDate,
    renewalDate: scenario.maturityDate,
    policySource: "BUNDLED_CREDIT_AGREEMENT" as const,
    ...(includeProduct ? { productId: scenario.insuranceProductId } : {}),
  }
}

async function commitDisbursement(
  scenario: AgreementScenario,
  policy: "none" | "valid" | "missing_product",
  flushConstraints = true,
  policyOverrides: Partial<ReturnType<typeof policyData>> = {},
  applicationName?: string,
  afterPolicyCreated?: () => Promise<void>,
) {
  return prisma.$transaction(async (tx) => {
    if (applicationName) {
      if (!/^[a-z0-9-]+$/.test(applicationName)) throw new Error("Invalid test application name")
      await tx.$executeRawUnsafe(`SET LOCAL application_name = '${applicationName}'`)
    }
    const loan = await tx.loan.create({ data: loanData(scenario) })
    await tx.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { status: "DISBURSED", disbursedAt: scenario.startDate },
    })
    const createdPolicy = policy === "none"
      ? null
      : await tx.insurancePolicy.create({
          data: {
            ...policyData(scenario, policy === "valid"),
            ...policyOverrides,
          },
        })
    if (createdPolicy && afterPolicyCreated) await afterPolicyCreated()
    if (flushConstraints) {
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    }
    return { loan, policy: createdPolicy }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForDatabaseLock(applicationName: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<Array<{ waiting: boolean }>>(`
      SELECT (wait_event_type = 'Lock') AS waiting
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = $1
    `, applicationName)
    if (rows.some((row) => row.waiting)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${applicationName} to block on a database lock`)
}

suite("bundled credit-life migration guard", () => {
  it("fails rollback disbursement closed for true, missing, and malformed elections", async () => {
    const foundation = await createFoundation(`deferred-${token.slice(0, 6)}`)
    const elected = await createAgreementScenario(foundation, "elected", true)
    const declined = await createAgreementScenario(foundation, "declined", false)
    const missing = await createAgreementScenario(foundation, "missing", "missing")
    const malformed = await createAgreementScenario(foundation, "malformed", "malformed")
    const rollbackWriter = await createAgreementScenario(foundation, "rollback-writer", true)

    // Rollback/legacy images do not force the constraint before returning from
    // the callback. The deferred database trigger still rejects at COMMIT. A
    // Prisma engine can hide that late error from the promise, so persisted
    // state—not promise shape—is the authoritative assertion here.
    await commitDisbursement(rollbackWriter, "none", false).catch(() => undefined)
    expect(await prisma.loan.count({
      where: { id: rollbackWriter.loanId, tenantId: rollbackWriter.tenantId },
    })).toBe(0)
    expect(await prisma.loanApplication.findUniqueOrThrow({
      where: { id: rollbackWriter.applicationId, tenantId: rollbackWriter.tenantId },
      select: { status: true, disbursedAt: true },
    })).toEqual({ status: "APPROVED", disbursedAt: null })

    await expect(commitDisbursement(elected, "none"))
      .rejects.toThrow(/elected credit life requires exactly one valid bundled policy/i)
    await expect(commitDisbursement(elected, "missing_product"))
      .rejects.toThrow(/requires an active tenant-bound credit-life product and loan/i)
    await expect(commitDisbursement(missing, "none"))
      .rejects.toThrow(/explicit boolean credit-life election/i)
    await expect(commitDisbursement(malformed, "none"))
      .rejects.toThrow(/explicit boolean credit-life election/i)

    for (const scenario of [elected, missing, malformed]) {
      expect(await prisma.loan.count({
        where: { id: scenario.loanId, tenantId: scenario.tenantId },
      })).toBe(0)
      expect(await prisma.loanApplication.findUniqueOrThrow({
        where: { id: scenario.applicationId, tenantId: scenario.tenantId },
        select: { status: true, disbursedAt: true },
      })).toEqual({ status: "APPROVED", disbursedAt: null })
    }

    await expect(commitDisbursement(declined, "none")).resolves.toMatchObject({
      loan: { id: declined.loanId },
      policy: null,
    })
    expect(await prisma.loanApplication.findUniqueOrThrow({
      where: { id: declined.applicationId, tenantId: declined.tenantId },
      select: { status: true, disbursedAt: true },
    })).toEqual({ status: "DISBURSED", disbursedAt: declined.startDate })

    await expect(prisma.insurancePolicy.create({
      data: policyData(declined),
    })).rejects.toThrow(/not authorised by the exact completed agreement artifact/i)

    // The deferred reverse invariant protects an explicit false election too;
    // the document cannot become invalid merely because no policy exists.
    await expect(prisma.clientDocument.update({
      where: { id: declined.documentId, tenantId: declined.tenantId },
      data: { verified: false },
    })).rejects.toThrow(/requires the exact signed, verified, non-deleted agreement document/i)
  })

  it("rejects invalid or unfrozen bundled policy money and dates atomically", async () => {
    const foundation = await createFoundation(`terms-${token.slice(0, 6)}`)
    const cases: Array<{
      label: string
      policy: Partial<ReturnType<typeof policyData>>
      error: RegExp
    }> = [
      { label: "premium-negative", policy: { premiumAmount: -1 }, error: /positive monetary terms/i },
      { label: "premium-zero", policy: { premiumAmount: 0 }, error: /positive monetary terms/i },
      { label: "premium-mismatch", policy: { premiumAmount: 22.49 }, error: /must match the frozen loan/i },
      { label: "cover-negative", policy: { sumAssured: -1 }, error: /positive monetary terms/i },
      { label: "cover-zero", policy: { sumAssured: 0 }, error: /positive monetary terms/i },
      { label: "cover-mismatch", policy: { sumAssured: 4_999 }, error: /must match the frozen loan/i },
      {
        label: "start-mismatch",
        policy: { startDate: new Date("2026-07-23T00:00:00.000Z") },
        error: /must match the frozen loan/i,
      },
      {
        label: "dates-reversed",
        policy: { renewalDate: new Date("2026-07-21T00:00:00.000Z") },
        error: /end date after its start date/i,
      },
      {
        label: "maturity-mismatch",
        policy: { renewalDate: new Date("2026-08-23T00:00:00.000Z") },
        error: /must match the frozen loan/i,
      },
    ]

    for (const testCase of cases) {
      const scenario = await createAgreementScenario(foundation, testCase.label, true)
      await expect(commitDisbursement(scenario, "valid", true, testCase.policy))
        .rejects.toThrow(testCase.error)
      expect(await prisma.loan.count({
        where: { id: scenario.loanId, tenantId: scenario.tenantId },
      })).toBe(0)
      expect(await prisma.loanApplication.findUniqueOrThrow({
        where: { id: scenario.applicationId, tenantId: scenario.tenantId },
        select: { status: true, disbursedAt: true },
      })).toEqual({ status: "APPROVED", disbursedAt: null })
    }

    for (const productMutation of [
      { active: false },
      { active: true, premiumAmount: -1 },
      { premiumAmount: 22.5, sumAssured: 0 },
    ]) {
      await prisma.insuranceProduct.update({
        where: { id: foundation.insuranceProductId, tenantId: foundation.tenantId },
        data: productMutation,
      })
      const scenario = await createAgreementScenario(
        foundation,
        `product-${Object.keys(productMutation).join("-")}-${randomUUID().slice(0, 6)}`,
        true,
      )
      await expect(commitDisbursement(scenario, "valid"))
        .rejects.toThrow(/active tenant-bound credit-life product with positive configured terms/i)
    }

    await prisma.insuranceProduct.update({
      where: { id: foundation.insuranceProductId, tenantId: foundation.tenantId },
      data: { active: true, premiumAmount: 22.5, sumAssured: 5_000 },
    })
  })

  it("serializes product-type and policy creation races in both transaction orders", async () => {
    const unusedFoundation = await createFoundation(`unused-product-${token.slice(0, 6)}`)
    await expect(prisma.insuranceProduct.update({
      where: {
        id: unusedFoundation.insuranceProductId,
        tenantId: unusedFoundation.tenantId,
      },
      data: { type: "FUNERAL_COVER" },
    })).resolves.toMatchObject({ type: "FUNERAL_COVER" })
    await expect(prisma.insuranceProduct.update({
      where: {
        id: unusedFoundation.insuranceProductId,
        tenantId: unusedFoundation.tenantId,
      },
      data: { type: "CREDIT_LIFE" },
    })).resolves.toMatchObject({ type: "CREDIT_LIFE" })

    const policyFirstFoundation = await createFoundation(`race-policy-${token.slice(0, 6)}`)
    const policyFirst = await createAgreementScenario(policyFirstFoundation, "race-policy-first", true)
    const policyReady = deferred()
    const releasePolicy = deferred()
    const productUpdateName = `product-update-${token.slice(0, 10)}`

    const policyTransaction = commitDisbursement(
      policyFirst,
      "valid",
      true,
      {},
      `policy-first-${token.slice(0, 10)}`,
      async () => {
        policyReady.resolve()
        await releasePolicy.promise
      },
    )
    await policyReady.promise

    const queuedProductUpdate = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL application_name = '${productUpdateName}'`)
      return tx.insuranceProduct.update({
        where: {
          id: policyFirst.insuranceProductId,
          tenantId: policyFirst.tenantId,
        },
        data: { type: "FUNERAL_COVER" },
      })
    })
    const queuedProductOutcome = queuedProductUpdate.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )

    try {
      await waitForDatabaseLock(productUpdateName)
    } finally {
      releasePolicy.resolve()
    }

    await expect(policyTransaction).resolves.toMatchObject({
      loan: { id: policyFirst.loanId },
      policy: { linkedLoanId: policyFirst.loanId },
    })
    const queuedProductResult = await queuedProductOutcome
    expect(queuedProductResult.ok).toBe(false)
    if (!queuedProductResult.ok) {
      expect(String(queuedProductResult.error)).toMatch(/product identity and type are immutable|write conflict|serialize/i)
    }
    expect(await prisma.insuranceProduct.findUniqueOrThrow({
      where: {
        id: policyFirst.insuranceProductId,
        tenantId: policyFirst.tenantId,
      },
      select: { type: true },
    })).toEqual({ type: "CREDIT_LIFE" })

    const productFirstFoundation = await createFoundation(`race-product-${token.slice(0, 6)}`)
    const productFirst = await createAgreementScenario(productFirstFoundation, "race-product-first", true)
    const productReady = deferred()
    const releaseProduct = deferred()
    const productFirstName = `product-first-${token.slice(0, 10)}`
    const policyWaiterName = `policy-waiter-${token.slice(0, 10)}`

    const productTransaction = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL application_name = '${productFirstName}'`)
      await tx.$queryRawUnsafe(`
        SELECT "id"
        FROM "InsuranceProduct"
        WHERE "id" = $1 AND "tenantId" = $2
        FOR UPDATE
      `, productFirst.insuranceProductId, productFirst.tenantId)
      productReady.resolve()
      await releaseProduct.promise
      return tx.insuranceProduct.update({
        where: {
          id: productFirst.insuranceProductId,
          tenantId: productFirst.tenantId,
        },
        data: { type: "FUNERAL_COVER" },
      })
    })
    const productOutcome = productTransaction.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await productReady.promise

    const waitingPolicy = commitDisbursement(
      productFirst,
      "valid",
      true,
      {},
      policyWaiterName,
    )
    try {
      await waitForDatabaseLock(policyWaiterName)
    } finally {
      releaseProduct.resolve()
    }

    const productResult = await productOutcome
    expect(productResult.ok).toBe(true)
    if (productResult.ok) expect(productResult.value).toMatchObject({ type: "FUNERAL_COVER" })
    await expect(waitingPolicy).rejects.toBeDefined()

    expect(await prisma.insuranceProduct.findUniqueOrThrow({
      where: {
        id: productFirst.insuranceProductId,
        tenantId: productFirst.tenantId,
      },
      select: { type: true },
    })).toEqual({ type: "FUNERAL_COVER" })
    expect(await prisma.insurancePolicy.count({
      where: { linkedLoanId: productFirst.loanId, tenantId: productFirst.tenantId },
    })).toBe(0)
    expect(await prisma.loan.count({
      where: { id: productFirst.loanId, tenantId: productFirst.tenantId },
    })).toBe(0)
    expect(await prisma.loanApplication.findUniqueOrThrow({
      where: { id: productFirst.applicationId, tenantId: productFirst.tenantId },
      select: { status: true, disbursedAt: true },
    })).toEqual({ status: "APPROVED", disbursedAt: null })
  }, 30_000)

  it("allows the current transaction order and freezes the completed evidence chain", async () => {
    const foundation = await createFoundation(`valid-${token.slice(0, 6)}`)
    const scenario = await createAgreementScenario(foundation, "valid", true)
    const committed = await commitDisbursement(scenario, "valid")
    const authorisedPolicy = committed.policy!

    expect(committed.loan).toMatchObject({
      id: scenario.loanId,
      tenantId: scenario.tenantId,
      clientId: scenario.clientId,
    })
    expect(authorisedPolicy).toMatchObject({
      tenantId: scenario.tenantId,
      clientId: scenario.clientId,
      linkedLoanId: scenario.loanId,
      productId: scenario.insuranceProductId,
      policySource: "BUNDLED_CREDIT_AGREEMENT",
    })

    await expect(prisma.insurancePolicy.create({
      data: {
        ...policyData(scenario),
        policyNumber: `CL-DUPLICATE-${token}`,
      },
    })).rejects.toThrow()

    await expect(prisma.insurancePolicy.update({
      where: { id: authorisedPolicy.id, tenantId: scenario.tenantId },
      data: { linkedLoanId: null },
    })).rejects.toThrow(/agreement binding is immutable/i)

    await expect(prisma.loan.update({
      where: { id: scenario.loanId, tenantId: scenario.tenantId },
      data: { agreementDocId: `different-${scenario.documentId}` },
    })).rejects.toThrow(/requires the exact signed, verified, non-deleted agreement document/i)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: { agreementDocumentSha256: "b".repeat(64) },
    })).rejects.toThrow(/requires the exact signed, verified, non-deleted agreement document/i)

    await expect(prisma.loanApplication.update({
      where: { id: scenario.applicationId, tenantId: scenario.tenantId },
      data: {
        agreementSignedMethod: "branch",
        agreementSignedByIp: "192.0.2.11",
        agreementSignatureData: "Rewritten signature",
      },
    })).rejects.toThrow(/signed agreement evidence is immutable/i)

    for (const data of [
      { verified: false },
      { mimeType: "text/plain" },
      { deletedAt: new Date("2026-07-22T01:00:00.000Z") },
      { storagePath: null },
      { signatureState: null, signedAt: null },
    ]) {
      await expect(prisma.clientDocument.update({
        where: { id: scenario.documentId, tenantId: scenario.tenantId },
        data,
      })).rejects.toThrow(/requires the exact signed, verified, non-deleted agreement document/i)
    }

    await expect(prisma.complianceRecord.update({
      where: { id: scenario.artifactId, tenantId: scenario.tenantId },
      data: {
        data: {
          kind: "CREDIT_AGREEMENT_ARTIFACT",
          lifecycle: "COMPLETED",
          applicationId: scenario.applicationId,
          documentId: scenario.documentId,
          documentSha256: scenario.documentSha256,
          storagePath: scenario.documentStoragePath,
          fileName: scenario.documentFileName,
          fileSize: scenario.documentFileSize,
          creditLifeAutoBundleEligible: false,
        },
      },
    })).rejects.toThrow(/completed credit-agreement artifacts are immutable/i)

    await expect(prisma.complianceRecord.delete({
      where: { id: scenario.artifactId, tenantId: scenario.tenantId },
    })).rejects.toThrow(/completed credit-agreement artifacts are immutable/i)

    await expect(prisma.insuranceProduct.update({
      where: { id: scenario.insuranceProductId, tenantId: scenario.tenantId },
      data: { type: "FUNERAL_COVER" },
    })).rejects.toThrow(/product identity and type are immutable/i)

    for (const data of [
      { premiumAmount: -1 },
      { premiumAmount: 0 },
      { premiumAmount: 22.49 },
      { sumAssured: -1 },
      { sumAssured: 0 },
      { sumAssured: 4_999 },
      { startDate: new Date("2026-07-23T00:00:00.000Z") },
      { renewalDate: new Date("2026-07-21T00:00:00.000Z") },
    ]) {
      await expect(prisma.insurancePolicy.update({
        where: { id: authorisedPolicy.id, tenantId: scenario.tenantId },
        data,
      })).rejects.toThrow(/binding is immutable/i)
    }

    for (const data of [
      { principal: 500_100 },
      { startDate: new Date("2026-07-23T00:00:00.000Z") },
      { maturityDate: new Date("2026-08-23T00:00:00.000Z") },
    ]) {
      await expect(prisma.loan.update({
        where: { id: scenario.loanId, tenantId: scenario.tenantId },
        data,
      })).rejects.toThrow(/terms must match the frozen loan/i)
    }

    await expect(prisma.insurancePolicy.update({
      where: { id: authorisedPolicy.id, tenantId: scenario.tenantId },
      data: { status: "LAPSED" },
    })).resolves.toMatchObject({ status: "LAPSED" })

    await expect(prisma.insurancePolicy.delete({
      where: { id: authorisedPolicy.id, tenantId: scenario.tenantId },
    })).rejects.toThrow(/cannot be hard-deleted/i)

    expect(await prisma.insurancePolicy.count({
      where: {
        id: authorisedPolicy.id,
        tenantId: scenario.tenantId,
        linkedLoanId: scenario.loanId,
      },
    })).toBe(1)
  })

  it("does not change the existing standalone-policy disclosure constraint", async () => {
    const tenantId = `tenant_credit_life_standalone_${token}`
    const clientId = `client_credit_life_standalone_${token}`
    const disclosureAt = new Date("2026-07-22T00:00:00.000Z")

    await prisma.tenant.create({
      data: { id: tenantId, slug: `credit-life-standalone-${token}`, name: "Standalone guard" },
    })
    await prisma.client.create({
      data: {
        id: clientId,
        tenantId,
        reference: `CLIENT-STANDALONE-${token}`,
        idNumber: token.slice(13, 26).padEnd(13, "1"),
        firstName: "Synthetic",
        lastName: "Standalone",
        email: `credit-life-standalone-${token}@example.invalid`,
        phone: "+27820000001",
      },
    })

    await expect(prisma.insurancePolicy.create({
      data: {
        tenantId,
        clientId,
        policyNumber: `STANDALONE-${token}`,
        type: "CREDIT_LIFE",
        status: "ACTIVE",
        premiumAmount: 10,
        sumAssured: 1_000,
        startDate: disclosureAt,
        renewalDate: new Date("2027-07-22T00:00:00.000Z"),
        policySource: "STANDALONE",
        faisDisclosureAt: disclosureAt,
        faisDisclosurePdfUrl: `/test/${token}.pdf`,
        faisDraftTokenHash: token,
      },
    })).resolves.toMatchObject({ policySource: "STANDALONE" })
  })
})
