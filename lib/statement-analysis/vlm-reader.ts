/**
 * Vision-model statement reader: the fallback for photos, scans and every bank
 * without a text reader. One request per page; the header facts come from the
 * first page that prints them and the rows are concatenated in page order.
 *
 * The model's read is never trusted on its own: the pipeline runs the same
 * balance check over it, and a read that fails it is UNVERIFIED (manual
 * review), never evidence of tampering. A misread and a forgery look the same.
 *
 * The model is the shared one on velo-server (VLM_API_URL). Unit tests mock
 * fetch; corpus runs happen only after hours (see .claude.md).
 */
import { getVlmConfig, parseVlmResponse } from "@/lib/vlm-extract"
import { MAX_CENTS } from "./money"
import type { StatementRead, StatementTransaction } from "./types"

/** A longer statement goes to manual review rather than tying up the model. */
export const VLM_MAX_PAGES = 12
const PAGE_TIMEOUT_MS = 120_000

export class VlmUnavailableError extends Error {}

export const STATEMENT_PAGE_PROMPT = `This image is one page of a South African bank statement.
Return ONLY JSON, no commentary:
{"accountHolderName": string|null, "accountNumber": string|null,
 "periodStart": "YYYY-MM-DD"|null, "periodEnd": "YYYY-MM-DD"|null,
 "openingBalance": number|null, "closingBalance": number|null,
 "transactions": [{"date": "YYYY-MM-DD", "description": string, "amount": number, "balance": number|null}]}
Rules: copy figures exactly as printed, in rands with cents. "amount" is signed: money into the
account positive, money out (including fees) negative. "balance" is the running balance printed on
that row, negative when overdrawn. List every transaction row on this page, top to bottom, and no
summary or subtotal rows. Use null for anything this page does not print.`

const ISO = /^\d{4}-\d{2}-\d{2}$/

function cents(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null
  const c = Math.round(v * 100)
  return Math.abs(c) > MAX_CENTS ? null : c
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

/**
 * One page's JSON → header facts and rows. A malformed row is dropped, which
 * the balance check then catches as an unverified read.
 */
export function parsePage(raw: Record<string, unknown>, page: number): StatementRead {
  const rows = Array.isArray(raw.transactions) ? raw.transactions : []
  const transactions: StatementTransaction[] = []
  for (const r of rows as Array<Record<string, unknown>>) {
    const amountCents = cents(r?.amount)
    const date = str(r?.date)
    if (amountCents === null || !date || !ISO.test(date)) continue
    transactions.push({ date, description: str(r.description) ?? "", amountCents, balanceCents: cents(r.balance), page })
  }
  const account = str(raw.accountNumber)?.replace(/\D/g, "") ?? ""
  return {
    accountHolderName: str(raw.accountHolderName),
    accountNumberLast4: account.length >= 4 ? account.slice(-4) : null,
    periodStart: str(raw.periodStart) && ISO.test(String(raw.periodStart)) ? String(raw.periodStart) : null,
    periodEnd: str(raw.periodEnd) && ISO.test(String(raw.periodEnd)) ? String(raw.periodEnd) : null,
    openingBalanceCents: cents(raw.openingBalance),
    closingBalanceCents: cents(raw.closingBalance),
    transactions,
  }
}

/** Header facts from the first page that has each; closing from the last. */
export function combinePages(pages: StatementRead[]): StatementRead {
  const first = <K extends keyof StatementRead>(k: K) => pages.find((p) => p[k] !== null)?.[k] ?? null
  const lastClosing = [...pages].reverse().find((p) => p.closingBalanceCents !== null)
  return {
    accountHolderName: first("accountHolderName") as string | null,
    accountNumberLast4: first("accountNumberLast4") as string | null,
    periodStart: first("periodStart") as string | null,
    periodEnd: first("periodEnd") as string | null,
    openingBalanceCents: first("openingBalanceCents") as number | null,
    closingBalanceCents: lastClosing?.closingBalanceCents ?? null,
    transactions: pages.flatMap((p) => p.transactions),
  }
}

async function readPage(image: Buffer, mimeType: string): Promise<Record<string, unknown>> {
  const config = getVlmConfig()
  if (!config) throw new VlmUnavailableError("VLM is not configured")
  let res: Response
  try {
    res = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      body: JSON.stringify({
        model: config.model,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${mimeType};base64,${image.toString("base64")}` } },
            { type: "text", text: STATEMENT_PAGE_PROMPT },
          ],
        }],
        max_tokens: 6000,
        temperature: 0,
      }),
    })
  } catch (err) {
    throw new VlmUnavailableError(`VLM request failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok) throw new VlmUnavailableError(`VLM responded ${res.status}`)
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return parseVlmResponse(json.choices?.[0]?.message?.content ?? "")
}

/**
 * Reads page images. Returns null when the model gave nothing usable on any
 * page; throws VlmUnavailableError when the model could not be asked, which is
 * transient and must not be persisted as a read.
 */
export async function readWithVlm(images: Buffer[], mimeType: string): Promise<StatementRead | null> {
  const pages: StatementRead[] = []
  for (let i = 0; i < images.length; i++) {
    pages.push(parsePage(await readPage(images[i], mimeType), i + 1))
  }
  const read = combinePages(pages)
  return read.transactions.length > 0 || read.openingBalanceCents !== null ? read : null
}
