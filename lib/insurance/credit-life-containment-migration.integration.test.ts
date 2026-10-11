/**
 * Run only against a throwaway, fully migrated PostgreSQL database:
 *
 *   RUN_CREDIT_LIFE_GUARD_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/insurance/credit-life-containment-migration.integration.test.ts
 *
 * Every scenario is a fully countersigned PASQ v3 application from the shared
 * fixture, so a refusal here is the one the live disbursement path would meet.
 * Where an earlier guard refuses a write before a credit-life guard can, the
 * test asserts the guard that actually refuses.
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import {
  createApprovedPasqV3Application,
  writePasqV3Disbursement,
  type AgreementArtifactElection,
  type PasqV3Scenario,
} from "@/lib/compliance/pasq-v3-application.integration-fixture"
import { calculateCreditLifeMonthlyPremiumCents } from "@/lib/insurance/credit-life-election"

const RUN = process.env.RUN_CREDIT_LIFE_GUARD_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")
const DAY_MS = 86_400_000

type WriteOptions = NonNullable<Parameters<typeof writePasqV3Disbursement>[2]>
type Booked = Awaited<ReturnType<typeof writePasqV3Disbursement>>

function createScenario(
  label: string,
  artifactElection: AgreementArtifactElection = true,
  repaymentMethod: "EFT" | "DEBIT_ORDER" = "DEBIT_ORDER",
): Promise<PasqV3Scenario> {
  return createApprovedPasqV3Application(
    `cl-${label}`,
    artifactElection === false ? "DECLINED" : "ACCEPTED",
    true,
    "DEFERRED",
    false,
    null,
    {},
    repaymentMethod,
    artifactElection,
  )
}

async function commitDisbursement(
  scenario: PasqV3Scenario,
  {
    flushConstraints = true,
    applicationName,
    ...options
  }: WriteOptions & { flushConstraints?: boolean; applicationName?: string } = {},
): Promise<Booked> {
  return prisma.$transaction(async (tx) => {
    if (applicationName) {
      if (!/^[a-z0-9-]+$/.test(applicationName)) throw new Error("Invalid test application name")
      await tx.$executeRawUnsafe(`SET LOCAL application_name = '${applicationName}'`)
    }
    const booked = await writePasqV3Disbursement(tx, scenario, options)
    if (flushConstraints) {
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    }
    return booked
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
}

function bundledPolicyData(scenario: PasqV3Scenario, booked: Booked) {
  const principalCents = scenario.pasqEvidence.calculator.principalCents
  return {
    tenantId: scenario.tenantId,
    clientId: scenario.clientId,
    policyNumber: `CL-${randomUUID()}`,
    type: "CREDIT_LIFE" as const,
    status: "ACTIVE" as const,
    premiumAmount: calculateCreditLifeMonthlyPremiumCents(principalCents) / 100,
    sumAssured: principalCents / 100,
    linkedLoanId: booked.loanId,
    startDate: booked.startDate,
    renewalDate: booked.maturityDate,
    productId: scenario.insuranceProductId,
    policySource: "BUNDLED_CREDIT_AGREEMENT" as const,
  }
}

async function expectNotDisbursed(scenario: PasqV3Scenario) {
  expect(await prisma.loan.count({
    where: { applicationId: scenario.applicationId, tenantId: scenario.tenantId },
  })).toBe(0)
  expect(await prisma.loanApplication.findUniqueOrThrow({
    where: { id: scenario.applicationId, tenantId: scenario.tenantId },
    select: { status: true, disbursedAt: true },
  })).toEqual({ status: "APPROVED", disbursedAt: null })
}

async function createStandaloneCreditLifeProduct(label: string) {
  const tenantId = `tenant_credit_life_${label}_${token}`
  const insuranceProductId = `insurance_product_credit_life_${label}_${token}`
  await prisma.tenant.create({
    data: { id: tenantId, slug: `credit-life-${label}-${token}`, name: `Credit life ${label}` },
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
  return { tenantId, insuranceProductId }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** Waits until the named session blocks on a lock; returns the statement it is blocked in. */
