import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OLD_IMAGE, RESTORE_BY_MOUNT, commits, data, idx, installStackHooks, pinned, repo, root, run, short, worktrees } from './upgrade-stack.harness'

// upgrade-stack.sh's order, swap, verification and rollback, against stubs (see
// upgrade-stack.harness.ts).

installStackHooks()

const image = () => `credaflow:fairscore-${short('c2')}`
const curls = (calls: string[]) => calls.filter((c) => c.startsWith('curl '))
const ups = (calls: string[]) => calls.filter((c) => c.startsWith('docker-compose') && c.includes(' up '))

describe('upgrade-stack.sh swap', () => {
  it('runs precheck, compose check, npm ci, migrate status, build, backup, dump check, migrate, pin, up and health in that order, and cleans up', () => {
    const r = run([commits.c2!])
    expect(r.status).toBe(0)
    const order = [
      idx(r.calls, '"Tenant"'), idx(r.calls, ' config -q'), idx(r.calls, 'npm ci'), idx(r.calls, 'prisma migrate status'),
      idx(r.calls, 'docker build'), idx(r.calls, 'pg_dump'), idx(r.calls, 'pg_restore -f /dev/null'), idx(r.calls, 'prisma migrate deploy'),
      idx(r.calls, ' up -d'), r.calls.findIndex((c) => c.startsWith('curl ')),
    ]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    // The pin was written before compose ran, and compose ran in the stack dir with the project pinned.
    const [up] = ups(r.calls)
    expect(up).toContain('-p credaflow-fairscore -f docker-compose.demo.yml up -d --no-deps app app-portal')
    expect(up).toContain(`cwd=fairscore APP_IMAGE=${image()}`)
    expect(pinned('APP_IMAGE')).toBe(image())
    expect(pinned('GIT_SHA')).toBe(`fairscore-${short('c2')}`)
    expect(pinned('BUILD_TIME')).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(r.stdout.trim()).toMatch(new RegExp(`${image()}.*healthy`))
    expect(readFileSync(join(data, 'logs', 'last-upgrade'), 'utf8')).toMatch(new RegExp(`ok .*${short('c2')}`))
    expect(worktrees()).toEqual([`worktree ${repo}`])
  })

  // #147 review: the migration adding TenantConfig.isDemoLender leaves it false
  // on the demo tenant, and the demo's simulated Section 129 email needs it.
  it('marks the demo db tenants as demo lenders right after migrate deploy, before the pin', () => {
    const r = run([commits.c2!])
    expect(r.status).toBe(0)
    const marker = idx(r.calls, 'UPDATE "TenantConfig" SET "isDemoLender" = true')
    expect(marker).toBeGreaterThan(idx(r.calls, 'prisma migrate deploy'))
    expect(marker).toBeLessThan(idx(r.calls, ' up -d'))
    expect(r.calls[marker]).toMatch(/exec -e DB=\S+ -e SQL=/)
  })

  it('builds from the temp worktree at the commit, with the live stack build args', () => {
    const r = run([commits.c2!])
    const build = r.calls.find((c) => c.startsWith('docker build'))!
    expect(build).toContain(`-t ${image()}`)
    expect(build).toContain('--build-arg NEXT_PUBLIC_TENANT_SLUG=acme')
    expect(build).toContain('--build-arg NEXT_PUBLIC_PORTAL_LOGIN_URL=https://fairscore.example.invalid/portal/login')
    expect(build).toContain('--build-arg NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA')
    expect(build).not.toContain(` ${repo}`)
    expect(build).not.toMatch(new RegExp(`-f ${repo}`))
  })

  it('skips the build when the image already exists', () => {
    const r = run([commits.c2!], { STUB_IMAGE_EXISTS: '1' })
    expect(r.status).toBe(0)
    expect(r.calls.some((c) => c.startsWith('docker build'))).toBe(false)
    expect(r.out).toMatch(/already exists; not rebuilding/)
    expect(pinned('APP_IMAGE')).toBe(image())
  })
})

describe('upgrade-stack.sh post-swap verification', () => {
  it('asks each container for health, then each mapped host for its login page, every curl with --max-time', () => {
    const r = run([commits.c2!])
    const all = curls(r.calls)
    expect(all.every((c) => /--max-time \d+/.test(c))).toBe(true)
    expect(all.filter((c) => c.includes('/api/health'))).toHaveLength(2)
    for (const host of ['fairscore.example.invalid', 'fairscore-staff.example.invalid']) {
      expect(all.some((c) => c.includes(` -H Host: ${host} `) && c.endsWith('http://127.0.0.1:3330/login'))).toBe(true)
      expect(all.some((c) => c.includes(` -H Host: ${host} `) && c.endsWith('http://127.0.0.1:3332/portal/login'))).toBe(true)
    }
    expect(all).toHaveLength(6)
    expect(r.calls).toContain('docker inspect -f {{.Config.Image}} credaflow-fairscore-app')
    expect(r.calls).toContain('docker inspect -f {{.Config.Image}} credaflow-fairscore-portal')
  })

  it.each([
    ['the staff login page does not resolve the tenant', { STUB_PAGE_FAIL: ':3330/login' }, /returned 404/],
    ['the portal login page does not resolve the tenant', { STUB_PAGE_FAIL: ':3332/portal/login' }, /returned 404/],
    ['a container is not running the new image', { STUB_RUNNING_IMAGE: 'credaflow:fairscore-stale' }, /runs credaflow:fairscore-stale, not credaflow:fairscore-/],
  ])('rolls back when %s', (_what, env, message) => {
    const r = run([commits.c2!], env)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(message)
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
    expect(ups(r.calls)).toHaveLength(2)
  })
})

