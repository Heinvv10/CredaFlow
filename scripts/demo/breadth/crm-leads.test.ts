import { describe, expect, it } from 'vitest'
import {
  affordabilityExpenseEvidenceNeedsMleJustification,
  createAffordabilityExpenseEvidence,
} from '@/lib/affordability/snapshot'
import { deriveGenderFromSaId, isValidSaIdNumber } from '@/lib/validation/client-wizard'
import { PERSONAS } from '../personas'
import { LEADS, leadPerson } from './crm-leads'

const people = LEADS.map((spec, i) => ({ spec, who: leadPerson(spec, i) }))

describe('CRM leads', () => {
  it('give each prospect a valid SA ID number of their own, never a persona\'s', () => {
    const personaIds = new Set(PERSONAS.map((p) => p.idNumber))
    for (const { spec, who } of people) {
      expect({ key: spec.key, valid: isValidSaIdNumber(who.idNumber), gender: deriveGenderFromSaId(who.idNumber) })
        .toEqual({ key: spec.key, valid: true, gender: who.gender })
      expect(personaIds.has(who.idNumber)).toBe(false)
    }
    expect(new Set(people.map(({ who }) => who.idNumber)).size).toBe(people.length)
  })

  it('convert only as the last step, with expenses the conversion\'s Regulation 23A gate accepts', () => {
    const converting = people.filter(({ spec }) => spec.path.some(([, s]) => s === 'convert'))
    expect(converting.map(({ spec }) => spec.key)).toEqual(['L07', 'L08', 'L09'])
    for (const { spec, who } of converting) {
      expect(spec.path.at(-1)?.[1]).toBe('convert')
      const evidence = createAffordabilityExpenseEvidence({ monthlyIncome: who.incomeCents, monthlyExpenses: who.expensesCents })
      expect({ key: spec.key, needsJustification: affordabilityExpenseEvidenceNeedsMleJustification(evidence) })
        .toEqual({ key: spec.key, needsJustification: false })
    }
  })
})
