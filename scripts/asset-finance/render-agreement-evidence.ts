// Renders the synthetic instalment sale agreement (legal wording NOT approved,
// so it carries the DRAFT watermark) to docs/asset-finance/evidence/slice1/
// and, when pdftoppm is installed, a PNG of page 1 beside it.
//
//   npx tsx scripts/asset-finance/render-agreement-evidence.ts
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { renderInstalmentSaleAgreement } from "@/lib/asset-finance/documents/agreement-pdf"
import { syntheticDealDocumentData } from "@/lib/asset-finance/documents/synthetic-deal"

async function main(): Promise<void> {
  const dir = join(process.cwd(), "docs/asset-finance/evidence/slice1")
  mkdirSync(dir, { recursive: true })
  const pdf = join(dir, "agreement-draft.pdf")
  writeFileSync(pdf, await renderInstalmentSaleAgreement(syntheticDealDocumentData()))
  process.stdout.write(`wrote ${pdf}\n`)
  const prefix = join(dir, "agreement-draft-watermark")
  const result = spawnSync("pdftoppm", ["-png", "-r", "80", "-f", "1", "-l", "1", "-singlefile", pdf, prefix], { encoding: "utf8" })
  if (result.status !== 0) {
    process.stderr.write(`pdftoppm failed or is not installed: ${result.stderr ?? result.error?.message ?? ""}\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write(`wrote ${prefix}.png\n`)
}

void main()
