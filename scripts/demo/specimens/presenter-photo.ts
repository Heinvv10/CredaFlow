/**
 * The presenter's portrait for the live-demo personas' ID cards
 * (decided 2026-10-10): with it on the card, a live selfie during a demo genuinely
 * passes the VLM face match.
 *
 * It is a real person's face. It lives only in scripts/demo/.private/
 * (gitignored, chmod 700) and in the generated ID cards, which go to an
 * untracked output directory. Never copy it into a tracked path, never log it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Persona } from '../personas/types'

export const PRESENTER_PHOTO = resolve(__dirname, '..', '.private', 'presenter.jpg')

/**
 * The photo when any of `personas` is a live-demo persona, else undefined.
 * Throws when a live-demo persona is requested and the file is missing: a
 * photo-less live card would make the live selfie fail on stage.
 */
export function presenterPhotoFor(personas: readonly Persona[], file = PRESENTER_PHOTO): Buffer | undefined {
  const live = personas.filter((p) => p.kind === 'live-demo').map((p) => p.id)
  if (live.length === 0) return undefined
  if (!existsSync(file)) {
    throw new Error(
      `live-demo persona(s) ${live.join(', ')} need the presenter photo at ${file}, and it is missing. ` +
        'Put the presenter\'s portrait JPEG there (the directory is gitignored; keep it chmod 700), ' +
        'or generate background personas only (--persona bg-NN).',
    )
  }
  return readFileSync(file)
}
