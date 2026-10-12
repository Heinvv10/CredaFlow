/**
 * Builds the live-demo kits: per live persona, the SPECIMEN documents to
 * upload (ID card with the presenter photo, three payslips, bank statement),
 * their manifest, and a one-page cheat sheet (Markdown + PDF); plus a README
 * with the running order.
 *
 *   npx tsx scripts/demo/kits/build.ts [--as-of YYYY-MM-DD] [--out <dir>]
 *
 * --as-of defaults to today in SAST; --out to ~/credaflow-demo-data/kits/<as-of>/.
 * The output directory is created chmod 700: the ID cards show a real face.
 */
import { resolve } from 'node:path'
import { LIVE_DEMO_PERSONAS } from '../personas'
import { parseIsoDate, sastToday } from '../specimens/pay-schedule'
import { presenterPhotoFor } from '../specimens/presenter-photo'
import { buildKits } from './index'
import { defaultKitDir } from './layout'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const value = process.argv[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return value
}

async function main(): Promise<void> {
  const asOf = arg('as-of') ?? sastToday()
  parseIsoDate(asOf)
  const out = resolve(arg('out') ?? defaultKitDir(asOf))
  const photo = presenterPhotoFor(LIVE_DEMO_PERSONAS)
  if (!photo) throw new Error('no live-demo personas in the roster')
  const entries = await buildKits(LIVE_DEMO_PERSONAS, asOf, out, photo)
  for (const e of entries) process.stderr.write(`${e.folder.padEnd(28)} ${e.persona.firstName} ${e.persona.lastName}\n`)
  process.stderr.write(`wrote ${entries.length} kit(s) to ${out} (as of ${asOf})\n`)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
