import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENCODED_PASSWORD, OLD_IMAGE, PASSWORD, RESTORE_BY_MOUNT, RESTORE_BY_STDIN, commits, data, idx, installStackHooks, live, log, mutating, pinned, repo, root, run, short, worktrees } from './upgrade-stack.harness'

// upgrade-stack.sh from the worktree to the migration: install, build, pre-flights,
// backup and migrate, against stubs (see upgrade-stack.harness.ts).

installStackHooks()

const expectStackUntouched = () => {
  expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
  expect(worktrees()).toEqual([`worktree ${repo}`])
}

describe('upgrade-stack.sh install and build', () => {
  it.each([
    ['npm ci', { STUB_NPM_FAIL: '1' }, /FAILED during npm ci/],
    ['the build', { STUB_BUILD_FAIL: '1' }, /FAILED during build credaflow:fairscore-/],
  ])('a failing %s dies before any backup, migration or swap, and says the stack was not touched', (_what, env, message) => {
    const r = run([commits.c2!], env)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(message)
    expect(r.out).toMatch(/the running stack was not touched/)
    expect(r.calls.some((c) => c.includes('pg_dump') || c.includes('migrate deploy') || c.includes(' up -d'))).toBe(false)
    expect(existsSync(join(live, 'backups'))).toBe(false)
    expect(readFileSync(join(data, 'logs', 'last-upgrade'), 'utf8')).toMatch(/^\S+ failed .*credaflow-fairscore/)
    expectStackUntouched()
  })

  it('a failing npm ci stops before migrate status and the build; a failing build comes after both', () => {
    const npm = run([commits.c2!], { STUB_NPM_FAIL: '1' })
    expect(npm.calls.some((c) => c.includes('prisma migrate') || c.startsWith('docker build'))).toBe(false)
    const build = run([commits.c2!], { STUB_BUILD_FAIL: '1' })
    expect(idx(build.calls, 'prisma migrate status')).toBeGreaterThan(-1)
    expect(idx(build.calls, ' config -q')).toBeGreaterThan(-1)
  })

  it('reuses an existing image only when its credaflow.tenant_slug label is the NEXT_PUBLIC_TENANT_SLUG', () => {
    const r = run([commits.c2!], { STUB_IMAGE_EXISTS: '1', STUB_IMAGE_LABEL: 'acme' })
    expect(r.status).toBe(0)
    expect(r.calls.some((c) => c.startsWith('docker build'))).toBe(false)
    expect(r.calls).toContain(`docker image inspect -f {{index .Config.Labels "credaflow.tenant_slug"}} credaflow:fairscore-${short('c2')}`)
  })

  it.each([
    ['another tenant slug', 'fairscore'],
    ['no label (built before the label existed)', ''],
  ])('refuses an existing image labelled with %s, before any backup or swap', (_what, label) => {
    const r = run([commits.c2!], { STUB_IMAGE_EXISTS: '1', STUB_IMAGE_LABEL: label })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(new RegExp(`credaflow:fairscore-${short('c2')} was built for tenant slug '${label}'.*NEXT_PUBLIC_TENANT_SLUG is 'acme'.*docker rmi`))
    expect(r.calls.some((c) => c.startsWith('docker build') || c.includes('pg_dump') || c.includes('prisma migrate'))).toBe(false)
    expectStackUntouched()
  })

  it('builds with the slug label', () => {
    const r = run([commits.c2!])
    expect(r.calls.find((c) => c.startsWith('docker build'))).toContain('--label credaflow.tenant_slug=acme')
  })
})

