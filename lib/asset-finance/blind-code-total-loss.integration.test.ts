import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sastCalendarDate } from '@/lib/date/sast'
import { cleanupDealFixture, dealFixtureTenantId } from './deal.integration-fixture'
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from './lease.integration-fixture'
import type { SessionUser } from './payout-booking.integration-fixture'
import { recordLeaseTotalLoss } from './lease-total-loss'
import { invoiceEndOfTerm, completeEndOfTermIfSettled } from './lease-end-invoice'
import { payAllOwed } from './lease-servicing.integration-fixture'
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock('@/lib/auth', () => ({ auth: vi.fn(async () => session.current) }))
const run = process.env.RUN_ASSET_FINANCE_LEASE_IT === '1'
const db = run ? new PrismaClient() : null
const database = () => { if (!db) throw new Error('integration DB required'); return db }
const token = randomUUID().replaceAll('-', '').slice(0,16)
let fx: LeaseFixture
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: 'LOAN_ADMIN' | 'CREDIT_OFFICER') => setSession({ id, role, email: `${id}@invalid.test`, tenantId: fx.tenantId })
;(run ? describe : describe.skip)('blind code reviewer total-loss closure repro', () => {
 beforeAll(async () => { process.env.TRUSTED_PROXY = '1'; fx = await createLeaseFixture(database(), token) }, 120000)
 afterAll(async () => {
  await cleanupLeaseRows(database(), dealFixtureTenantId(token)).catch(() => undefined)
  await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(token) })
  await db?.$disconnect()
 }, 60000)
 it('OBSERVED BUG: a fully paid stolen lease cannot complete without fabricated inspection', async () => {
  const dealId = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[0], entityId: fx.evidenced, contractType: 'OPERATING_LEASE', rentalTiming: 'ARREARS' }))
  await signLease(fx, database(), setSession, dealId)
  const loanId = await payoutAndBook(fx, database(), staff, dealId)
  const actor = { tenantId: fx.tenantId, userId: fx.adminA }
  const today = sastCalendarDate(new Date())
  const loss = await database().$transaction(tx => recordLeaseTotalLoss(tx as never, actor, { loanId, today, insuranceProceedsCents: 0, evidence: 'Synthetic unrecovered theft confirmation' }))
  expect(loss.kind).toBe('recorded')
  await payAllOwed(database(), fx, loanId)
  const billed = await database().$transaction(tx => invoiceEndOfTerm(tx as never, actor, { loanId, today }))
  expect(billed).toMatchObject({ kind: 'refused', reason: 'not_ready', error: 'The end of term is ELECTED: inspect first' })
  const closed = await database().$transaction(tx => completeEndOfTermIfSettled(tx as never, { tenantId: fx.tenantId, loanId, userId: fx.adminA }))
  expect(closed).toBe(false)
  expect(await database().leaseEndOfTerm.findFirst({ where: { loanId } })).toMatchObject({ status: 'ELECTED', outcome: 'RETURN' })
 }, 120000)
})
