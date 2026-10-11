/**
 * Who a non-production environment is allowed to email.
 *
 * WHY THIS EXISTS
 *   A walkthrough on a non-production environment that carries a live SMTP
 *   sender can send genuine NCA Section 129 statutory demands — formal notices
 *   of default on the lender's letterhead, citing its NCR number, quoting
 *   arrears, giving ten business days before legal proceedings — to real
 *   public mailboxes, and scheduled jobs (payment_due_reminder, loan_overdue,
 *   payment_received) can mail the same addresses repeatedly.
 *
 *   Two individually reasonable choices combine to cause it: seed data using
 *   plausible public addresses so demo data looks credible, and a live SMTP
 *   sender outside production. Fixing the seed fixes the DATA. This fixes the
 *   CLASS: no environment outside production can deliver to an unapproved
 *   domain, whatever the data says.
 *
 * WHY NOT NODE_ENV
 *   Staging and production run the SAME Docker image and BOTH set
 *   NODE_ENV=production. NODE_ENV
 *   cannot distinguish them, so keying delivery safety on it would be a guard
 *   that is simply absent on the environment it is meant to protect.
 *
 * WHY IT FAILS CLOSED
 *   Delivery is restricted unless EMAIL_DELIVERY_MODE is explicitly
 *   "unrestricted". A new environment, a restored backup or a forgotten .env
 *   therefore starts SAFE and mails only company domains — the operator finds
 *   out because an internal test mail is blocked, not because a stranger
 *   receives a letter of demand. Production opts out explicitly, and that
 *   opt-out is set on the box BEFORE this code ships so the deploy cannot
 *   silence customer mail.
 */

/**
 * Domains an allowlisted environment may always reach. The lender's own
 * domains come from EMAIL_INTERNAL_DOMAINS; unset leaves only this list, which
 * is the SAFE direction — an unconfigured environment can reach nobody real.
 */
const DEFAULT_ALLOWED = [
  // RFC 2606 reserves .invalid and guarantees it never resolves, so seed
  // fixtures addressed there fail closed at DNS and can reach nobody.
  "invalid",
]

export type DeliveryMode = "unrestricted" | "allowlist"

export interface RecipientDecision {
  allowed: boolean
  mode: DeliveryMode
  /** Machine-readable reason, recorded on the blocked EmailLog row. */
  reason?: string
  /** The domains that were permitted, for the operator reading the block. */
  allowedDomains?: string[]
  /** The specific mailbox that caused the refusal, when there was a list. */
  blockedRecipients?: string[]
}

export function deliveryMode(env: NodeJS.ProcessEnv = process.env): DeliveryMode {
  // Only the exact string opts out. A typo ("unresticted", "true", "1") leaves
  // the environment restricted rather than quietly wide open.
  return env.EMAIL_DELIVERY_MODE === "unrestricted" ? "unrestricted" : "allowlist"
}

function parseDomainList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean)
}

export function allowedDomains(env: NodeJS.ProcessEnv = process.env): string[] {
  const internal = parseDomainList(env.EMAIL_INTERNAL_DOMAINS)
  const configured = parseDomainList(env.EMAIL_RECIPIENT_ALLOWLIST)
  return [...new Set([...DEFAULT_ALLOWED, ...internal, ...configured])]
}

/**
 * Suffix match on a DOT boundary, so "lender.example" admits
 * "mail.lender.example" but NOT "notlender.example" — a plain endsWith() would
 * admit an attacker-registered lookalike, and a plain equality check would
 * reject legitimate subdomains.
 */
function domainMatches(recipientDomain: string, allowed: string): boolean {
  return recipientDomain === allowed || recipientDomain.endsWith(`.${allowed}`)
}

export function recipientDomainOf(address: string): string | null {
  // Take the LAST @ so a quoted local part containing one cannot smuggle a
  // different domain past the check.
  //
  // No display-name unwrapping. A `Name <addr>` form already resolves correctly
  // here (the trailing ">" is stripped below), and an explicit unwrapper was
  // REMOVED after mutation testing showed it changed exactly one outcome —
  // a malformed "Name <a@lender.example> junk" — and changed it from BLOCKED to
  // ALLOWED. The only thing it did was widen what a safety guard permits, and
  // no test could justify keeping it.
  const at = address.lastIndexOf("@")
  if (at < 0 || at === address.length - 1) return null
  return address.slice(at + 1).trim().toLowerCase().replace(/>$/, "")
}

/**
 * Every token in the value that could be an address under ANY parser's rules.
 *
 * NOT a mailbox parser — deliberately. Two earlier attempts were bypassed
 * because this code and the thing that actually dispatches disagreed about
 * where a mailbox ends:
 *
 *   "victim@gmail.com, ops@lender.example"  a last-@ check saw only lender
 *   "victim@gmail.com ops@lender.example"   a comma-splitter saw one mailbox,
 *                                          while nodemailer's own parser
 *                                          resolves it to ["victim@gmail.com"]
 *                                          — verified against
 *                                          nodemailer/lib/addressparser
 *
 * Replicating that parser would only move the disagreement, and MS Graph parses
 * the same string differently again. So this does not try to decide WHICH
 * mailbox will be dispatched. It requires that EVERY substring that could
 * possibly be one is allowlisted, which is conservative under every parser and
 * cannot be widened by a separator nobody thought of.
 */
export function extractAddressCandidates(value: string): string[] {
  return value
    .split(/[\s,;<>()[\]"']+/)
    .map((t) => t.trim())
    .filter((t) => t.includes("@"))
}

export function checkRecipient(
  address: string,
  env: NodeJS.ProcessEnv = process.env,
): RecipientDecision {
  const mode = deliveryMode(env)
  if (mode === "unrestricted") return { allowed: true, mode }

  const domains = allowedDomains(env)
  const mailboxes = extractAddressCandidates(address)
  if (mailboxes.length === 0) {
    return { allowed: false, mode, reason: "recipient_address_unparseable", allowedDomains: domains }
  }

  // EVERY mailbox must pass. One disallowed recipient in a list poisons the
  // whole send — there is no partial delivery here, and refusing the lot is the
  // only outcome that cannot mail a stranger.
  for (const mailbox of mailboxes) {
    const domain = recipientDomainOf(mailbox)
    if (!domain) {
      // An address we cannot parse is not an address we may send to. The safe
      // reading of "unknown" is "refuse", not "allow".
      return {
        allowed: false,
        mode,
        reason: "recipient_address_unparseable",
        allowedDomains: domains,
        blockedRecipients: [mailbox],
      }
    }
    if (!domains.some((d) => domainMatches(domain, d))) {
      return {
        allowed: false,
        mode,
        reason: "recipient_domain_not_allowlisted",
        allowedDomains: domains,
        blockedRecipients: [mailbox],
      }
    }
  }
  return { allowed: true, mode, allowedDomains: domains }
}

/** Operator-facing explanation, recorded on the blocked EmailLog row. */
export function blockedMessage(address: string, decision: RecipientDecision): string {
  const offending = decision.blockedRecipients?.[0] ?? address
  const domain = recipientDomainOf(offending)
  return (
    `Refused to deliver to ${domain ?? "an unparseable address"}: this environment runs in ` +
    `"${decision.mode}" delivery mode and may only reach ${(decision.allowedDomains ?? []).join(", ")}. ` +
    `Set EMAIL_DELIVERY_MODE=unrestricted on production only, or add the domain to ` +
    `EMAIL_RECIPIENT_ALLOWLIST.`
  )
}