describe('upgrade-stack.sh pre-flights', () => {
  it('validates the compose file from the stack dir before the backup, and dies, touching nothing, when it fails', () => {
    const r = run([commits.c2!], { STUB_COMPOSE_FAIL: 'config' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/docker-compose config failed/)
    expect(r.calls.filter((c) => c.startsWith('docker-compose'))).toEqual([
      `docker-compose -p credaflow-fairscore -f docker-compose.demo.yml config -q [cwd=fairscore APP_IMAGE=${OLD_IMAGE}]`,
    ])
    expect(r.calls.some((c) => c.includes('pg_dump') || c.includes('prisma migrate') || c.startsWith('npm ') || c.startsWith('docker build'))).toBe(false)
    expect(existsSync(join(live, 'backups'))).toBe(false)
    expectStackUntouched()
  })

  it('runs migrate status from the worktree with the URL in the environment, before the build and the backup', () => {
    const r = run([commits.c2!])
    expect(r.status).toBe(0)
    expect(idx(r.calls, 'npx prisma migrate status')).toBeGreaterThan(-1)
    expect(idx(r.calls, 'npx prisma migrate status')).toBeLessThan(idx(r.calls, 'docker build'))
    expect(idx(r.calls, 'npm ci')).toBeLessThan(idx(r.calls, 'npx prisma migrate status'))
    expect(readFileSync(join(root, 'status.url'), 'utf8').trim()).toBe(`postgresql://credaflow:${ENCODED_PASSWORD}@127.0.0.1:5466/credaflow_demo?schema=public`)
    expect(readFileSync(join(root, 'status.cwd'), 'utf8').trim()).not.toBe(repo)
  })

  it('tolerates pending migrations (migrate status exits 1) and logs them', () => {
    const r = run([commits.c2!], { STUB_STATUS_RC: '1', STUB_STATUS_OUT: 'Following migrations have not yet been applied:\n20261014000000_more' })
    expect(r.status).toBe(0)
    expect(r.out).toContain('20261014000000_more')
  })

  it('does not mistake a pending migration named ..._failed_... for a failed one', () => {
    const r = run([commits.c2!], { STUB_STATUS_RC: '1', STUB_STATUS_OUT: 'Following migrations have not yet been applied:\n20261014000000_failed_debit_reason' })
    expect(r.status).toBe(0)
    expect(r.out).toContain('20261014000000_failed_debit_reason')
  })

  it.each([
    ['cannot reach the db', "Error: P1001: Can't reach database server at `127.0.0.1:5466`"],
    ['has a failed migration', 'Following migration have failed:\n20261014000000_more\nhave not yet been applied'],
    ['reports a diverged history ("are different")', 'The migration(s) have not yet been applied:\n20261014000000_more\nYour local migration history and the migrations table from your database are different:'],
    ['reports migrations "not found locally"', 'The migration(s) have not yet been applied:\n20261014000000_more\nThe migration(s) from the database are not found locally in prisma/migrations:\n20261010000000_other'],
  ])('dies before the build and the backup when migrate status %s, with nothing changed and no migrate warning', (_what, out) => {
    const r = run([commits.c2!], { STUB_STATUS_RC: '1', STUB_STATUS_OUT: out })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/prisma migrate status/)
    expect(r.out).toMatch(/the running stack was not touched/)
    expect(r.out).not.toMatch(/new schema/)
    expect(r.calls.some((c) => c.startsWith('docker build') || c.includes('pg_dump') || c.includes('migrate deploy') || c.includes('up -d'))).toBe(false)
    expect(existsSync(join(live, 'backups'))).toBe(false)
    expectStackUntouched()
  })
})

