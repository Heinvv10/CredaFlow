/**
 * Base demo seed: one demo lender (DEMO_LENDER, default the neutral "Acme"
 * from the identity test fixture; prisma/demo-lender.ts) on an empty database
 * migrated with the baseline.
 *
 * It seeds only states the database's own guards accept without compliance
 * evidence. Approval needs an acknowledged PASQ and a credit-life product;
 * disbursement needs a signed agreement, a countersignature and (for debit
 * orders) a mandate. None of that is fabricated here, so there are no APPROVED
 * or DISBURSED consumer applications. The one demo consumer loan is booked
 * directly against its still-DRAFT application, the way the real-DB
 * integration fixtures do (lib/loan/charges.integration-fixture.ts).
 *
 * Asset finance (./seed/asset-finance.ts) is the exception, by design: its
 * NON_NCA company deal is approved, disbursed and booked through the
 * asset-finance lib functions themselves, with the four-eyes approvals and
 * synthetic evidence documents those functions and the database require.
 *
 * Idempotent: every row is upserted or skipped when present.
 */
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"
import { randomBytes } from "node:crypto"
import { calculateLoan } from "../lib/loan-calculator"
import { seedDefaultMessageTemplates } from "../lib/messaging/default-templates"
import { generateTotpSecret, generateTotpUri } from "../lib/totp"
import { demoLender } from "./demo-lender"
import { catalogueHash } from "../lib/i18n/catalogue-hash"

// Demo data with known passwords must never reach a production database.
// Checked before any client exists; ./seed-document-templates is imported
// lazily below because importing lib/prisma starts a keep-alive in production.
if (process.env.NODE_ENV === "production") {
  process.stderr.write("Seed refused: NODE_ENV=production. The demo seed is for local and throwaway databases only.\n")
  process.exit(1)
}

const prisma = new PrismaClient()
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS)

const LENDER = demoLender()
const BRAND = LENDER.identity.brandName
const STAFF_DOMAIN = LENDER.staffDomain
// Demo passwords are never in source. SEED_ADMIN_PASSWORD, SEED_OFFICER_PASSWORD,
// SEED_LOAN_ADMIN_{ONE,TWO}_PASSWORD, SEED_PORTAL_PASSWORD and the asset-finance
// SEED_AF_{DIRECTOR,SURETY}_PASSWORD set them (on every run);
// unset, a random one is generated when the row is first created and a rerun
// keeps it. TOTP is mandatory for staff, so each staff user also gets a secret
// generated on first creation. Credentials are printed only with
// SEED_PRINT_CREDENTIALS=1, so they stay out of CI logs.
const kept = (env: string) => `(unchanged; rerun with ${env}=… to reset it)`
const envPassword = (name: string) => process.env[name] || undefined
const generatePassword = () => `Demo-${randomBytes(12).toString("base64url")}!`
const SEED_LOAN_REFERENCE = "LN-SEED-0001"

/**
 * A staff user with TOTP enrolled exactly as POST /api/settings/totp stores
 * it: the base32 secret in `totpSecret`, `totpEnabled = true`. A rerun keeps
 * an existing secret so an authenticator already set up keeps working.
 */
async function upsertStaff(tenantId: string, email: string, name: string, role: "ADMIN" | "LOAN_ADMIN" | "CREDIT_OFFICER", passwordEnv: string) {
  const existing = await prisma.user.findUnique({ where: { email }, select: { tenantId: true, totpSecret: true } })
  // email is globally unique: on a shared database the write below would
  // otherwise rewrite another tenant's user (password, tenantId).
  if (existing && existing.tenantId !== tenantId) {
    throw new Error(`Seed refused: user ${email} belongs to another tenant (${existing.tenantId ?? "none"}). The demo seed never rewrites another tenant's row.`)
  }
  const totpSecret = existing?.totpSecret ?? generateTotpSecret()
  const password = envPassword(passwordEnv)
  const fields = { tenantId, active: true, totpSecret, totpEnabled: true }
  if (existing) {
    const user = await prisma.user.update({
      where: { email },
      data: { ...fields, ...(password ? { password: await bcrypt.hash(password, 12) } : {}) },
    })
    return { user, password: password ?? kept(passwordEnv), totpSecret, otpauth: generateTotpUri(email, totpSecret, BRAND) }
  }
  const created = password ?? generatePassword()
  const user = await prisma.user.create({ data: { ...fields, email, name, role, password: await bcrypt.hash(created, 12) } })
  return { user, password: created, totpSecret, otpauth: generateTotpUri(email, totpSecret, BRAND) }
}

