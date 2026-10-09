import type { Client, Loan, LoanApplication, LoanProduct, Tenant, User } from "@prisma/client"
import { differenceInCalendarDays } from "date-fns"
import { formatDate, formatTermDays, formatZAR } from "@/lib/utils"
import type { LenderIdentity } from "@/lib/config/identity"

/**
 * Merge context for token resolution. `tenant`/`client` are always present
 * (every generated document is scoped to a client); `application`/`loan`/
 * `staff` are optional — a document may be generated before a loan exists
 * (e.g. at application stage) or without an acting staff member (system-
 * generated). `application.product` is a partial LoanProduct relation, not
 * part of Prisma's base LoanApplication scalar type — callers fetch it with
 * `include: { product: true }` (the existing convention across
 * app/api/applications/**).
 */
export interface TokenContext {
  tenant: Tenant
  /** The tenant's validated identity (lib/config/identity.ts); null when not
   * configured, which leaves every `tenant.*` identity token missing. */
  lender: LenderIdentity | null
  client: Client
  application?: (LoanApplication & { product?: Pick<LoanProduct, "name"> | null }) | null
  loan?: Loan | null
  staff?: User | null
}

export interface TokenDef {
  token: string
  label: string
  group: string
  resolve: (ctx: TokenContext) => string | null
}

/**
 * Whitelisted token registry — the editor's token picker inserts only these.
 * Every `resolve` returns `null` when its source data is absent (no loan,
 * no application, no staff, no address on file) so the empty-token guard at
 * generation time (Task 4) can block rather than print a silent blank on a
 * legal document.
 */
export const TOKEN_REGISTRY: TokenDef[] = [
  // Client
  {
    token: "client.fullName",
    label: "Client full name",
    group: "Client",
    resolve: (ctx) => `${ctx.client.firstName} ${ctx.client.lastName}`,
  },
  {
    token: "client.firstName",
    label: "Client first name",
    group: "Client",
    resolve: (ctx) => ctx.client.firstName,
  },
  {
    token: "client.lastName",
    label: "Client last name",
    group: "Client",
    resolve: (ctx) => ctx.client.lastName,
  },
  {
    token: "client.idNumber",
    label: "Client ID number",
    group: "Client",
    resolve: (ctx) => ctx.client.idNumber,
  },
  {
    token: "client.email",
    label: "Client email",
    group: "Client",
    resolve: (ctx) => ctx.client.email,
  },
  {
    token: "client.phone",
    label: "Client phone",
    group: "Client",
    resolve: (ctx) => ctx.client.phone,
  },
  {
    token: "client.physicalAddress",
    label: "Client physical address",
    group: "Client",
    resolve: (ctx) =>
      ctx.client.addressLine1
        ? `${ctx.client.addressLine1}${ctx.client.city ? `, ${ctx.client.city}` : ""}`
        : null,
  },

  // Loan
  {
    token: "loan.reference",
    label: "Loan reference",
    group: "Loan",
    resolve: (ctx) => ctx.loan?.reference ?? null,
  },
  {
    token: "loan.principal",
    label: "Loan principal",
    group: "Loan",
    resolve: (ctx) => (ctx.loan ? formatZAR(ctx.loan.principal) : null),
  },
  {
    token: "loan.term",
    label: "Loan term",
    group: "Loan",
    resolve: (ctx) =>
      ctx.loan
        ? formatTermDays(differenceInCalendarDays(ctx.loan.maturityDate, ctx.loan.startDate))
        : null,
  },
  {
    token: "loan.interestRate",
    label: "Loan interest rate",
    group: "Loan",
    resolve: (ctx) => (ctx.loan ? `${(ctx.loan.interestRatePm * 100).toFixed(2)}% per month` : null),
  },
  {
    token: "loan.outstandingBalance",
    label: "Loan outstanding balance",
    group: "Loan",
    resolve: (ctx) => (ctx.loan ? formatZAR(ctx.loan.outstandingPrincipal) : null),
  },

  // Application
  {
    token: "application.reference",
    label: "Application reference",
    group: "Application",
    resolve: (ctx) => ctx.application?.reference ?? null,
  },
  {
    token: "application.product",
    label: "Application product",
    group: "Application",
    resolve: (ctx) => ctx.application?.product?.name ?? null,
  },
  {
    token: "application.amountRequested",
    label: "Application amount requested",
    group: "Application",
    resolve: (ctx) => (ctx.application ? formatZAR(ctx.application.appliedAmount) : null),
  },

  // Tenant — identity comes only from the tenant's validated TenantConfig
  // (lib/config/identity.ts). No configured identity ⇒ null ⇒ the empty-token
  // guard blocks generation instead of printing a blank or a default.
  {
    token: "tenant.legalName",
    label: "Tenant legal name",
    group: "Tenant",
    resolve: (ctx) => ctx.lender?.legalName ?? null,
  },
  {
    token: "tenant.ncrNumber",
    label: "Tenant NCR registration number",
    group: "Tenant",
    resolve: (ctx) => ctx.lender?.ncrNumber ?? null,
  },
  {
    token: "tenant.registeredAddress",
    label: "Tenant registered address",
    group: "Tenant",
    resolve: (ctx) => ctx.lender?.registeredOfficeLines.join(", ") ?? null,
  },

  // Staff
  {
    token: "staff.name",
    label: "Generating staff member",
    group: "Staff",
    resolve: (ctx) => ctx.staff?.name ?? null,
  },

  // System
  {
    token: "today",
    label: "Today's date",
    group: "System",
    resolve: () => formatDate(new Date()),
  },
]

/** Linear lookup by token; unknown tokens resolve to `null`. */
export function resolveToken(token: string, ctx: TokenContext): string | null {
  const def = TOKEN_REGISTRY.find((t) => t.token === token)
  return def ? def.resolve(ctx) : null
}

const TOKEN_PATTERN = /{{\s*([\w.]+)\s*}}/g

/**
 * Scans `html` for every `{{token}}` occurrence and returns the deduped
 * token names, in first-seen order. Used when saving a template version to
 * populate `tokensUsed` for validation/preview without resolving a real
 * `TokenContext`.
 */
export function extractTokens(html: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const match of html.matchAll(TOKEN_PATTERN)) {
    const name = match[1]
    if (!seen.has(name)) {
      seen.add(name)
      tokens.push(name)
    }
  }
  return tokens
}

/**
 * Escapes HTML metacharacters in a resolved token VALUE before it is
 * substituted into the (trusted, LOAN_ADMIN-authored) template HTML. Token
 * values come from client-controlled data (names, addresses entered via the
 * self-service portal) and must never be interpreted as markup. `&` is
 * escaped first so it doesn't double-escape the entities produced by the
 * other replacements.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

/**
 * Substitutes every `{{token}}` occurrence in `html` with its resolved
 * value. A token that is unknown or resolves to `null`/`""` is left
 * un-substituted and its name is collected in `missing` (deduplicated, in
 * first-seen order) — the empty-token guard that keeps a legal document
 * from generating with a silent blank field. Resolved values are
 * HTML-escaped before substitution since they are client-controlled data;
 * the template HTML itself is never escaped.
 */
export function renderTokens(html: string, ctx: TokenContext): { html: string; missing: string[] } {
  const missing: string[] = []
  const seen = new Set<string>()
  const substituted = html.replace(TOKEN_PATTERN, (match, name: string) => {
    const value = resolveToken(name, ctx)
    if (value) return escapeHtml(value)
    if (!seen.has(name)) {
      seen.add(name)
      missing.push(name)
    }
    return match
  })
  return { html: substituted, missing }
}
