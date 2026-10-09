import nodemailer from "nodemailer"
import { prisma } from "@/lib/prisma"
import { escapeHtml } from "@/lib/utils"

interface EmailConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  fromName: string
  fromEmail: string
}

async function getEmailConfig(): Promise<EmailConfig | null> {
  try {
    const tenant = await prisma.tenant.findFirst({ where: { status: "ACTIVE" } })
    if (!tenant) return null
    // TenantEmailConfig model not yet in schema — fall through to env vars
    void tenant
  } catch {}

  // Fall back to env vars
  const host = process.env.SMTP_HOST
  const user = process.env.SMTP_USER
  const pass = process.env.SMTP_PASS
  const fromName = process.env.SMTP_FROM_NAME
  if (host && user && pass && fromName) {
    return {
      host,
      port: parseInt(process.env.SMTP_PORT ?? "587"),
      secure: process.env.SMTP_PORT === "465",
      user,
      pass,
      fromName,
      fromEmail: process.env.SMTP_FROM_EMAIL ?? user,
    }
  }
  return null
}

export async function sendEmail(opts: {
  to: string
  subject: string
  html: string
  text?: string
}) {
  const cfg = await getEmailConfig()

  if (!cfg) {
    console.warn("[email] No SMTP config found — email not sent to", opts.to)
    // In dev without SMTP, log to console
    console.log("[email] Would send to:", opts.to, "Subject:", opts.subject)
    return { ok: true, dev: true }
  }

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
  })

  const info = await transporter.sendMail({
    from: `"${cfg.fromName}" <${cfg.fromEmail}>`,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    text: opts.text,
  })

  return { ok: true, messageId: info.messageId }
}

export function passwordResetEmailHtml(opts: {
  brandName: string
  name: string
  resetUrl: string
  expiryMinutes: number
}) {
  // The brand is admin-entered DB text (TenantConfig.brandName or Tenant.name).
  const brand = escapeHtml(opts.brandName)
  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family:Arial,sans-serif;background:#f3f4f6;margin:0;padding:40px 20px;">
  <div style="max-width:520px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08);">
    <!-- Header -->
    <div style="background:#1b1d24;padding:32px 40px;">
      <div style="font-size:20px;font-weight:800;color:#4338CA;">${brand}</div>
      <div style="font-size:12px;color:#8f95a3;margin-top:4px;">Loan Management System</div>
    </div>
    <!-- Body -->
    <div style="padding:40px;">
      <h2 style="font-size:20px;color:#1b1d24;margin:0 0 12px;">Password Reset Request</h2>
      <p style="color:#4b5060;font-size:14px;line-height:1.6;margin-bottom:24px;">
        Hi ${opts.name},<br><br>
        We received a request to reset your password for the ${brand} LMS. 
        Click the button below to set a new password.
      </p>
      <a href="${opts.resetUrl}" 
         style="display:inline-block;background:#4338CA;color:white;text-decoration:none;padding:14px 32px;border-radius:8px;font-weight:600;font-size:14px;">
        Reset My Password
      </a>
      <p style="color:#8f95a3;font-size:12px;margin-top:24px;line-height:1.6;">
        This link expires in <strong>${opts.expiryMinutes} minutes</strong>.<br>
        If you didn't request a password reset, you can safely ignore this email.<br>
        Your password will not change unless you click the link above.
      </p>
      <hr style="border:none;border-top:1px solid #eceef2;margin:24px 0;">
      <p style="color:#a9aeb9;font-size:11px;">
        ${brand} · Loan Management System<br>
        This is an automated message — please do not reply.
      </p>
    </div>
  </div>
</body>
</html>`
}