describe('upgrade-stack.sh rollback', () => {
  it('a failed health check rolls the pin back, brings the old image up again and exits 1', () => {
    const r = run([commits.c2!], { STUB_HEALTH_FAIL_IMAGE: image() })
    expect(r.status).toBe(1)
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
    expect(pinned('GIT_SHA')).toBe(`fairscore-${short('c1')}`)
    expect(pinned('BUILD_TIME')).toBe('2026-01-01T00:00:00Z')
    const both = ups(r.calls)
    expect(both).toHaveLength(2)
    expect(both[0]).toContain(`APP_IMAGE=${image()}`)
    expect(both[1]).toContain(`APP_IMAGE=${OLD_IMAGE}`)
    expect(r.out).toMatch(/old code on the new schema/)
    expect(r.out).toMatch(RESTORE_BY_MOUNT)
    expect(readFileSync(join(data, 'logs', 'last-upgrade'), 'utf8')).toMatch(/failed /)
    expect(worktrees()).toEqual([`worktree ${repo}`])
  })

  it('rolls back when only the portal fails its health check', () => {
    const r = run([commits.c2!], { STUB_HEALTH_FAIL_IMAGE: image(), STUB_HEALTH_FAIL_ADDR: ':3332' })
    expect(r.status).toBe(1)
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
    expect(ups(r.calls)).toHaveLength(2)
    expect(r.out).toMatch(/previous image .* is live again/)
  })

  it('rolls back when compose up itself fails after the pin', () => {
    const r = run([commits.c2!], { STUB_COMPOSE_FAIL_UP_IMAGE: image() })
    expect(r.status).toBe(1)
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
    const both = ups(r.calls)
    expect(both).toHaveLength(2)
    expect(both[1]).toContain(`APP_IMAGE=${OLD_IMAGE}`)
    expect(r.out).toMatch(/FAILED during start app \+ portal/)
    expect(r.out).toMatch(/old code on the new schema/)
  })

  it('says so, and still puts the pin back, when the old image does not come back healthy either', () => {
    const r = run([commits.c2!], { STUB_HEALTH_FAIL_ALL: '1' })
    expect(r.status).toBe(1)
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
    expect(ups(r.calls)).toHaveLength(2)
    expect(r.out).toMatch(/BUT app\/portal did not come back healthy/)
    expect(r.out).toMatch(RESTORE_BY_MOUNT)
    expect(readFileSync(join(data, 'logs', 'last-upgrade'), 'utf8')).toMatch(/BUT app\/portal did not come back healthy/)
  })

  it('does not claim the previous image is live when the containers run something else after the rollback', () => {
    const r = run([commits.c2!], { STUB_HEALTH_FAIL_IMAGE: image(), STUB_RUNNING_IMAGE: 'credaflow:fairscore-stale' })
    expect(r.status).toBe(1)
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
    expect(r.out).toMatch(/credaflow-fairscore-app runs credaflow:fairscore-stale, not /)
    expect(r.out).toMatch(/NOT running credaflow:fairscore-/)
    expect(r.out).not.toMatch(/is live again/)
  })

  it('claims it only after docker inspect shows the previous image on both containers', () => {
    const r = run([commits.c2!], { STUB_HEALTH_FAIL_IMAGE: image() })
    expect(r.out).toMatch(new RegExp(`previous image ${OLD_IMAGE} is live again`))
    const inspects = r.calls.filter((c) => c === 'docker inspect -f {{.Config.Image}} credaflow-fairscore-app')
    expect(inspects.length).toBeGreaterThanOrEqual(2) // the downgrade check/verify, then the rollback check
  })
})

describe('upgrade-stack.sh compose environment', () => {
  const leaks = { APP_IMAGE: 'credaflow:evil', GIT_SHA: 'evil', BUILD_TIME: 'evil', POSTGRES_USER: 'evil', POSTGRES_PASSWORD: 'evil', POSTGRES_DB: 'evil', PORTAL_AUTH_URL: 'https://evil.invalid' }

  it('runs every docker-compose call without the shell exports that would override .env (every key .env defines, e.g. PORTAL_AUTH_URL)', () => {
    const r = run([commits.c2!], leaks)
    expect(r.status).toBe(0)
    expect(r.calls.filter((c) => c.startsWith('docker-compose')).length).toBe(2)
    expect(existsSync(join(root, 'compose.leaked'))).toBe(false)
    expect(pinned('APP_IMAGE')).toBe(image())
  })

  it('does the same on the rollback up', () => {
    const r = run([commits.c2!], { ...leaks, STUB_HEALTH_FAIL_IMAGE: image() })
    expect(r.status).toBe(1)
    expect(r.calls.filter((c) => c.startsWith('docker-compose'))).toHaveLength(3)
    expect(existsSync(join(root, 'compose.leaked'))).toBe(false)
  })
})
