/**
 * The demo lender a seed and a simulator bake are branded as, chosen by
 * DEMO_LENDER (default "acme"). prisma/seed.ts and scripts/demo read it, so one
 * variable rebrands the tenant slug, the lender identity and colours, the staff
 * and client email domains, the bureau trading name and the simulator's copy.
 * None of the statutory numbers is a real registration.
 *
 *   DEMO_LENDER=fairscore npx prisma db seed
 *   npx tsx prisma/demo-lender.ts slug      # one field, for shell scripts
 */
import type { LenderIdentityColumns } from "../lib/config/identity"
import { VALID_LENDER_COLUMNS } from "../lib/config/__fixtures__/lender-identity"

export interface DemoLender {
  /** Tenant.slug; NEXT_PUBLIC_TENANT_SLUG and TENANT_HOST_MAP must name it. */
  slug: string
  identity: LenderIdentityColumns & { brandName: string }
  colours: { primaryColor: string; secondaryColor: string; darkColor: string }
  /** Staff logins and the lender's own mailboxes. */
  staffDomain: string
  /** Borrower emails. Always a `.invalid` domain (see CLIENTS in prisma/seed.ts). */
  clientDomain: string
  bureau: { supplierNumber: string; tradingName: string }
}

export const DEMO_LENDERS: Readonly<Record<string, DemoLender>> = {
  acme: {
    slug: "acme",
    identity: { ...VALID_LENDER_COLUMNS, brandName: "Acme Lending" },
    colours: { primaryColor: "#1F4E79", secondaryColor: "#245E92", darkColor: "#0F1115" },
    staffDomain: "acme-lending.example",
    clientDomain: "acme-lending.invalid",
    bureau: { supplierNumber: "ACME01", tradingName: "ACME LENDING" },
  },
  fairscore: {
    slug: "fairscore",
    // A clearly fictional demo lender: none of these is Fair Score's own
    // registration, office or number. Its NCR and FSP numbers are fictional
    // too (the FSP one lets the demo show insurance); on a demo stack the
    // site and portal print "Demo lender" beside them
    // (lib/config/demo-mode.ts demoLenderNote), and the tagline says it on
    // the site and letterhead.
    identity: {
      ...VALID_LENDER_COLUMNS,
      legalName: "Fair Score Demo Lender (Pty) Ltd",
      brandName: "Fair Score",
      ncrNumber: "NCRCP98765",
      fscaNumber: "98765",
      companyRegNumber: "2021/905731/07",
      registeredOffice: "Suite 4, 18 Marula Lane\nUmhlanga Ridge\n4319",
      publicEmail: "hello@fairscore.example",
      publicPhone: "+27 31 000 4180",
      collectionsEmail: "collections@fairscore.example",
      collectionsPhone: "+27 31 000 4181",
      brandTagline: "Demo lender: fair credit, clearly scored",
      headOfficeCity: "Umhlanga",
    },
    colours: { primaryColor: "#033483", secondaryColor: "#0A63B8", darkColor: "#0F1A2E" },
    staffDomain: "fairscore.example",
    clientDomain: "fairscore.invalid",
    bureau: { supplierNumber: "FAIR01", tradingName: "FAIRSCORE" },
  },
  tsela: {
    slug: "tsela",
    identity: {
      ...VALID_LENDER_COLUMNS,
      legalName: "Tsela Lending (Pty) Ltd",
      brandName: "Tsela Lending",
      publicEmail: "hello@tsela-lending.example",
      collectionsEmail: "collections@tsela-lending.example",
    },
    colours: { primaryColor: "#1F4E79", secondaryColor: "#245E92", darkColor: "#0F1115" },
    staffDomain: "tsela-lending.example",
    clientDomain: "tsela-lending.invalid",
    bureau: { supplierNumber: "TSELA1", tradingName: "TSELA LENDING" },
  },
}

export function demoLender(env: Record<string, string | undefined> = process.env): DemoLender {
  const name = env.DEMO_LENDER || "acme"
  const lender = Object.prototype.hasOwnProperty.call(DEMO_LENDERS, name) ? DEMO_LENDERS[name] : undefined
  if (!lender) throw new Error(`DEMO_LENDER=${name} is not one of: ${Object.keys(DEMO_LENDERS).join(", ")}`)
  return lender
}

const FIELDS = {
  slug: (l: DemoLender) => l.slug,
  brand: (l: DemoLender) => l.identity.brandName,
  staffDomain: (l: DemoLender) => l.staffDomain,
  clientDomain: (l: DemoLender) => l.clientDomain,
} as const

if (process.argv[1]?.endsWith("demo-lender.ts")) {
  const field = process.argv[2] as keyof typeof FIELDS
  if (!Object.prototype.hasOwnProperty.call(FIELDS, field)) {
    process.stderr.write(`usage: demo-lender.ts ${Object.keys(FIELDS).join(" | ")}\n`)
    process.exit(2)
  }
  try {
    process.stdout.write(`${FIELDS[field](demoLender())}\n`)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(1)
  }
}