describe('upgrade-stack.sh backup, migrate and secrets', () => {
  it('writes the dump and the env copies before migrate runs', () => {
    const r = run([commits.c2!])
    expect(r.status).toBe(0)
    const backups = readFileSync(join(root, 'migrate.backups'), 'utf8').split('\n').filter(Boolean)
    expect(backups).toHaveLength(3)
    const dump = readdirSync(join(live, 'backups')).find((f) => f.endsWith('.dump'))!
    expect(dump).toMatch(new RegExp(`^pre-${short('c2')}-\\d{8}T\\d{6}Z\\.dump$`))
    expect(readFileSync(join(live, 'backups', dump), 'utf8')).toBe('PGDMP-stub')
    expect(readFileSync(join(live, 'backups', `.env.pre-${dump.slice(4, -5)}`), 'utf8')).toContain(`APP_IMAGE=${OLD_IMAGE}`)
    expect(readFileSync(join(live, 'backups', `.env.production.pre-${dump.slice(4, -5)}`), 'utf8')).toContain('TENANT_HOST_MAP=')
    const dumpCall = r.calls.find((c) => c.includes('pg_dump'))
    expect(dumpCall).toContain('pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"')
    expect(dumpCall).toContain('exec credaflow-fairscore-db')
  })

  it.each([
    ['writes nothing', { STUB_DUMP_EMPTY: '1' }, /pg_dump wrote nothing/],
    ['exits non-zero', { STUB_DUMP_FAIL: '1' }, /pg_dump of credaflow_demo failed/],
    ['writes something pg_restore cannot read', { STUB_DUMP_BODY: 'garbage' }, /pg_restore cannot read the dump/],
  ])('dies when pg_dump %s, before migrate or any swap, and leaves no dump file', (_what, env, message) => {
    const r = run([commits.c2!], env)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(message)
    expect(r.calls.some((c) => c.includes('migrate deploy'))).toBe(false)
    expect(r.calls.some((c) => c.startsWith('docker-compose') && c.includes(' up '))).toBe(false)
    expect(readdirSync(join(live, 'backups')).filter((f) => f.endsWith('.dump'))).toEqual([])
    expectStackUntouched()
  })

  it('reads the whole dump with pg_restore -f /dev/null, fed through stdin, before migrating', () => {
    const r = run([commits.c2!])
    expect(r.calls).toContain('docker exec -i credaflow-fairscore-db pg_restore -f /dev/null')
    expect(idx(r.calls, 'pg_restore -f /dev/null')).toBeGreaterThan(idx(r.calls, 'pg_dump'))
    expect(idx(r.calls, 'pg_restore -f /dev/null')).toBeLessThan(idx(r.calls, 'migrate deploy'))
  })

  it('migrates from the temp worktree with a URL in the environment, never in any argv or output', () => {
    const r = run([commits.c2!])
    expect(r.status).toBe(0)
    expect(readFileSync(join(root, 'migrate.url'), 'utf8').trim()).toBe(`postgresql://credaflow:${ENCODED_PASSWORD}@127.0.0.1:5466/credaflow_demo?schema=public`)
    const cwd = readFileSync(join(root, 'migrate.cwd'), 'utf8').trim()
    expect(cwd).not.toBe(repo)
    expect(cwd.startsWith(root)).toBe(true) // the harness's TMPDIR
    expect(existsSync(cwd)).toBe(false)
    for (const secret of [PASSWORD, ENCODED_PASSWORD]) {
      expect(readFileSync(log, 'utf8')).not.toContain(secret)
      expect(r.out).not.toContain(secret)
    }
  })

  it('a failed migrate leaves the running stack untouched, says old code on the new schema is possible, and names the dump', () => {
    const r = run([commits.c2!], { STUB_MIGRATE_FAIL: '1' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/forward-only/)
    expect(r.out).toMatch(/old code on the new schema/)
    expect(r.out).toMatch(RESTORE_BY_MOUNT)
    expect(mutating(r.calls).filter((c) => c.includes(' up '))).toEqual([])
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
    expect(readFileSync(join(data, 'logs', 'last-upgrade'), 'utf8')).toMatch(/failed .*migrate/)
  })

  it('gives a stdin restore command when the db container does not mount the backups dir', () => {
    const r = run([commits.c2!], { STUB_MIGRATE_FAIL: '1', STUB_NO_BACKUPS_MOUNT: '1' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(RESTORE_BY_STDIN)
    expect(r.out).not.toMatch(RESTORE_BY_MOUNT)
  })
})

describe('upgrade-stack.sh running image guard', () => {
  it.each([
    ['app', { STUB_PRE_IMAGE_APP: 'credaflow:fairscore-other' }, 'credaflow-fairscore-app', 'credaflow:fairscore-other'],
    ['portal', { STUB_PRE_IMAGE_PORTAL: 'credaflow:fairscore-other' }, 'credaflow-fairscore-portal', 'credaflow:fairscore-other'],
  ])('refuses when the %s does not run the image .env pins, before the locks, and changes nothing', (_which, env, container, running) => {
    const r = run([commits.c2!], env)
    expect(r.status).toBe(1)
    expect(r.out).toContain(`.env pins ${OLD_IMAGE} but ${container} runs ${running}; reconcile first`)
    expect(mutating(r.calls)).toEqual([])
    expect(r.calls.some((c) => c.includes('"Tenant"'))).toBe(false)
    expect(existsSync(join(data, 'bake.lock'))).toBe(false)
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
  })
})
