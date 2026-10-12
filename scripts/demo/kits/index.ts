/**
 * Writes the live-demo kits (see build.ts for the CLI).
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Persona } from '../personas/types'
import { generateSpecimens } from '../specimens'
import { cheatSheetFor, cheatSheetMarkdown, kitReadme, type KitEntry } from './cheat-sheet'
import { renderCheatSheetPdf } from './cheat-sheet-pdf'

/** Writes one kit per persona under `out` (created chmod 700) and the README. */
export async function buildKits(
  personas: readonly Persona[],
  asOf: string,
  out: string,
  presenterPhoto: Buffer,
): Promise<KitEntry[]> {
  mkdirSync(out, { recursive: true, mode: 0o700 })
  chmodSync(out, 0o700)
  const entries: KitEntry[] = []
  for (const p of personas) {
    const manifest = await generateSpecimens(p, asOf, out, { presenterPhoto })
    const dir = join(out, p.id)
    chmodSync(dir, 0o700)
    const sheet = cheatSheetFor(p, manifest.documents)
    writeFileSync(join(dir, 'CHEAT-SHEET.md'), cheatSheetMarkdown(sheet))
    writeFileSync(join(dir, 'CHEAT-SHEET.pdf'), await renderCheatSheetPdf(sheet))
    entries.push({ persona: p, folder: p.id })
  }
  writeFileSync(join(out, 'README.md'), kitReadme(asOf, entries))
  return entries
}
