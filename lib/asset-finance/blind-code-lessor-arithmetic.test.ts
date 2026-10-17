import { expect, it } from 'vitest'
import { assessLessorCancellation } from './lessor-cancellation-assessment'
import { CPA_CANCELLATION_FACTORS } from './cpa-cancellation-assessment'
it('independent small-cent grid preserves net assessment, costs, VAT and surplus identity', () => {
 const factors = Object.fromEntries(CPA_CANCELLATION_FACTORS.map(([key]) => [key, 'Synthetic case-specific factor finding']))
 for (const pv of [0,1,2,6,7,11,100003]) for (const goods of [0,1,6,80,300000]) for (const costs of [0,1,37,40000]) {
  const input = { pvExclVatCents: pv, undiscountedRentalsCents: 150000, netProceedsCents: goods, chargedCosts: [{id:'b',grossCents:costs},{id:'a',grossCents:3}], vatRateTenThousandths:1500 }
  const ceiling = Math.max(0, Math.min(pv+Math.round(pv*.15)+costs+3-goods,149999))
  for (const assessment of [0,Math.floor(ceiling/2),ceiling]) {
   const r=assessLessorCancellation(input,{assessedChargeCents:assessment,factors,rationale:'Synthetic proportionate reduction',fairnessReason:'Synthetic CPA fairness assessment'})
   expect(Math.max(0,r.damagesInclVatCents+r.chargedCostsCents-goods)).toBe(assessment)
   expect(r.chargedCostsCents+r.costConcessionCents).toBe(costs+3)
   expect(r.costAllocations.reduce((sum,c)=>sum+c.collectibleCents,0)).toBe(r.chargedCostsCents)
   expect(r.costAllocations.reduce((sum,c)=>sum+c.actualCents,0)).toBe(costs+3)
   expect(r.damagesExclVatCents).toBe(Math.round(r.damagesInclVatCents/1.15))
   expect(r.damagesInclVatCents).toBeLessThanOrEqual(pv+Math.round(pv*.15))
  }
 }
})
