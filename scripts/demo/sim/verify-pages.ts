/**
 * Loads the app's server-rendered pages the way a browser does (GET, HTML)
 * and reports any that do not answer 200 with a page — the check that a
 * bake's data renders, not just that it exists.
 *
 *   - staff: every page in the dashboard navigation (lib/navigation.ts
 *     `staffNavigation`, the list AppSidebar renders), the module sub-pages
 *     linked from them, and detail pages sampled from the data (one per loan
 *     status and collections stage, per application status, and one lead,
 *     contact, client and insurance policy), signed in as ADMIN;
 *   - portal: every page in the client navigation (`buildPortalNavigation`)
 *     plus the client's loan, application and policy pages, signed in as a
 *     borrower with a loan and a policy.
 *
 *   npx tsx scripts/demo/sim/verify-pages.ts
 */
import { buildPortalNavigation, staffNavigation } from "../../../lib/navigation"
import { SimClient } from "./api"
import { readSeedCredentials } from "./credentials"
import { log } from "./env"
import { verifyPageResponse } from "./verify-page-response"
import { closeReadDb, readDb } from "./readonly-db"

/** Pages reached from a nav page rather than from the sidebar itself. */
const SUB_PAGES = [
  "/crm/leads/queue", "/crm/re-engagement", "/inbox/reconciliation",
  "/compliance/breach-log", "/compliance/coi", "/compliance/tcf", "/compliance/fsca-return", "/compliance/bureau-overrides",
  "/reports/arrears-aging", "/reports/default-charges", "/reports/advisor",
  "/settings/branches", "/settings/insurers", "/settings/insurance", "/settings/products/insurance", "/settings/email/logs",
]

type Row = { id: string }

async function ids(sql: string): Promise<string[]> {
  return (await readDb().$queryRawUnsafe<Row[]>(sql)).map((r) => r.id)
}

async function staffDetailPages(): Promise<string[]> {
  const loans = await ids(`SELECT DISTINCT ON (status, "collectionsStage") id FROM "Loan" ORDER BY status, "collectionsStage", "createdAt"`)
  const apps = await ids(`SELECT DISTINCT ON (status) id FROM "LoanApplication" ORDER BY status, "createdAt"`)
  const arrears = await ids(`SELECT id FROM "Loan" WHERE "daysInArrears" > 0 AND status IN ('ACTIVE','DEFAULTED') ORDER BY "daysInArrears" LIMIT 3`)
  const leads = await ids(`SELECT DISTINCT ON (status) id FROM "Lead" ORDER BY status, "createdAt"`)
  const one = async (table: string): Promise<string[]> => ids(`SELECT id FROM "${table}" ORDER BY "createdAt" LIMIT 1`)
  const productIds = await one("InsuranceProduct")
  return [
    ...loans.map((id) => `/loans/${id}`),
    ...arrears.map((id) => `/collections/${id}`),
    ...apps.map((id) => `/applications/${id}`),
    ...leads.map((id) => `/crm/leads/${id}`),
    ...(await one("Contact")).map((id) => `/contacts/${id}`),
    ...(await one("Client")).map((id) => `/clients/${id}`),
    ...(await one("InsurancePolicy")).map((id) => `/insurance/${id}`),
    ...productIds.flatMap((id) => [`/settings/products/insurance/${id}`, `/settings/products/insurance/${id}/rates`, `/settings/products/insurance/${id}/eligibility`]),
  ]
}

/**
 * A consumer borrower with a loan (and an insurance policy, preferred, when
 * the lender sells insurance: one with no FSP number sells none), and the ids
 * their portal pages need. Asset-finance people have separate seeded
 * passwords that are intentionally not part of the consumer simulator
 * credentials.
 */
async function portalBorrower(): Promise<{ email: string; pages: string[] } | null> {
  const rows = await readDb().$queryRawUnsafe<Array<{ email: string; loan: string; app: string; policy: string | null }>>(`
    SELECT c.email, l.id AS loan, l."applicationId" AS app, p.id AS policy
    FROM "Loan" l JOIN "Client" c ON c.id = l."clientId" LEFT JOIN "InsurancePolicy" p ON p."clientId" = c.id
    WHERE c."portalPassword" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "AssetFinanceDeal" d WHERE d."loanId" = l.id)
    ORDER BY p."createdAt" NULLS LAST, l."createdAt" LIMIT 1`)
  const r = rows[0]
  if (!r) return null
  return { email: r.email, pages: [`/portal/loans/${r.loan}`, `/portal/applications/${r.app}`, ...(r.policy ? [`/portal/insurance/${r.policy}`] : [])] }
}

async function check(actor: SimClient, pages: string[], expectedRedirects: ReadonlyMap<string, string> = new Map()): Promise<number> {
  let bad = 0
  for (const page of pages) {
    const t0 = Date.now()
    const verdict = await verifyPageResponse(actor, page, expectedRedirects.get(page))
    const res = verdict.response
    const html = (res.headers.get("content-type") ?? "").includes("text/html")
    const ok = verdict.ok
    if (!ok) bad++
    const redirect = res.status >= 300 && res.status < 400 ? ` → ${res.headers.get("location")}` : ""
    process.stdout.write(`${ok ? "200 ok " : "FAIL   "} ${page} → ${res.status} ${html ? "html" : res.headers.get("content-type")} ${res.bytes.length}B ${Date.now() - t0}ms${verdict.destination ? ` [mapped307 → ${verdict.destination}]` : ""}${redirect}\n`)
  }
  return bad
}

async function main(): Promise<void> {
  const creds = readSeedCredentials()
  const admin = new SimClient()
  await admin.loginStaff(creds.admin.email, creds.admin.password, creds.admin.totpSecret)
  const nav = staffNavigation.flatMap((g) => g.items).filter((i) => !i.external).map((i) => i.href)
  const staffPages = [...new Set([...nav, ...SUB_PAGES, ...(await staffDetailPages())])]
  if (!admin.user?.tenantId) throw new Error("Page verification requires a tenant-bound staff session")
  const links = await readDb().assetFinanceDeal.findMany({
    where: { tenantId: admin.user.tenantId, application: { tenantId: admin.user.tenantId } },
    select: { id: true, applicationId: true },
  })
  const expectedRedirects = new Map(links.map(deal => [`/applications/${deal.applicationId}`, `/asset-finance/deals/${deal.id}`]))
  let bad = await check(admin, staffPages, expectedRedirects)
  let total = staffPages.length

  const borrower = await portalBorrower()
  if (!borrower) {
    log("no borrower with a loan and a portal password; portal pages not checked")
    bad++
  } else {
    const portal = new SimClient()
    await portal.loginClient(borrower.email, creds.portalPassword)
    const portalPages = [...buildPortalNavigation(null).filter((i) => !i.external).map((i) => i.href), ...borrower.pages]
    bad += await check(portal, portalPages)
    total += portalPages.length
  }
  log(`${total - bad}/${total} pages rendered`)
  if (bad > 0) process.exitCode = 1
}

main()
  .catch((err: unknown) => {
    log(err instanceof Error ? err.stack ?? err.message : String(err))
    process.exitCode = 1
  })
  .finally(() => closeReadDb())
