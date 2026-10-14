/**
 * Invite and reset links the operator console sends: a new lender's first
 * SUPER_ADMIN, a lender admin who is locked out, an operator user. The link
 * carries a one-time token (User.resetToken, the same column and the same
 * /api/auth/reset-password the staff "Forgot password" flow uses), so the
 * operator never sees, sets or chooses a password, and the token is never in
 * a response or an audit row.
 *
 * Mail goes through the deployment's own SMTP account (lib/email.ts, SMTP_*):
 * the console acts for the operator, and a lender being provisioned has no
 * mailbox of its own yet. With no SMTP configured nothing is sent and the
 * caller reports emailSent: false.
 */
import { randomBytes } from "node:crypto"
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { sendEmail as sendPlatformEmail } from "@/lib/email"
import { requireAppBaseUrl, requireOperatorBaseUrl } from "@/lib/config/deployment-urls"
import { escapeHtml } from "@/lib/utils"

export const INVITE_LINK_HOURS = 72
export const RESET_LINK_HOURS = 1

/** A password nobody knows: the account is usable only once its owner sets one through the link. */
export async function unusablePasswordHash(): Promise<string> {
  return bcrypt.hash(randomBytes(32).toString("base64url"), 12)
}

/** Writes a fresh one-time token on the user (replacing any earlier link) and returns it. */
export async function issueAccountToken(
  db: Pick<typeof prisma, "user">,
  userId: string,
  hours: number,
  now: Date = new Date(),
): Promise<string> {
  const token = randomBytes(32).toString("hex")
  await db.user.update({
    where: { id: userId },
    data: { resetToken: token, resetTokenExp: new Date(now.getTime() + hours * 3_600_000) },
  })
  return token
}

/** Where a lender's staff set a password: the lender's own domain when it has one. */
export function lenderPasswordUrl(tenant: { domain: string | null }, token: string): string {
  const base = tenant.domain ? `https://${tenant.domain}` : requireAppBaseUrl()
  return `${base}/reset-password?token=${token}`
}

/** Where an operator user sets a password: the operator console host. */
export function operatorPasswordUrl(token: string): string {
  return `${requireOperatorBaseUrl()}/operator/set-password?token=${token}`
}

/**
 * Sends the link. True only when the mail server accepted it; a missing
 * deployment URL or SMTP account, or a send failure, is logged and false.
 */
export async function sendAccountLink(input: {
  to: string
  name: string | null
  kind: "invite" | "reset"
  /** Who the account is with: the lender's or the operator's name. */
  organisation: string
  url: () => string
  hours: number
}): Promise<boolean> {
  try {
    const url = input.url()
    const org = escapeHtml(input.organisation)
    const greeting = escapeHtml(input.name ?? input.to)
    const lead = input.kind === "invite"
      ? `You have been given an account with ${org}. Set your password to start.`
      : `A password reset was requested for your ${org} account by its platform operator.`
    const result = await sendPlatformEmail({
      to: input.to,
      subject: input.kind === "invite" ? `Your ${input.organisation} account` : `Reset your ${input.organisation} password`,
      html: `<p>Hi ${greeting},</p><p>${lead}</p><p><a href="${escapeHtml(url)}">Set your password</a></p>` +
        `<p>This link works once and expires in ${input.hours} hour${input.hours === 1 ? "" : "s"}. ` +
        `Where two-factor authentication is required you will set it up when you first sign in.</p>`,
    })
    return result.ok && !("dev" in result && result.dev)
  } catch (err) {
    console.error("[operator-console] account link not sent:", err instanceof Error ? err.message : err)
    return false
  }
}
