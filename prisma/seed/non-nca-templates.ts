/**
 * The documents of a key-facts (non-NCA) demo lender: an offer letter, a key facts
 * statement, a loan agreement and an arrears letter, as CUSTOM templates with one
 * ACTIVE, approved version each (lib/non-nca-documents).
 *
 * The bank's legal wording is the bank's to supply, and the system never invents
 * it. These are STRUCTURE only: the parties, the approved figures (the quote.*
 * tokens) and a marked gap where the legal text goes. Every document of a demo
 * lender also opens with the SAMPLE banner (lib/non-nca-documents/render.ts).
 * Synthetic, for a demo database; a real lender's legal team writes and approves
 * its own versions under Settings, Documents.
 */
import type { PrismaClient } from "@prisma/client"
import { ARREARS_LETTER_TEMPLATE_KEY, LOAN_DOCUMENT_TEMPLATE_KEYS } from "../../lib/non-nca-documents/keys"

const GAP = "<p><em>[SAMPLE &mdash; the bank&rsquo;s legal team supplies wording. No legal text is provided here.]</em></p>"

const FIGURES = `<table>
<tr><td>Loan amount</td><td>{{quote.principal}}</td></tr>
<tr><td>Term</td><td>{{quote.term}}</td></tr>
<tr><td>Interest rate</td><td>{{quote.interestRate}}</td></tr>
<tr><td>Initiation fee</td><td>{{quote.initiationFee}}</td></tr>
<tr><td>Service fees over the term</td><td>{{quote.serviceFees}}</td></tr>
<tr><td>Number of instalments</td><td>{{quote.instalments}}</td></tr>
<tr><td>Instalment</td><td>{{quote.instalment}}</td></tr>
<tr><td>First instalment due</td><td>{{quote.firstDueDate}}</td></tr>
<tr><td>Last instalment due</td><td>{{quote.lastDueDate}}</td></tr>
<tr><td>Total interest</td><td>{{quote.totalInterest}}</td></tr>
<tr><td>Total repayable</td><td>{{quote.totalRepayable}}</td></tr>
<tr><td>Repayment method</td><td>{{quote.repaymentMethod}}</td></tr>
</table>`

const PARTIES = `<p>Lender: {{tenant.legalName}}</p>
<p>Borrower: {{client.fullName}}, identity number {{client.idNumber}}</p>
<p>Application: {{application.reference}} &mdash; {{application.product}}</p>`

const ARREARS = `<table>
<tr><td>Loan reference</td><td>{{loan.reference}}</td></tr>
<tr><td>Date of this letter</td><td>{{arrears.noticeDate}}</td></tr>
<tr><td>Amount in arrears</td><td>{{arrears.amount}}</td></tr>
<tr><td>Days in arrears</td><td>{{arrears.days}}</td></tr>
<tr><td>Total outstanding</td><td>{{arrears.totalOutstanding}}</td></tr>
</table>`

const BODIES = {
  OFFER_LETTER: `<h1>Offer letter</h1>\n${PARTIES}\n${FIGURES}\n${GAP}\n<p>Prepared {{today}}.</p>`,
  ARREARS_LETTER: `<h1>Arrears letter</h1>\n<p>Lender: {{tenant.legalName}}</p>\n<p>Borrower: {{client.fullName}}</p>\n${ARREARS}\n${GAP}`,
  KEY_FACTS_STATEMENT: `<h1>Key facts statement</h1>\n${PARTIES}\n${FIGURES}\n${GAP}\n<p>Prepared {{today}}.</p>`,
  LOAN_AGREEMENT: `<h1>Loan agreement</h1>\n${PARTIES}\n<h2>Approved terms</h2>\n${FIGURES}\n<h2>Terms and conditions</h2>\n${GAP}\n<p>Prepared {{today}}.</p>`,
} as const

const NAMES = { OFFER_LETTER: "Offer letter", KEY_FACTS_STATEMENT: "Key facts statement", LOAN_AGREEMENT: "Loan agreement", ARREARS_LETTER: "Arrears letter" } as const
const KEYS = { ...LOAN_DOCUMENT_TEMPLATE_KEYS, ARREARS_LETTER: ARREARS_LETTER_TEMPLATE_KEY }

/** Idempotent: a template that already has a current version is left alone. Authored by one admin, approved by another (the database requires it). */
export async function seedNonNcaTemplates(db: PrismaClient, tenantId: string, creatorId: string, approverId: string): Promise<void> {
  for (const kind of ["OFFER_LETTER", "KEY_FACTS_STATEMENT", "LOAN_AGREEMENT", "ARREARS_LETTER"] as const) {
    const key = KEYS[kind]
    const template = await db.documentTemplate.upsert({
      where: { tenantId_key: { tenantId, key } },
      update: {},
      create: { tenantId, key, name: NAMES[kind], category: "Agreement", kind: "CUSTOM", signingMethod: "NONE", requiresApproval: true, isActive: true },
    })
    if (template.currentVersionId) continue
    const { extractTokens } = await import("../../lib/documents/tokens")
    const version = await db.documentTemplateVersion.create({
      data: {
        templateId: template.id, version: 1, bodyHtml: BODIES[kind], tokensUsed: extractTokens(BODIES[kind]), status: "ACTIVE",
        notes: "Synthetic demo version: structure and approved figures only. The bank's legal team supplies the wording.",
        createdById: creatorId, activatedById: creatorId, activatedAt: new Date(), approvedById: approverId, approvedAt: new Date(),
      },
    })
    await db.documentTemplate.update({ where: { id: template.id }, data: { currentVersionId: version.id } })
  }
}
