import { describe, expect, it } from 'vitest'
import { DEMO_LENDERS } from '@/prisma/demo-lender'
import { STAFF, staffFor } from './breadth/staff'
import { buildPersona } from './personas/build'
import { LIVE_DEMO_SPECS } from './personas/live-demo'

const { acme, fairscore } = DEMO_LENDERS

describe('the simulator under DEMO_LENDER', () => {
  it('defaults the breadth staff to the Acme domain', () => {
    expect(Object.values(STAFF).map((s) => s.email)).toEqual([
      'lindiwe.mahlangu@acme-lending.example',
      'priya.govender@acme-lending.example',
      'pieter.steyn@acme-lending.example',
      'operator@credaflow-platform.example',
    ])
  })

  it('puts the lender staff on the Fairscore domain and leaves the platform operator alone', () => {
    const staff = staffFor(fairscore)
    expect(staff.officer2.email).toBe('lindiwe.mahlangu@fairscore.example')
    expect(staff.insurance.email).toBe('priya.govender@fairscore.example')
    expect(staff.branchManager.email).toBe('pieter.steyn@fairscore.example')
    expect(staff.operator).toEqual(STAFF.operator)
  })

  it.each(LIVE_DEMO_SPECS.map((s) => [s.id, s] as const))('%s differs between lenders only in its email domain', (_id, spec) => {
    const a = buildPersona(spec)
    const f = buildPersona(spec, fairscore)
    expect(buildPersona(spec, acme)).toEqual(a)
    expect(a.email).toMatch(/@acme-lending\.invalid$/)
    expect(f.email).toBe(a.email.replace('@acme-lending.invalid', '@fairscore.invalid'))
    expect({ ...f, email: a.email }).toEqual(a)
  })
})