// ⚠️ EVERY client email MUST stay on a `.invalid` domain. Demo data with
// plausible public addresses, on a box carrying a live SMTP sender, would email
// members of the public as if they were borrowers — payment reminders on cron,
// and full NCA Section 129 statutory demands for debts that do not exist. A
// synthetic loan reference does not make the recipient synthetic. `.invalid` is reserved by RFC 2606 and can never
// resolve, so it fails closed at DNS.
//
// KYC stays PENDING: the seed never claims a biometric or document
// verification that did not happen. ID numbers are synthetic but pass
// isValidSaIdNumber (lib/validation/client-wizard.ts).
const CLIENTS = [
  { firstName: "Sipho", lastName: "Nkosi", idNumber: "8503015000081", dob: "1985-03-01", gender: "MALE", phone: "+27761234501", income: 2_800_000, expenses: 1_200_000, bank: "FNB", acc: "62000012345", branch: "250655", city: "Johannesburg", prov: "Gauteng", postal: "2001" },
  { firstName: "Nomvula", lastName: "Dlamini", idNumber: "9205010000087", dob: "1992-05-01", gender: "FEMALE", phone: "+27821234502", income: 1_850_000, expenses: 900_000, bank: "Standard Bank", acc: "001234567", branch: "051001", city: "Soweto", prov: "Gauteng", postal: "1804" },
  { firstName: "Bongani", lastName: "Zulu", idNumber: "7812015000087", dob: "1978-12-01", gender: "MALE", phone: "+27741234503", income: 4_500_000, expenses: 2_100_000, bank: "Capitec", acc: "1357924680", branch: "470010", city: "Germiston", prov: "Gauteng", postal: "1401" },
  { firstName: "Thandi", lastName: "Mthembu", idNumber: "9401010000082", dob: "1994-01-01", gender: "FEMALE", phone: "+27831234504", income: 2_100_000, expenses: 850_000, bank: "Nedbank", acc: "1986543210", branch: "198765", city: "Pretoria", prov: "Gauteng", postal: "0083" },
  { firstName: "Lungelo", lastName: "Khumalo", idNumber: "8806015000088", dob: "1988-06-01", gender: "MALE", phone: "+27711234505", income: 3_200_000, expenses: 1_400_000, bank: "ABSA", acc: "4072345678", branch: "632005", city: "Durban", prov: "KwaZulu-Natal", postal: "4031" },
] as const

