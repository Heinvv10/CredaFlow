/**
 * Netcash integration — EFT disbursements via Netcash
 */

import { loadTenantCredential } from "@/lib/integrations/tenant-credentials"
import { assertSimulationAllowed } from "@/lib/integrations/simulation-guard"

interface DisburseOptions {
  tenantId: string
  accountHolder: string
  accountNumber: string
  bankCode: string
  amount: number
  reference: string
  description: string
}

interface DisburseResult {
  ok: boolean
  /** Synthetic provider response. No money moved. Never a valid payout record. */
  simulated?: true
  transactionId?: string
  error?: string
}

async function getServiceKey(tenantId: string): Promise<string | null> {
  try {
    return await loadTenantCredential(tenantId, "netcashKey")
  } catch {
    return null
  }
}

function buildXml(serviceKey: string, opts: DisburseOptions): string {
  const amountCents = Math.round(opts.amount * 100)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<NetCash>",
    `  <Key>${serviceKey}</Key>`,
    "  <PayType>E</PayType>",
    `  <AccountHolder>${escapeXml(opts.accountHolder)}</AccountHolder>`,
    `  <AccountNumber>${escapeXml(opts.accountNumber)}</AccountNumber>`,
    `  <BranchCode>${escapeXml(opts.bankCode)}</BranchCode>`,
    `  <Amount>${amountCents}</Amount>`,
    `  <Reference>${escapeXml(opts.reference)}</Reference>`,
    `  <Description>${escapeXml(opts.description)}</Description>`,
    "</NetCash>",
  ].join("\n")
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

export async function disburseFunds(opts: DisburseOptions): Promise<DisburseResult> {
  const dryRun = process.env.NODE_ENV === "test" || process.env.NETCASH_DRY_RUN === "true"
  if (dryRun) {
    // A simulated payout claims money moved when none did. That must never be
    // reachable on a deployed build without the environment explicitly saying
    // it is non-production.
    assertSimulationAllowed("netcash", true)
    return { ok: true, transactionId: "dry-run", simulated: true }
  }

  const serviceKey = await getServiceKey(opts.tenantId)
  if (!serviceKey) {
    return { ok: false, error: "Netcash not configured" }
  }

  const xml = buildXml(serviceKey, opts)

  try {
    const res = await fetch("https://netcash.co.za/communicator/netcash.aspx", {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: xml,
    })

    const responseText = await res.text()
    const lower = responseText.toLowerCase()

    if (lower.includes("approved") || lower.includes("success")) {
      const txMatch = responseText.match(/transactionId[>:]\s*([A-Za-z0-9-]+)/i)
      return { ok: true, transactionId: txMatch?.[1] ?? `nc-${Date.now()}` }
    }

    return { ok: false, error: `Netcash response: ${responseText.slice(0, 200)}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Netcash request failed" }
  }
}
