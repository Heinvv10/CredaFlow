import { expect, it } from 'vitest'
import { computeNonNcaCharges } from './non-nca-charges'
const date=(day:string)=>new Date(`${day}T12:00:00+02:00`)
it('independent stopped-history grid retains fixed paid shares and only new certified cost debt through partial receipts and reversal',()=>{
 for(const cost of [0,1,25000]) for(const first of [0,1,10000,30000]) for(const second of [0,1,17000]) {
  const old={id:'pre-stop',amount:3000,receivedAt:date('2026-09-20'),defaultInterestAllocated:1000,chargeFeesAllocated:2000}
  const fresh=[{id:'first',amount:first,receivedAt:date('2026-09-22')},{id:'second',amount:second,receivedAt:date('2026-09-23')}].filter(r=>r.amount>0)
  const input={schedule:[{id:'zero',dueDate:date('2026-12-01'),principalDue:0,interestDue:0,feesDue:0,totalDue:0}],receipts:[old,...fresh],interestRatePm:.02,maturityDate:date('2026-12-01'),asOf:date('2026-10-10'),startDate:date('2026-01-01'),accrueFrom:date('2026-01-01'),defaultInterestMargin:.02,collectionFeeCents:9999,stoppedCharges:{at:date('2026-09-20'),receipts:[old]},recoveryCosts:[{id:'new',date:date('2026-09-21'),amount:cost,assessedLeaseCancellation:true},{id:'forgiven-ordinary',date:date('2026-09-21'),amount:9999}]}
  const result=computeNonNcaCharges(input)
  expect(result.feesOutstanding).toBe(Math.max(0,cost-first-second))
  expect(result.feesPaid).toBe(2000+Math.min(cost,first+second))
  expect(result.interestPaid).toBe(1000)
  expect(result.interestOutstanding).toBe(0)
  expect(result.receiptSplits[0]).toEqual({receiptId:'pre-stop',toDefaultInterest:1000,toFees:2000,toSchedule:0})
  expect(result.postings.some(p=>p.sourceId==='forgiven-ordinary')).toBe(false)
  const reversed=computeNonNcaCharges({...input,receipts:[old,...fresh.filter(r=>r.id!=='second')]})
  expect(reversed.feesOutstanding).toBe(Math.max(0,cost-first))
 }
})