async function waitForDatabaseLock(applicationName: string): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRawUnsafe<Array<{ waiting: boolean; query: string }>>(`
      SELECT (wait_event_type = 'Lock') AS waiting, query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND application_name = $1
    `, applicationName)
    const waiting = rows.find((row) => row.waiting)
    if (waiting) return waiting.query
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${applicationName} to block on a database lock`)
}

const CREDIT_LIFE_TRIGGERS = [
  "InsurancePolicy_guard_bundled_credit_life_agreement",
  "InsuranceProduct_guard_credit_life_identity",
  "Loan_lock_bundled_credit_life_dependencies",
  "Loan_assert_bundled_credit_life_dependencies",
  "LoanApplication_lock_bundled_credit_life_dependencies",
  "LoanApplication_assert_bundled_credit_life_dependencies",
  "ClientDocument_lock_bundled_credit_life_dependencies",
  "ClientDocument_assert_bundled_credit_life_dependencies",
  "ComplianceRecord_assert_bundled_credit_life_dependencies",
  "Loan_credit_life_commit_invariant",
  "LoanApplication_credit_life_commit_invariant",
  "ClientDocument_credit_life_commit_invariant",
  "ComplianceRecord_credit_life_commit_invariant",
  "InsurancePolicy_credit_life_commit_invariant",
  "InsuranceProduct_credit_life_commit_invariant",
]

suite("bundled credit-life migration guard", () => {
  it("attaches all 15 credit-life triggers, the commit invariants deferred", async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{
      tgname: string
      tgenabled: string
      tgdeferrable: boolean
      tginitdeferred: boolean
    }>>(`
      SELECT t.tgname, t.tgenabled::TEXT AS tgenabled, t.tgdeferrable, t.tginitdeferred
      FROM pg_trigger AS t
      WHERE NOT t.tgisinternal AND t.tgname = ANY($1::TEXT[])
      ORDER BY t.tgname
    `, CREDIT_LIFE_TRIGGERS)
    expect(rows.map((row) => row.tgname)).toEqual([...CREDIT_LIFE_TRIGGERS].sort())
    for (const row of rows) {
      const commitInvariant = row.tgname.endsWith("_credit_life_commit_invariant")
      expect(row).toEqual({
        tgname: row.tgname,
        tgenabled: "O",
        tgdeferrable: commitInvariant,
        tginitdeferred: commitInvariant,
      })
    }
  })

  it("fails rollback disbursement closed for true, missing, and malformed elections", async () => {
    const elected = await createScenario("elected", true)
    const declined = await createScenario("declined", false)
    const missing = await createScenario("missing", "missing")
    const malformed = await createScenario("malformed", "malformed")
    const rollbackWriter = await createScenario("rollback-writer", true)

    // Rollback/legacy images do not force the constraint before returning from
    // the callback. The deferred database trigger still rejects at COMMIT. A
    // Prisma engine can hide that late error from the promise, so persisted
    // state—not promise shape—is the authoritative assertion here.
    await commitDisbursement(rollbackWriter, { policy: "none", flushConstraints: false })
      .catch(() => undefined)
    await expectNotDisbursed(rollbackWriter)

    await expect(commitDisbursement(elected, { policy: "none" }))
      .rejects.toThrow(/elected credit life requires exactly one valid bundled policy/i)
    await expect(commitDisbursement(elected, { policy: "missing_product" }))
      .rejects.toThrow(/requires an active tenant-bound credit-life product and loan/i)
    await expect(commitDisbursement(missing, { policy: "none" }))
      .rejects.toThrow(/explicit boolean credit-life election/i)
    await expect(commitDisbursement(malformed, { policy: "none" }))
      .rejects.toThrow(/explicit boolean credit-life election/i)

    for (const scenario of [elected, missing, malformed]) {
      await expectNotDisbursed(scenario)
    }

    const booked = await commitDisbursement(declined)
    expect(booked.policyId).toBeNull()
    expect(await prisma.loanApplication.findUniqueOrThrow({
      where: { id: declined.applicationId, tenantId: declined.tenantId },
      select: { status: true, disbursedAt: true },
    })).toEqual({ status: "DISBURSED", disbursedAt: declined.signedAt })

    await expect(prisma.insurancePolicy.create({
      data: bundledPolicyData(declined, booked),
    })).rejects.toThrow(/not authorised by the exact completed agreement artifact/i)

    // The deferred reverse invariant protects an explicit false election too;
    // the document cannot become invalid merely because no policy exists.
    await expect(prisma.clientDocument.update({
      where: { id: declined.agreementDocumentId, tenantId: declined.tenantId },
      data: { verified: false },
    })).rejects.toThrow(/requires the exact signed, verified, non-deleted agreement document/i)
  }, 60_000)

  it("rejects invalid or unfrozen bundled policy money and dates atomically", async () => {
    const cases: Array<{
      label: string
      policy: NonNullable<WriteOptions["policyOverrides"]>
      error: RegExp
    }> = [
      { label: "premium-negative", policy: () => ({ premiumAmount: -1 }), error: /positive monetary terms/i },
      { label: "premium-zero", policy: () => ({ premiumAmount: 0 }), error: /positive monetary terms/i },
      { label: "premium-mismatch", policy: () => ({ premiumAmount: 22.49 }), error: /must match the frozen loan/i },
      { label: "cover-negative", policy: () => ({ sumAssured: -1 }), error: /positive monetary terms/i },
      { label: "cover-zero", policy: () => ({ sumAssured: 0 }), error: /positive monetary terms/i },
      { label: "cover-mismatch", policy: () => ({ sumAssured: 4_999 }), error: /must match the frozen loan/i },
      {
        label: "start-mismatch",
        policy: ({ startDate }) => ({ startDate: new Date(startDate.getTime() + DAY_MS) }),
        error: /must match the frozen loan/i,
      },
      {
        label: "dates-reversed",
        policy: ({ startDate }) => ({ renewalDate: new Date(startDate.getTime() - DAY_MS) }),
        error: /end date after its start date/i,
      },
      {
        label: "maturity-mismatch",
        policy: ({ maturityDate }) => ({ renewalDate: new Date(maturityDate.getTime() + DAY_MS) }),
        error: /must match the frozen loan/i,
      },
    ]

    for (const testCase of cases) {
      const scenario = await createScenario(testCase.label, true)
      await expect(commitDisbursement(scenario, { policyOverrides: testCase.policy }))
        .rejects.toThrow(testCase.error)
      await expectNotDisbursed(scenario)
    }

    // The product row is read first by whichever guard runs first. In the
    // route's order (application, then policy) the application's credit-life
    // offer guard refuses an inactive product before the policy guard sees
    // it; written policy-first, the policy guard refuses it itself.
    const inactiveRouteOrder = await createScenario("product-inactive-route", true)
    await prisma.insuranceProduct.update({
      where: { id: inactiveRouteOrder.insuranceProductId!, tenantId: inactiveRouteOrder.tenantId },
      data: { active: false },
    })
    await expect(commitDisbursement(inactiveRouteOrder))
      .rejects.toThrow(/approval requires an active tenant-bound credit-life product and insurer matching the acknowledged PASQ/i)
    await expectNotDisbursed(inactiveRouteOrder)

    // A non-positive premium or cover cannot reach this guard: the product's
    // own CHECK refuses it (next test). Inactive is the configuration left.
    const inactive = await createScenario("product-inactive", true)
    await prisma.insuranceProduct.update({
      where: { id: inactive.insuranceProductId!, tenantId: inactive.tenantId },
      data: { active: false },
    })
    await expect(commitDisbursement(inactive, { order: "policy-before-application" }))
      .rejects.toThrow(/active tenant-bound credit-life product with positive configured terms/i)
    await expectNotDisbursed(inactive)
  }, 120_000)

  it("refuses a credit-life product without a positive premium and cover", async () => {
    const CHECK = "InsuranceProduct_credit_life_terms_positive"
    const refusedByCheck = async (write: Promise<unknown>) => {
      const error = await write.then(() => null, (e: unknown) => e)
      expect(String(error)).toContain(CHECK)
      expect(String(error)).toContain("23514")
    }
    const { tenantId, insuranceProductId } = await createStandaloneCreditLifeProduct(`terms-${token.slice(0, 6)}`)
    const product = (code: string, type: "CREDIT_LIFE" | "FUNERAL_COVER", premiumAmount: number, sumAssured: number) =>
      prisma.insuranceProduct.create({
        data: { tenantId, code: `${code}-${token}`, name: `Synthetic ${code}`, type, premiumAmount, sumAssured },
      })

    for (const [code, premiumAmount, sumAssured] of [
      ["zero-premium", 0, 5_000],
      ["zero-cover", 22.5, 0],
      ["negative-premium", -1, 5_000],
      ["negative-cover", 22.5, -1],
    ] as const) {
      await refusedByCheck(product(code, "CREDIT_LIFE", premiumAmount, sumAssured))
    }
    for (const data of [{ premiumAmount: 0 }, { sumAssured: 0 }, { premiumAmount: -1 }, { sumAssured: -1 }]) {
      await refusedByCheck(prisma.insuranceProduct.update({ where: { id: insuranceProductId, tenantId }, data }))
    }
    expect(await prisma.insuranceProduct.findUniqueOrThrow({
      where: { id: insuranceProductId, tenantId },
      select: { premiumAmount: true, sumAssured: true },
    })).toEqual({ premiumAmount: new Prisma.Decimal(22.5), sumAssured: new Prisma.Decimal(5_000) })

    // Other product types keep their existing rules: rated products ignore
    // these columns and may carry zero. Turning one into credit life may not.
    const funeral = await product("funeral-zero", "FUNERAL_COVER", 0, 0)
    expect(funeral).toMatchObject({ type: "FUNERAL_COVER" })
    await refusedByCheck(prisma.insuranceProduct.update({
      where: { id: funeral.id, tenantId },
      data: { type: "CREDIT_LIFE" },
    }))

    expect(await prisma.$queryRawUnsafe<Array<{ convalidated: boolean }>>(
      `SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = '"InsuranceProduct"'::regclass`,
      CHECK,
    )).toEqual([{ convalidated: true }])
  })

  it("serializes product-type and policy creation races in both transaction orders", async () => {
    const unused = await createStandaloneCreditLifeProduct(`unused-product-${token.slice(0, 6)}`)
    await expect(prisma.insuranceProduct.update({
      where: { id: unused.insuranceProductId, tenantId: unused.tenantId },
      data: { type: "FUNERAL_COVER" },
    })).resolves.toMatchObject({ type: "FUNERAL_COVER" })
    await expect(prisma.insuranceProduct.update({
      where: { id: unused.insuranceProductId, tenantId: unused.tenantId },
      data: { type: "CREDIT_LIFE" },
    })).resolves.toMatchObject({ type: "CREDIT_LIFE" })

    const policyFirst = await createScenario("race-policy-first", true)
    const policyReady = deferred()
    const releasePolicy = deferred()
    const productUpdateName = `product-update-${token.slice(0, 10)}`

    const policyTransaction = commitDisbursement(policyFirst, {
      applicationName: `policy-first-${token.slice(0, 10)}`,
      afterPolicyCreated: async () => {
        policyReady.resolve()
        await releasePolicy.promise
      },
    })
    await policyReady.promise

    const queuedProductUpdate = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL application_name = '${productUpdateName}'`)
      return tx.insuranceProduct.update({
        where: { id: policyFirst.insuranceProductId!, tenantId: policyFirst.tenantId },
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

    const policyBooked = await policyTransaction
    expect(policyBooked.policyId).toEqual(expect.any(String))
    expect(await prisma.insurancePolicy.findUniqueOrThrow({
      where: { id: policyBooked.policyId!, tenantId: policyFirst.tenantId },
      select: { linkedLoanId: true },
    })).toEqual({ linkedLoanId: policyBooked.loanId })
    const queuedProductResult = await queuedProductOutcome
    expect(queuedProductResult.ok).toBe(false)
    if (!queuedProductResult.ok) {
      expect(String(queuedProductResult.error)).toMatch(/product identity and type are immutable|write conflict|serialize/i)
    }
    expect(await prisma.insuranceProduct.findUniqueOrThrow({
      where: { id: policyFirst.insuranceProductId!, tenantId: policyFirst.tenantId },
      select: { type: true },
    })).toEqual({ type: "CREDIT_LIFE" })

    // Written policy-first, the policy guard is the statement that queues
    // behind the product lock, so the refusal below is the policy guard's.
    const productFirst = await createScenario("race-product-first", true)
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
        where: { id: productFirst.insuranceProductId!, tenantId: productFirst.tenantId },
        data: { type: "FUNERAL_COVER" },
      })
    })
    const productOutcome = productTransaction.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    await productReady.promise

    const waitingPolicy = commitDisbursement(productFirst, {
      applicationName: policyWaiterName,
      order: "policy-before-application",
    })
    const waitingPolicyOutcome = waitingPolicy.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    let blockedStatement: string
    try {
      blockedStatement = await waitForDatabaseLock(policyWaiterName)
    } finally {
      releaseProduct.resolve()
    }
    expect(blockedStatement).toMatch(/INSERT INTO "public"\."InsurancePolicy"/)

    const productResult = await productOutcome
    expect(productResult.ok).toBe(true)
    if (productResult.ok) expect(productResult.value).toMatchObject({ type: "FUNERAL_COVER" })
    const waitingResult = await waitingPolicyOutcome
    expect(waitingResult.ok).toBe(false)
    if (!waitingResult.ok) {
      expect(String(waitingResult.error)).toMatch(/serializ|write conflict/i)
    }

    expect(await prisma.insuranceProduct.findUniqueOrThrow({
      where: { id: productFirst.insuranceProductId!, tenantId: productFirst.tenantId },
      select: { type: true },
    })).toEqual({ type: "FUNERAL_COVER" })
    expect(await prisma.insurancePolicy.count({
      where: { clientId: productFirst.clientId, tenantId: productFirst.tenantId },
    })).toBe(0)
    await expectNotDisbursed(productFirst)
  }, 60_000)

  it("allows the current transaction order and freezes the completed evidence chain", async () => {
    const scenario = await createScenario("valid", true)
    const booked = await commitDisbursement(scenario)
    const policyId = booked.policyId!
    const where = { id: scenario.applicationId, tenantId: scenario.tenantId }

    expect(await prisma.loan.findUniqueOrThrow({
      where: { id: booked.loanId, tenantId: scenario.tenantId },
      select: { tenantId: true, clientId: true, applicationId: true },
    })).toEqual({
      tenantId: scenario.tenantId,
      clientId: scenario.clientId,
      applicationId: scenario.applicationId,
    })
    expect(await prisma.insurancePolicy.findUniqueOrThrow({
      where: { id: policyId, tenantId: scenario.tenantId },
      select: { tenantId: true, clientId: true, linkedLoanId: true, productId: true, policySource: true },
    })).toEqual({
      tenantId: scenario.tenantId,
      clientId: scenario.clientId,
      linkedLoanId: booked.loanId,
      productId: scenario.insuranceProductId,
      policySource: "BUNDLED_CREDIT_AGREEMENT",
    })

    // A second bundled policy passes the guard (its terms are valid) and is
    // refused by the one-per-loan unique index.
    const duplicate = await prisma.insurancePolicy.create({
      data: bundledPolicyData(scenario, booked),
    }).then(() => null, (error: unknown) => error)
    expect(duplicate).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect(duplicate).toMatchObject({ code: "P2002" })
    // Prisma names the columns, not the index; linkedLoanId alone is unique
    // only in InsurancePolicy_one_bundled_credit_life_per_loan.
    expect([(duplicate as Prisma.PrismaClientKnownRequestError).meta?.target].flat()).toEqual(["linkedLoanId"])
    expect(await prisma.$queryRawUnsafe<Array<{ name: string }>>(`
      SELECT i.indexrelid::regclass::TEXT AS name
      FROM pg_index AS i
      WHERE i.indrelid = '"InsurancePolicy"'::regclass
        AND i.indisunique
        AND i.indkey::TEXT = (
          SELECT attnum::TEXT FROM pg_attribute
          WHERE attrelid = '"InsurancePolicy"'::regclass AND attname = 'linkedLoanId'
        )
    `)).toEqual([{ name: '"InsurancePolicy_one_bundled_credit_life_per_loan"' }])

    await expect(prisma.insurancePolicy.update({
      where: { id: policyId, tenantId: scenario.tenantId },
      data: { linkedLoanId: null },
    })).rejects.toThrow(/agreement binding is immutable/i)

    await expect(prisma.loan.update({
      where: { id: booked.loanId, tenantId: scenario.tenantId },
      data: { agreementDocId: `different-${scenario.agreementDocumentId}` },
    })).rejects.toThrow(/requires the exact signed, verified, non-deleted agreement document/i)

    const signedEvidence = {
      agreementDocumentSha256: true,
      agreementSignedMethod: true,
      agreementSignedByIp: true,
      agreementSignatureData: true,
    } as const
    const evidenceBefore = await prisma.loanApplication.findUniqueOrThrow({ where, select: signedEvidence })

    // The provider-countersign guard refuses a DISBURSED row whose agreement
    // hash no longer matches the countersigned one, before any credit-life guard.
    await expect(prisma.loanApplication.update({
      where,
      data: { agreementDocumentSha256: "c".repeat(64) },
    })).rejects.toThrow(/loan disbursement requires provider countersign evidence bound to the exact tenant, consumer signature and agreement/i)
    expect(await prisma.loanApplication.findUniqueOrThrow({ where, select: signedEvidence }))
      .toEqual(evidenceBefore)

    // A multi-field rewrite trips the branch-signer guard first; it must
    // still be refused and change nothing.
    await expect(prisma.loanApplication.update({
      where,
      data: {
        agreementSignedMethod: "branch",
        agreementSignedByIp: "192.0.2.11",
        agreementSignatureData: "Rewritten signature",
      },
    })).rejects.toThrow(/branch agreement signing requires an active authorised witness from the application tenant/i)
    expect(await prisma.loanApplication.findUniqueOrThrow({ where, select: signedEvidence }))
      .toEqual(evidenceBefore)

    for (const data of [
      { verified: false },
      { mimeType: "text/plain" },
      { storagePath: null },
      { signatureState: null, signedAt: null },
    ]) {
      await expect(prisma.clientDocument.update({
        where: { id: scenario.agreementDocumentId, tenantId: scenario.tenantId },
        data,
      })).rejects.toThrow(/requires the exact signed, verified, non-deleted agreement document/i)
    }

    // The bound-agreement guard refuses retirement before the credit-life one.
    await expect(prisma.clientDocument.update({
      where: { id: scenario.agreementDocumentId, tenantId: scenario.tenantId },
      data: { deletedAt: new Date(booked.startDate.getTime() + 60 * 60_000) },
    })).rejects.toThrow(/a bound credit-agreement document may not be retired/i)
    expect(await prisma.clientDocument.findUniqueOrThrow({
      where: { id: scenario.agreementDocumentId, tenantId: scenario.tenantId },
      select: { deletedAt: true },
    })).toEqual({ deletedAt: null })

    // Statement-time, not only at commit: the AFTER trigger refuses before the
    // transaction body can go on.
    const sentinel = new Error("credit-life sentinel: the update was not refused")
    await expect(prisma.$transaction(async (tx) => {
      await tx.clientDocument.update({
        where: { id: scenario.agreementDocumentId, tenantId: scenario.tenantId },
        data: { verified: false },
      })
      throw sentinel
    })).rejects.toThrow(/requires the exact signed, verified, non-deleted agreement document/i)

    const artifact = await prisma.complianceRecord.findFirstOrThrow({
      where: { tenantId: scenario.tenantId, type: "AGREEMENT_ARTIFACT", referenceId: scenario.applicationId },
      select: { id: true, data: true },
    })
    await expect(prisma.complianceRecord.update({
      where: { id: artifact.id, tenantId: scenario.tenantId },
      data: {
        data: {
          ...(artifact.data as Prisma.JsonObject),
          creditLifeAutoBundleEligible: false,
        },
      },
    })).rejects.toThrow(/completed credit-agreement artifacts are immutable/i)

    await expect(prisma.complianceRecord.delete({
      where: { id: artifact.id, tenantId: scenario.tenantId },
    })).rejects.toThrow(/completed credit-agreement artifacts are immutable/i)

    await expect(prisma.insuranceProduct.update({
      where: { id: scenario.insuranceProductId!, tenantId: scenario.tenantId },
      data: { type: "FUNERAL_COVER" },
    })).rejects.toThrow(/product identity and type are immutable/i)

    for (const data of [
      { premiumAmount: -1 },
      { premiumAmount: 0 },
      { premiumAmount: 22.49 },
      { sumAssured: -1 },
      { sumAssured: 0 },
      { sumAssured: 4_999 },
      { startDate: new Date(booked.startDate.getTime() + DAY_MS) },
      { renewalDate: new Date(booked.startDate.getTime() - DAY_MS) },
    ]) {
      await expect(prisma.insurancePolicy.update({
        where: { id: policyId, tenantId: scenario.tenantId },
        data,
      })).rejects.toThrow(/binding is immutable/i)
    }

    for (const data of [
      { principal: scenario.pasqEvidence.calculator.principalCents + 100 },
      { startDate: new Date(booked.startDate.getTime() + DAY_MS) },
      { maturityDate: new Date(booked.maturityDate.getTime() + DAY_MS) },
    ]) {
      await expect(prisma.loan.update({
        where: { id: booked.loanId, tenantId: scenario.tenantId },
        data,
      })).rejects.toThrow(/terms must match the frozen loan/i)
    }

    await expect(prisma.insurancePolicy.update({
      where: { id: policyId, tenantId: scenario.tenantId },
      data: { status: "LAPSED" },
    })).resolves.toMatchObject({ status: "LAPSED" })

    await expect(prisma.insurancePolicy.delete({
      where: { id: policyId, tenantId: scenario.tenantId },
    })).rejects.toThrow(/cannot be hard-deleted/i)

    expect(await prisma.insurancePolicy.count({
      where: { id: policyId, tenantId: scenario.tenantId, linkedLoanId: booked.loanId },
    })).toBe(1)
  }, 60_000)

  it("freezes the signer IP of an EFT loan once its bundled policy is bound", async () => {
    // EFT carries no debit mandate, so the signed-mandate authority guard does
    // not refuse the IP first, as it does on a debit-order application.
    const scenario = await createScenario("valid-eft", true, "EFT")
    const booked = await commitDisbursement(scenario)
    expect(booked.policyId).toEqual(expect.any(String))
    const where = { id: scenario.applicationId, tenantId: scenario.tenantId }
    const before = await prisma.loanApplication.findUniqueOrThrow({
      where,
      select: { agreementSignedByIp: true },
    })

    await expect(prisma.loanApplication.update({
      where,
      data: { agreementSignedByIp: "192.0.2.11" },
    })).rejects.toThrow(/signed agreement evidence is immutable/i)
    expect(await prisma.loanApplication.findUniqueOrThrow({
      where,
      select: { agreementSignedByIp: true },
    })).toEqual(before)
  }, 60_000)

  it("leaves a loan on a never-approved application bookable, but not one on an approved application", async () => {
    // As the demo seed books its loan: a DRAFT application, no agreement.
    const tenantId = `tenant_credit_life_draft_${token}`
    const productId = `loan_product_credit_life_draft_${token}`
    await prisma.tenant.create({
      data: { id: tenantId, slug: `credit-life-draft-${token}`, name: "Credit life draft" },
    })
    await prisma.loanProduct.create({
      data: {
        id: productId,
        tenantId,
        code: `CL-DRAFT-${token}`,
        name: "Credit life draft loan",
        productType: "MICRO",
        minAmount: 100_000,
        maxAmount: 1_000_000,
        minTermDays: 1,
        maxTermDays: 365,
        interestRatePm: 0.05,
        interestModel: "DAILY_ACCRUAL",
      },
    })
    const officerId = `officer_credit_life_draft_${token}`
    await prisma.user.create({
      data: {
        id: officerId,
        tenantId,
        email: `credit-life-draft-officer-${token}@example.invalid`,
        password: "not-a-real-login",
        name: "Synthetic Officer",
        role: "LOAN_ADMIN",
      },
    })
    const startDate = new Date("2026-07-22T00:00:00.000Z")
    const loanData = (applicationId: string, scenarioTenantId: string, scenarioClientId: string, loanProductId: string) => ({
      tenantId: scenarioTenantId,
      reference: `LOAN-${randomUUID()}`,
      applicationId,
      clientId: scenarioClientId,
      productId: loanProductId,
      principal: 500_000,
      totalInterest: 10_000,
      initiationFee: 0,
      totalRepayable: 510_000,
      outstandingPrincipal: 500_000,
      startDate,
      maturityDate: new Date(startDate.getTime() + 30 * DAY_MS),
      interestRatePm: 0.05,
      interestModel: "DAILY_ACCRUAL" as const,
      monthlyServiceFee: 0,
    })

    for (const status of ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] as const) {
      const clientId = `client_credit_life_${status.toLowerCase()}_${token}`
      await prisma.client.create({
        data: {
          id: clientId,
          tenantId,
          reference: `CLIENT-${status}-${token}`,
          idNumber: `ID-${status}-${token}`,
          firstName: "Synthetic",
          lastName: status,
          email: `credit-life-${status.toLowerCase()}-${token}@example.invalid`,
          phone: "+27820000002",
        },
      })
      const application = await prisma.loanApplication.create({
        data: {
          tenantId,
          reference: `APP-${status}-${token}`,
          clientId,
          productId,
          appliedAmount: 500_000,
          appliedTermDays: 30,
          status,
        },
        select: { id: true },
      })
      await expect(prisma.$transaction(async (tx) => {
        const loan = await tx.loan.create({ data: loanData(application.id, tenantId, clientId, productId) })
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
        return loan
      })).resolves.toMatchObject({ applicationId: application.id })

      // Such an application cannot then leave review (the decide route maps
      // this exact message to a 409 on decline).
      await expect(prisma.$transaction(async (tx) => {
        await tx.loanApplication.update({
          where: { id: application.id, tenantId },
          data: { status: "DECLINED", approvedAt: new Date(), approvedById: officerId },
        })
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      })).rejects.toThrow(/loan creation and application disbursement must commit together/i)
      expect(await prisma.loanApplication.findUniqueOrThrow({
        where: { id: application.id, tenantId },
        select: { status: true },
      })).toEqual({ status })
    }

    // APPROVED stays in scope: a loan without the DISBURSED transition is refused.
    const approved = await createScenario("approved-loan-only", true)
    await expect(prisma.$transaction(async (tx) => {
      await tx.loan.create({
        data: {
          ...loanData(approved.applicationId, approved.tenantId, approved.clientId, approved.productId),
          agreementDocId: approved.agreementDocumentId,
        },
      })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })).rejects.toThrow(/loan creation and application disbursement must commit together/i)
    await expectNotDisbursed(approved)
  }, 60_000)

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
