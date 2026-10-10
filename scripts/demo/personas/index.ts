/**
 * The demo persona roster: 3 live-demo personas plus 42 background personas
 * spread across every lifecycle storyline the simulator must reach.
 *
 * Stable across runs: ids, indexes and the storyline plan are fixed here, and
 * every other value is derived from a PRNG seeded by the persona id.
 */
import { buildPersona, type PersonaSpec } from './build'
import { RESERVED_FULL_NAMES } from './catalog'
import { LIVE_DEMO_SPECS } from './live-demo'
import type { Persona, Storyline } from './types'

export type { Persona, Storyline } from './types'

/** How many background personas each storyline gets, in roster order. */
export const BACKGROUND_PLAN: ReadonlyArray<readonly [Storyline, number]> = [
  ['settled', 6],
  ['active', 8],
  ['arrears-30', 3],
  ['arrears-60', 2],
  ['arrears-90', 2],
  ['s129', 2],
  ['payment-plan', 2],
  ['written-off', 2],
  ['declined', 4],
  ['withdrawn', 2],
  ['origination-draft', 2],
  ['origination-submitted', 2],
  ['origination-under-review', 2],
  ['origination-approved', 2],
  ['origination-signed', 1],
]

const SUMMARIES: Readonly<Record<Storyline, string>> = {
  'live-clean-approve': '',
  'live-affordability-decline': '',
  'live-returning-client': '',
  settled: 'Loan repaid in full; account closed.',
  active: 'Loan disbursed and up to date.',
  'arrears-30': 'Missed one instalment; ~30 days past due.',
  'arrears-60': 'Missed two instalments; ~60 days past due.',
  'arrears-90': 'Missed three instalments; ~90 days past due.',
  s129: 'In arrears long enough to receive a Section 129 notice.',
  'payment-plan': 'Fell into arrears and agreed a payment arrangement.',
  'written-off': 'Defaulted; balance written off.',
  declined: 'Application declined on affordability.',
  withdrawn: 'Application cancelled by the applicant before approval.',
  'origination-draft': 'Application started, not yet submitted.',
  'origination-submitted': 'Application submitted; documents not yet reviewed.',
  'origination-under-review': 'Documents uploaded and extracted; awaiting credit decision.',
  'origination-approved': 'Approved; agreement not yet signed.',
  'origination-signed': 'Agreement and mandate signed; awaiting countersign and payout.',
}

function backgroundSpecs(): PersonaSpec[] {
  const specs: PersonaSpec[] = []
  let index = LIVE_DEMO_SPECS.length + 1
  for (const [storyline, count] of BACKGROUND_PLAN) {
    for (let i = 0; i < count; i++) {
      specs.push({
        index,
        id: `bg-${String(index).padStart(2, '0')}`,
        kind: 'background',
        storyline,
        summary: SUMMARIES[storyline],
        profile: storyline === 'declined' ? 'over-indebted' : 'affordable',
      })
      index++
    }
  }
  return specs
}

/**
 * Unique full names keep emails unique (Contact identity is unique per channel)
 * and keep a presenter from confusing two people on screen. A colliding
 * background persona redraws its name with the next salt — deterministic,
 * because the roster is always built in the same order.
 */
function buildRoster(): readonly Persona[] {
  const seen = new Set(RESERVED_FULL_NAMES)
  return [...LIVE_DEMO_SPECS, ...backgroundSpecs()].map((spec) => {
    for (let nameSalt = 0; nameSalt < 50; nameSalt++) {
      const persona = buildPersona({ ...spec, nameSalt })
      const name = `${persona.firstName} ${persona.lastName}`
      if (!seen.has(name)) {
        seen.add(name)
        return persona
      }
      if (spec.fixed?.firstName) throw new Error(`pinned persona ${spec.id} repeats "${name}"`)
    }
    throw new Error(`could not find a unique name for ${spec.id}`)
  })
}

export const PERSONAS: readonly Persona[] = buildRoster()

export const LIVE_DEMO_PERSONAS: readonly Persona[] = PERSONAS.filter((p) => p.kind === 'live-demo')

export function getPersona(id: string): Persona {
  const persona = PERSONAS.find((p) => p.id === id)
  if (!persona) throw new Error(`no persona "${id}"`)
  return persona
}
