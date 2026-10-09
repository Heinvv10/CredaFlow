import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import type { Prisma } from "@prisma/client"

type SeedRow = Omit<Prisma.DocumentTemplateCreateInput, "tenant">

// SYSTEM rows: code-generated NCA / compliance docs, view/download only.
const SYSTEM_ROWS: SeedRow[] = [
  {
    key: "credit_agreement",
    name: "Small Credit Loans Agreement",
    category: "Agreement",
    kind: "SYSTEM",
    systemGenerator: "creditAgreement",
    signingMethod: "NONE",
  },
  {
    key: "pre_agreement",
    name: "Pre-Agreement (Form 20)",
    category: "Agreement",
    kind: "SYSTEM",
    systemGenerator: "preAgreement",
    signingMethod: "NONE",
  },
  {
    key: "debit_order_mandate",
    name: "Debit Order Mandate",
    category: "Agreement",
    kind: "SYSTEM",
    systemGenerator: "debitMandate",
    signingMethod: "NONE",
  },
  {
    key: "section_129",
    name: "Section 129 Notice",
    category: "Collections",
    kind: "SYSTEM",
    systemGenerator: "section129",
    signingMethod: "NONE",
  },
  {
    key: "certificate_of_balance",
    name: "Certificate of Balance",
    category: "Statement",
    kind: "SYSTEM",
    systemGenerator: "certificateOfBalance",
    signingMethod: "NONE",
  },
  {
    key: "fais_disclosure",
    name: "FAIS Disclosure",
    category: "Consent",
    kind: "SYSTEM",
    systemGenerator: "faisDisclosure",
    signingMethod: "NONE",
  },
  {
    key: "customer_statement",
    name: "Customer Statement",
    category: "Statement",
    kind: "SYSTEM",
    systemGenerator: "statement",
    signingMethod: "NONE",
  },
  {
    key: "affordability_assessment",
    name: "Affordability Assessment",
    category: "Statement",
    kind: "SYSTEM",
    systemGenerator: "affordabilityAssessment",
    signingMethod: "NONE",
  },
]

// CUSTOM rows: in-app authored HTML stubs, editable via the catalogue UI.
const CUSTOM_ROWS: SeedRow[] = [
  {
    key: "electronic_signature_consent",
    name: "Electronic Signature Consent",
    category: "Consent",
    kind: "CUSTOM",
    signingMethod: "NONE",
  },
  {
    key: "collection_cost_recovery_agreement",
    name: "Collection Cost Recovery Agreement",
    category: "Collections",
    kind: "CUSTOM",
    signingMethod: "NONE",
    requiresApproval: true,
  },
  {
    key: "paid_up_letter",
    name: "Paid-Up Letter",
    category: "Collections",
    kind: "CUSTOM",
    signingMethod: "NONE",
  },
  {
    key: "settlement_letter",
    name: "Settlement Letter",
    category: "Collections",
    kind: "CUSTOM",
    signingMethod: "NONE",
    requiresApproval: true,
  },
  {
    key: "electronic_application_form",
    name: "Electronic Application Form",
    category: "Agreement",
    kind: "CUSTOM",
    signingMethod: "NONE",
  },
]

const CATALOGUE: SeedRow[] = [...SYSTEM_ROWS, ...CUSTOM_ROWS]

export async function seedDocumentTemplates(tenantId: string): Promise<void> {
  // Task 5 added DocumentTemplate to TENANT_SCOPED_MODELS. This seed runs
  // outside any per-request tenant AsyncLocalStorage context and upserts on
  // the composite tenantId_key unique (not a bare where.tenantId), so the
  // extension's ALS-less "explicit tenantId" check can't recognize it —
  // it's an explicit-tenantId admin/setup operation, so bypass enforcement.
  await withoutTenantScope(async () => {
    for (const row of CATALOGUE) {
      await prisma.documentTemplate.upsert({
        where: { tenantId_key: { tenantId, key: row.key } },
        update: {},
        create: { ...row, tenant: { connect: { id: tenantId } } },
      })
    }
  })
}
