/**
 * The CSV valuation guide: a lender uploads a dated guide file (../csv.ts
 * reads it). The sha256 is of the bytes as uploaded.
 */
import { createHash } from "node:crypto"
import { parseGuideCsv } from "../csv"
import type { ValuationProvider } from "../types"

export const csvGuideProvider: ValuationProvider = {
  id: "csv",
  label: "Uploaded CSV guide",
  simulated: false,
  assertUsable() {},
  async readGuide({ bytes }) {
    if (!bytes) return { ok: false, problems: [{ line: 1, reason: "Choose the CSV file to upload" }], total: 1 }
    const parsed = parseGuideCsv(bytes)
    if (!parsed.ok) return parsed
    return { ok: true, rows: parsed.rows, sha256: createHash("sha256").update(bytes).digest("hex") }
  },
}
