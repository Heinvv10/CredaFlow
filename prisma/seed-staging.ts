/**
 * Workflow-coverage demo data on top of prisma/seed.ts: branches, insurers,
 * an attorney firm, client budget detail, CRM leads, a complaint, a DSAR, a
 * breach-log drill and an automation rule.
 *
 * Only records that describe something real about the demo itself. Nothing
 * here claims a document was verified, a message or notice was sent, a policy
 * was sold or a compliance step completed — the database guards those with
 * evidence the seed does not have, and faking it would defeat the guards.
 */
import { PrismaClient } from "@prisma/client"

if (process.env.NODE_ENV === "production") {
  process.stderr.write("Seed refused: NODE_ENV=production. The demo seed is for local and throwaway databases only.\n")
  process.exit(1)
}

const prisma = new PrismaClient()
const DAY_MS = 24 * 60 * 60 * 1000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS)
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS)
const STAFF_DOMAIN = "acme-lending.example"

async function ensureOne<T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  return (await find()) ?? create()
}

async function main() {
  console.log("Seeding staging workflow coverage...")

  const tenant = await prisma.tenant.findUnique({ where: { slug: "acme" } })
  if (!tenant) throw new Error("Run prisma/seed.ts before prisma/seed-staging.ts")
  // Every lookup is scoped to the Acme tenant: on a shared database a global
  // key (email, reference) can name another tenant's row.
  const officer = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: `credit.officer@${STAFF_DOMAIN}` } })
  const admin = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: `admin@${STAFF_DOMAIN}` } })
  if (!officer || !admin) throw new Error("Base demo users are missing; run prisma/seed.ts first")
  const clients = await prisma.client.findMany({ where: { tenantId: tenant.id }, orderBy: { reference: "asc" } })
  const loan = await prisma.loan.findFirst({ where: { tenantId: tenant.id, reference: "LN-SEED-0001" } })
  if (clients.length < 3 || !loan) throw new Error("Base demo data is incomplete; run prisma/seed.ts first")

  const branches = [
    { code: "HQ", name: "Head Office", address: "1 Main Road, Sandton, 2196", phone: "+27 11 000 0000" },
    { code: "DBN", name: "Durban Client Desk", address: "2 Harbour Road, Durban, 4001", phone: "+27 31 000 0000" },
  ]
  const seededBranches = []
  for (const branch of branches) {
    seededBranches.push(await prisma.branch.upsert({
      where: { tenantId_code: { tenantId: tenant.id, code: branch.code } },
      update: {},
      create: { ...branch, tenantId: tenant.id, managerId: admin.id },
    }))
  }
  await prisma.user.updateMany({ where: { id: { in: [admin.id, officer.id] } }, data: { branchId: seededBranches[0].id } })
  for (const [i, client] of clients.entries()) {
    await prisma.client.update({ where: { id: client.id }, data: { branchId: seededBranches[i % seededBranches.length].id } })
  }

  // Fictional insurers, so a policy can be captured through the UI. No policy
  // is seeded: a standalone policy needs a FAIS disclosure and a bundled one
  // needs a credit-life election, neither of which exists.
  const insurers = [
    { name: "Example Life Assurance", fspNumber: "FSP00001", contactName: "Demo Contact", contactEmail: "life@insurer.invalid" },
    { name: "Example Short-Term Insurance", fspNumber: "FSP00002", contactName: "Demo Contact", contactEmail: "shortterm@insurer.invalid" },
  ]
  for (const insurer of insurers) {
    await ensureOne(
      () => prisma.insurer.findFirst({ where: { tenantId: tenant.id, name: insurer.name } }),
      () => prisma.insurer.create({ data: { ...insurer, tenantId: tenant.id, contactPhone: "+27 10 000 0100", active: true } }),
    )
  }

  await ensureOne(
    () => prisma.attorneyFirm.findFirst({ where: { tenantId: tenant.id, name: "Example Attorneys Inc." } }),
    () => prisma.attorneyFirm.create({
      data: {
        tenantId: tenant.id,
        name: "Example Attorneys Inc.",
        contactPerson: "Demo Attorney",
        phone: "+27 11 000 0188",
        email: "collections@attorneys.invalid",
        address: "3 Court Street, Johannesburg",
        specialisation: "NCA collections and civil recoveries",
      },
    }),
  )

  // Client-declared budget detail (input to affordability, not evidence of it).
  for (const client of clients.slice(0, 3)) {
    await prisma.clientExpenseBreakdown.upsert({
      where: { clientId: client.id },
      update: {},
      create: {
        clientId: client.id, housing: 650_000, transport: 240_000, food: 360_000, education: 95_000,
        insurance: 120_000, clothing: 80_000, entertainment: 50_000, medical: 60_000, other: 90_000,
      },
    })
    await ensureOne(
      () => prisma.existingDebtObligation.findFirst({ where: { clientId: client.id, creditProvider: "Demo Retail Credit" } }),
      () => prisma.existingDebtObligation.create({
        data: { clientId: client.id, creditProvider: "Demo Retail Credit", accountType: "Retail account", outstandingBalance: 1_200_000, monthlyInstalment: 180_000 },
      }),
    )
  }

  const leads = [
    { firstName: "Karabo", lastName: "Mockery", phone: "+27730000001", source: "WEBSITE", status: "NEW", score: 72 },
    { firstName: "Anika", lastName: "Naidoo", phone: "+27730000002", source: "WHATSAPP", status: "CONTACTED", score: 81 },
    { firstName: "Musa", lastName: "Radebe", phone: "+27730000003", source: "REFERRAL", status: "QUALIFIED", score: 88 },
    { firstName: "Lwazi", lastName: "Mokoena", phone: "+27730000005", source: "SOCIAL", status: "LOST", score: 39 },
  ] as const
  for (const lead of leads) {
    const row = await ensureOne(
      () => prisma.lead.findFirst({ where: { tenantId: tenant.id, phone: lead.phone } }),
      () => prisma.lead.create({
        data: {
          tenantId: tenant.id,
          firstName: lead.firstName,
          lastName: lead.lastName,
          email: `${lead.firstName.toLowerCase()}@lead.invalid`,
          phone: lead.phone,
          source: lead.source,
          status: lead.status,
          assignedToId: officer.id,
          notes: "Seeded demo lead for CRM workflow testing.",
          tags: ["demo"],
          callbackDate: daysFromNow(2),
          callbackNotes: "Discuss loan fit and required documents.",
          employmentType: "SALARIED",
          declaredIncome: 2_850_000,
          requestedAmount: 2_500_000,
          leadScore: lead.score,
          scoreCalculatedAt: daysAgo(1),
          lostReason: lead.status === "LOST" ? "NO_RESPONSE" : null,
        },
      }),
    )
    if (lead.status === "NEW") continue
    await ensureOne(
      () => prisma.crmActivity.findFirst({ where: { tenantId: tenant.id, leadId: row.id, subject: "Initial affordability call" } }),
      () => prisma.crmActivity.create({
        data: {
          tenantId: tenant.id, leadId: row.id, type: "CALL", subject: "Initial affordability call",
          notes: "Confirmed need, income band and preferred contact channel.", completedAt: daysAgo(1), createdById: officer.id,
        },
      }),
    )
  }

  await ensureOne(
    () => prisma.crossSellOpportunity.findFirst({ where: { tenantId: tenant.id, clientId: clients[0].id, type: "FUNERAL_COVER" } }),
    () => prisma.crossSellOpportunity.create({
      data: { tenantId: tenant.id, clientId: clients[0].id, type: "FUNERAL_COVER", status: "INTERESTED", assignedToId: officer.id, notes: "Client asked about cover options." },
    }),
  )

  await ensureOne(
    () => prisma.loanNote.findFirst({ where: { tenantId: tenant.id, loanId: loan.id, type: "general" } }),
    () => prisma.loanNote.create({
      data: { tenantId: tenant.id, loanId: loan.id, type: "general", note: "Demo note: seeded loan for walkthroughs.", createdBy: officer.id },
    }),
  )

  await ensureOne(
    () => prisma.complaint.findFirst({ where: { tenantId: tenant.id, reference: "CMP-SEED-0001" } }),
    () => prisma.complaint.create({
      data: {
        tenantId: tenant.id, clientId: clients[0].id, reference: "CMP-SEED-0001", category: "COLLECTIONS_CONDUCT",
        description: "Client disputes the tone and timing of a reminder call.", status: "UNDER_INVESTIGATION",
        assignedToId: admin.id, acknowledgedAt: daysAgo(1), createdById: admin.id,
      },
    }),
  )
  await prisma.dataSubjectRequest.upsert({
    where: { reference: "DSAR-SEED-0001" },
    update: {},
    create: {
      tenantId: tenant.id, clientId: clients[1].id, reference: "DSAR-SEED-0001", type: "ACCESS",
      description: "Client requested a copy of the personal information held about them.",
      status: "IN_PROGRESS", dueDate: daysFromNow(21),
    },
  })
  await ensureOne(
    // BreachLog has no tenantId; the Acme admin who logs the drill scopes it.
    () => prisma.breachLog.findFirst({ where: { createdBy: admin.id, description: "Demo mailbox exposure drill." } }),
    () => prisma.breachLog.create({
      data: {
        incidentDate: daysAgo(6), discoveredDate: daysAgo(5), description: "Demo mailbox exposure drill.",
        affectedClients: 0, dataCategories: "Contact details", containmentAction: "Drill only; no client data involved.",
        status: "OPEN", createdBy: admin.id,
      },
    }),
  )

  await ensureOne(
    () => prisma.automationRule.findFirst({ where: { tenantId: tenant.id, name: "Demo: DPD 30 collections task" } }),
    () => prisma.automationRule.create({
      data: {
        tenantId: tenant.id,
        name: "Demo: DPD 30 collections task",
        description: "Creates a collections task when a loan crosses 30 days past due.",
        trigger: "DPD_THRESHOLD",
        condition: { daysPastDue: 30 },
        action: "CREATE_AGENT_TASK",
        actionConfig: { priority: "HIGH", queue: "collections" },
        enabled: true,
      },
    }),
  )

  console.log("Staging seed complete: branches, insurers, attorney firm, budgets, CRM, complaint, DSAR, breach drill, automation rule.")
}

main()
  .catch((error) => {
    process.stderr.write(`Staging seed error: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