const PRODUCTS = [
  // Fixed 30-day term (min == max): the Apply form hides the term field.
  { code: "MICRO30", name: "30-Day Micro Loan", productType: "MICRO", minAmount: 50_000, maxAmount: 200_000, minTermDays: 30, maxTermDays: 30, interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL", initiationFeePct: 0.15, initiationFeeMax: 100_000, monthlyServiceFee: 6_900 },
  { code: "PERSONAL", name: "Personal Loan", productType: "PERSONAL", minAmount: 500_000, maxAmount: 10_000_000, minTermDays: 90, maxTermDays: 1_800, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeePct: 0.165, initiationFeeMax: 108_000, monthlyServiceFee: 6_900 },
  { code: "POFUND", name: "Purchase Order Funding", productType: "PO_FUNDING", minAmount: 1_000_000, maxAmount: 50_000_000, minTermDays: 30, maxTermDays: 120, interestRatePm: 0.025, interestModel: "DAILY_ACCRUAL", initiationFeePct: 0.02, initiationFeeMax: 0, monthlyServiceFee: 0 },
] as const

async function main() {
  console.log(`Seeding ${BRAND} demo data...`)

  const tenant = await prisma.tenant.upsert({
    where: { slug: LENDER.slug },
    update: {},
    create: { slug: LENDER.slug, name: BRAND, status: "ACTIVE" },
  })
  const config = {
    ...LENDER.identity,
    ...LENDER.colours,
    featureLms: true,
    featurePortal: true,
    featureReports: true,
    featureAssetFinance: true,
    // The demo shows every borrower language. A real lender starts on English
    // only (the column default) until its translations are reviewed.
    enabledLanguages: ["en", "af", "zu", "xh"],
    // A language is served only with a review record of its current text
    // (lib/i18n/language-reviews.ts). DEMO ONLY: these records say plainly
    // that nobody reviewed the drafts. Never copy them to, or seed them for, a
    // real lender: there a named native speaker reviews each language and a
    // Super Admin acknowledges it under Settings -> Borrower languages.
    languageReviews: Object.fromEntries((["af", "zu", "xh"] as const).map((locale) => [locale, {
      reviewer: "Not reviewed: synthetic demo tenant showing machine drafts",
      acknowledgedAt: "2026-10-14T00:00:00.000Z",
      acknowledgedById: null,
      acknowledgedByEmail: null,
      catalogueHash: catalogueHash(locale),
    }])),
  }
  await prisma.tenantConfig.upsert({
    where: { tenantId: tenant.id },
    update: config,
    create: { tenantId: tenant.id, ...config },
  })

  const { seedDocumentTemplates } = await import("./seed-document-templates")
  await seedDocumentTemplates(tenant.id)
  await seedDefaultMessageTemplates(prisma, tenant.id, BRAND)

  const admin = await upsertStaff(tenant.id, `admin@${STAFF_DOMAIN}`, "Demo Admin", "ADMIN", "SEED_ADMIN_PASSWORD")
  const officer = await upsertStaff(tenant.id, `credit.officer@${STAFF_DOMAIN}`, "Demo Credit Officer", "CREDIT_OFFICER", "SEED_OFFICER_PASSWORD")
  // Two loan admins: asset-finance four-eyes steps need a second approver.
  const loanAdminOne = await upsertStaff(tenant.id, `loan.admin.one@${STAFF_DOMAIN}`, "Demo Loan Admin One", "LOAN_ADMIN", "SEED_LOAN_ADMIN_ONE_PASSWORD")
  const loanAdminTwo = await upsertStaff(tenant.id, `loan.admin.two@${STAFF_DOMAIN}`, "Demo Loan Admin Two", "LOAN_ADMIN", "SEED_LOAN_ADMIN_TWO_PASSWORD")

  const products: Record<string, { id: string }> = {}
  for (const p of PRODUCTS) {
    products[p.code] = await prisma.loanProduct.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: p.code } },
      update: {},
      create: { tenantId: tenant.id, ...p, active: true },
    })
  }

  // One portal password for every seeded client. Generated only if a client
  // is created this run; an existing client keeps its password unless
  // SEED_PORTAL_PASSWORD is set.
  const portalEnv = envPassword("SEED_PORTAL_PASSWORD")
  const portalPassword = portalEnv ?? generatePassword()
  const portalHash = await bcrypt.hash(portalPassword, 12)
  let portalPasswordUsed = false
  const clients: { id: string; income: number; expenses: number }[] = []
  for (const [i, c] of CLIENTS.entries()) {
    const email = `${c.firstName}.${c.lastName}@${LENDER.clientDomain}`.toLowerCase()
    // idNumber is globally unique: refuse rather than rewrite another tenant's client.
    const existing = await prisma.client.findUnique({ where: { idNumber: c.idNumber }, select: { tenantId: true } })
    if (existing && existing.tenantId !== tenant.id) {
      throw new Error(`Seed refused: client with ID number ${c.idNumber} belongs to another tenant (${existing.tenantId}). The demo seed never rewrites another tenant's row.`)
    }
    const row = await prisma.client.upsert({
      // idNumber is the stable identifier across seed revisions.
      where: { idNumber: c.idNumber },
      update: { ...(portalEnv ? { portalPassword: portalHash } : {}), email },
      create: {
        tenantId: tenant.id,
        reference: `CLI-SEED-${String(i + 1).padStart(4, "0")}`,
        idNumber: c.idNumber, firstName: c.firstName, lastName: c.lastName,
        dateOfBirth: new Date(c.dob), gender: c.gender,
        email, phone: c.phone, whatsapp: c.phone,
        addressLine1: `${10 + i} Main Road`, city: c.city, province: c.prov, postalCode: c.postal,
        employmentStatus: "EMPLOYED", employerName: "Example Employer (Pty) Ltd",
        monthlyIncome: c.income, monthlyExpenses: c.expenses,
        bankName: c.bank, bankAccountNumber: c.acc, bankBranchCode: c.branch, accountType: "SAVINGS",
        kycStatus: "PENDING",
        portalPassword: portalHash,
      },
    })
    if (portalEnv || row.portalPassword === portalHash) portalPasswordUsed = true
    clients.push({ id: row.id, income: c.income, expenses: c.expenses })
  }

  // Applications in the states the guards allow without evidence. One per
  // client and product: an open application is unique per (client, product).
  const apps = [
    { ref: "APP-SEED-0001", client: 0, product: "MICRO30", amount: 150_000, term: 30, purpose: "Emergency medical expenses", status: "SUBMITTED", dca: 1 },
    { ref: "APP-SEED-0002", client: 1, product: "PERSONAL", amount: 2_500_000, term: 365, purpose: "Home improvements", status: "UNDER_REVIEW", dca: 4 },
    { ref: "APP-SEED-0003", client: 2, product: "PERSONAL", amount: 9_000_000, term: 1_800, purpose: "Property purchase", status: "DECLINED", dca: 9, reason: "Debt-to-income ratio exceeds the 40% threshold" },
  ] as const
  for (const a of apps) {
    const createdAt = daysAgo(a.dca)
    await prisma.loanApplication.upsert({
      where: { reference: a.ref },
      update: {},
      create: {
        tenantId: tenant.id, reference: a.ref, clientId: clients[a.client].id, productId: products[a.product].id,
        appliedAmount: a.amount, appliedTermDays: a.term, purpose: a.purpose, status: a.status,
        submittedAt: createdAt, createdAt, updatedAt: createdAt,
        assignedToId: a.status === "SUBMITTED" ? null : officer.user.id,
        ...("reason" in a ? { decisionReason: a.reason } : {}),
      },
    })
  }

  await seedLoan(tenant.id, clients[3].id, products.PERSONAL.id)

  // Imported here, not at the top: it imports lib/prisma (see seed-document-templates above).
  const { seedAssetFinance } = await import("./seed/asset-finance")
  const actor = (s: { user: { id: string; email: string } }) => ({ id: s.user.id, email: s.user.email })
  await seedAssetFinance(tenant.id, { officer: actor(officer), adminOne: actor(loanAdminOne), adminTwo: actor(loanAdminTwo) })

  console.log(`\nSeed complete: tenant "${LENDER.slug}" (${BRAND}).`)
  if (process.env.SEED_PRINT_CREDENTIALS !== "1") {
    console.log("Credentials not printed. Generated passwords show only with SEED_PRINT_CREDENTIALS=1 on the run that creates the rows; set SEED_ADMIN_PASSWORD, SEED_OFFICER_PASSWORD, SEED_LOAN_ADMIN_ONE_PASSWORD, SEED_LOAN_ADMIN_TWO_PASSWORD and SEED_PORTAL_PASSWORD to choose or reset them.")
    return
  }
  for (const s of [admin, officer, loanAdminOne, loanAdminTwo]) {
    console.log(`\n  ${s.user.role}: ${s.user.email}\n    password: ${s.password}\n    TOTP secret (base32): ${s.totpSecret}\n    otpauth: ${s.otpauth}`)
  }
  console.log(`\n  Client portal password (seeded clients created or reset this run): ${portalPasswordUsed ? portalPassword : kept("SEED_PORTAL_PASSWORD")}`)
}

