/**
 * Write SPECIMEN documents + manifest.json for demo personas.
 *
 *   npx tsx scripts/demo/specimens/generate.ts [--persona <id>] [--out scripts/demo/.out] [--as-of YYYY-MM-DD]
 *
 * --as-of defaults to today in SAST; documents are dated relative to it (the
 * three most recent pay dates on or before it). Same persona + same as-of =
 * byte-identical files.
 *
 * Live-demo personas' ID cards carry the presenter photo
 * (presenter-photo.ts); the run fails if one is requested and the photo is
 * missing. Those cards show a real face — keep --out outside git.
 */
import { resolve } from 'node:path'
import { PERSONAS, getPersona } from '../personas'
import { generateSpecimens } from './index'
import { parseIsoDate, sastToday } from './pay-schedule'
import { presenterPhotoFor } from './presenter-photo'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return undefined
  const value = process.argv[i + 1]
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`)
  return value
}

async function main(): Promise<void> {
  const personaId = arg('persona')
  const out = resolve(arg('out') ?? 'scripts/demo/.out')
  const asOf = arg('as-of') ?? sastToday()
  parseIsoDate(asOf)
  const personas = personaId ? [getPersona(personaId)] : PERSONAS
  const presenterPhoto = presenterPhotoFor(personas)
  for (const p of personas) {
    const manifest = await generateSpecimens(p, asOf, out, { presenterPhoto })
    process.stderr.write(`${p.id.padEnd(28)} ${manifest.documents.length} files  ${p.firstName} ${p.lastName}\n`)
  }
  process.stderr.write(`wrote ${personas.length} persona(s) to ${out} (as of ${asOf})\n`)
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
