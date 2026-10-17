import { expect, it } from 'vitest'
import { leaseRentalFloorPlan } from './lease-rental-floor'
import { periodInterest } from './amortise'
import { rateDaySum, rateSegments } from './rates'
import { toDayNumber } from './dates'
it('independent grid reconciles historical credits and zero future rental to retained funding', () => {
 for (const principal of [1,7,100000]) for (const residual of [0,Math.floor(principal*.3),Math.floor(principal*.9)]) for (const rate of [0,.01,.2375]) for (const payment of [100,60000]) for (const paid of [0,1]) {
  const rentals=['2026-02-01','2026-03-01','2026-04-01','2026-05-01'].map(dueDate=>({dueDate,rentalExclVatCents:payment}))
  const input={openingCents:principal,residualCents:residual,startDate:'2026-01-01',effectiveDate:'2026-01-01',paidThroughIndex:paid,keptThroughIndex:paid,ratePath:[{effectiveDate:'2026-01-01',annualRate:rate}],rentals}
  const result=leaseRentalFloorPlan(input)
  if (!result) continue
  let balance=principal, day=toDayNumber(input.startDate)
  const path=rateSegments(input.ratePath,day)
  for (const [index,rental] of rentals.entries()) {
   expect(balance).toBeGreaterThanOrEqual(0)
   const next=toDayNumber(rental.dueDate)
   balance+=periodInterest(balance,rateDaySum(path,day,next))-result.rentals[index]
   day=next
   if(index>paid) expect(result.rentals[index]).toBe(0)
  }
  expect(balance).toBe(result.endingCapitalCents)
  expect(balance+result.lessorFundingDifferenceCents).toBe(residual)
  expect(result.credits.reduce((sum,c)=>sum+c.exclVatCents,0)).toBe((paid+1)*payment-result.rentals.slice(0,paid+1).reduce((sum,c)=>sum+c,0))
  expect(result.credits.every(c=>c.index<=paid && c.exclVatCents>0 && c.exclVatCents<=payment)).toBe(true)
 }
})