/**
 * LN-SEED-0001: an ACTIVE R10,000 personal loan, 180 days, booked 10 days ago,
 * schedule from the real amortiser. Created in one transaction, so a rerun
 * either finds the whole loan or none of it.
 */
async function seedLoan(tenantId: string, clientId: string, productId: string) {
  if (await prisma.loan.findUnique({ where: { reference: SEED_LOAN_REFERENCE } })) return
  const product = await prisma.loanProduct.findUniqueOrThrow({ where: { id: productId } })
  const principal = 1_000_000
  const termDays = 180
  const startDate = daysAgo(10)
  const calc = calculateLoan({
    productType: product.productType,
    principal,
    termDays,
    interestRatePm: product.interestRatePm,
    interestModel: product.interestModel,
    initiationFeeModel: product.initiationFeeModel,
    initiationFeePct: product.initiationFeePct,
    initiationFeeMax: product.initiationFeeMax,
    monthlyServiceFee: product.monthlyServiceFee,
  }, startDate)

  await prisma.$transaction(async (tx) => {
    const app = await tx.loanApplication.create({
      data: {
        tenantId, reference: "APP-SEED-0004", clientId, productId,
        appliedAmount: principal, appliedTermDays: termDays, purpose: "Vehicle repairs",
        createdAt: daysAgo(14),
      },
    })
    const loan = await tx.loan.create({
      data: {
        tenantId, reference: SEED_LOAN_REFERENCE, applicationId: app.id, clientId, productId,
        principal, totalInterest: calc.totalInterest, initiationFee: calc.initiationFee,
        totalRepayable: calc.totalRepayable, outstandingPrincipal: principal,
        startDate, maturityDate: calc.schedule.at(-1)!.dueDate, nextPaymentDate: calc.schedule[0].dueDate,
        interestRatePm: product.interestRatePm, interestModel: product.interestModel,
        monthlyServiceFee: product.monthlyServiceFee, status: "ACTIVE", createdAt: startDate,
      },
    })
    await tx.repaymentSchedule.createMany({
      data: calc.schedule.map((row) => ({
        tenantId, loanId: loan.id, installmentNo: row.installmentNo, dueDate: row.dueDate,
        principalDue: row.principalDue, interestDue: row.interestDue, feesDue: row.feesDue, totalDue: row.totalDue,
      })),
    })
    if (process.env.NODE_ENV === "test" && process.env.SEED_FAIL_AFTER_SCHEDULES_FOR_REFERENCE === SEED_LOAN_REFERENCE) {
      throw new Error(`${SEED_LOAN_REFERENCE}: injected failure after schedule creation`)
    }
  })
}

main()
  .catch((e) => {
    process.stderr.write(`Seed error: ${String(e)}\n`)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
