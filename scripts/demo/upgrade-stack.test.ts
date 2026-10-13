import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { OLD_IMAGE, SECRETS, commits, data, git, installStackHooks, live, log, logged, mutating, pinned, repo, root, run, short } from './upgrade-stack.harness'

// upgrade-stack.sh's guards, commit resolution and precheck, against stubs
// (see upgrade-stack.harness.ts). Preparation is in upgrade-stack-prep.test.ts and the
// swap in upgrade-stack-swap.test.ts.

installStackHooks()

describe('upgrade-stack.sh target guard', () => {
  it('refuses the Acme demo project, before touching anything', () => {
    const r = run([commits.c2!], { DEMO_LIVE_PROJECT: 'credaflow-demo', STUB_PROJECT: 'credaflow-demo' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/Acme demo/)
    expect(r.calls).toEqual([])
  })

  it('refuses the default Acme LIVE_DIR even under another project name', () => {
    const r = run([commits.c2!], { LIVE_DIR: join(root, 'Workspace', 'CredaFlow-demo') })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/Acme demo/)
    expect(r.calls).toEqual([])
  })

  it.each([
    ['an unlabeled target (another compose project)', { STUB_PROJECT: '' }, /compose project ''/],
    ['a target started from another working_dir', { STUB_LIVE_DIR: '/elsewhere' }, /started from '\/elsewhere'/],
    ['a stack that is not DEMO_MODE=true', { STUB_DEMO_MODE: 'false' }, /DEMO_MODE=true/],
  ])('refuses %s', (_what, env, message) => {
    const r = run([commits.c2!], env)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(message)
    expect(mutating(r.calls)).toEqual([])
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
  })

  it('refuses a db that is not published on 127.0.0.1', () => {
    const r = run([commits.c2!], { STUB_DB_BIND: '0.0.0.0:5466' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/not published on 127\.0\.0\.1/)
    expect(mutating(r.calls)).toEqual([])
  })

  describe('while a job holds its lock', () => {
    let holder: ChildProcess | undefined
    afterEach(() => {
      holder?.kill()
      holder = undefined
    })

    it.each([
      ['bake.lock', /a bake is running/],
      ['restore.lock', /a restore is running/],
      ['cron-run.lock', /a cron job is running or queued/],
    ])('refuses while %s is held', async (lock, message) => {
      mkdirSync(data, { recursive: true })
      const child = spawn('bash', ['-c', 'exec 9>"$1"; flock 9; echo held; exec sleep 30', 'holder', join(data, lock)])
      holder = child
      await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()))
      const r = run([commits.c2!])
      expect(r.status).toBe(1)
      expect(r.out).toMatch(message)
      expect(mutating(r.calls)).toEqual([])
    })
  })
})

describe('upgrade-stack.sh commit', () => {
  it('defaults to the commit the Acme demo image names', () => {
    const r = run([], { STUB_DEMO_IMAGE: `credaflow:demo-${short('c3')}` })
    expect(r.status).toBe(0)
    expect(pinned('APP_IMAGE')).toBe(`credaflow:fairscore-${short('c3')}`)
    expect(r.calls).toContain('docker inspect -f {{.Config.Image}} credaflow-demo-app')
  })

  it('takes an explicit commit over the demo image', () => {
    const r = run([commits.c2!], { STUB_DEMO_IMAGE: `credaflow:demo-${short('c3')}` })
    expect(r.status).toBe(0)
    expect(pinned('APP_IMAGE')).toBe(`credaflow:fairscore-${short('c2')}`)
    expect(r.calls).not.toContain('docker inspect -f {{.Config.Image}} credaflow-demo-app')
  })

  it.each([['a dirty build', 'credaflow:demo-abcdef1-dirty-0123abcd'], ['an unknown image', 'nginx:latest']])('refuses to default from %s', (_what, image) => {
    const r = run([], { STUB_DEMO_IMAGE: image })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/not a clean credaflow:demo-<sha> image/)
    expect(mutating(r.calls)).toEqual([])
  })

  it('refuses a commit that is on no local branch', () => {
    const dangling = git(repo, 'commit-tree', `${commits.c3}^{tree}`, '-p', commits.c3!, '-m', 'dangling')
    const r = run([dangling])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/not reachable from any local branch or origin\/\*/)
    expect(mutating(r.calls)).toEqual([])
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
  })

  it('accepts a commit that only an origin branch contains', () => {
    const dangling = git(repo, 'commit-tree', `${commits.c3}^{tree}`, '-p', commits.c3!, '-m', 'remote only')
    git(repo, 'update-ref', 'refs/remotes/origin/feature', dangling)
    expect(run([dangling])).toMatchObject({ status: 0 })
  })

  it('refuses a commit that does not exist and an option-looking argument', () => {
    expect(run(['0000000000000000000000000000000000000000'])).toMatchObject({ status: 1, out: expect.stringMatching(/no commit/) })
    expect(run(['--orphan'])).toMatchObject({ status: 1, out: expect.stringMatching(/must not start with "-"/) })
    expect(mutating(logged())).toEqual([])
  })
})

describe('upgrade-stack.sh precheck', () => {
  // Fast failure: nothing is installed, built, dumped, migrated or swapped.
  const untouched = (calls: string[]) => {
    expect(mutating(calls)).toEqual([])
    expect(existsSync(join(live, 'backups'))).toBe(false)
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
  }

  it.each([
    ['names a slug the db lacks', { STUB_TENANTS: 'other' }],
    ['names no tenant at all in the db', { STUB_TENANTS: '' }],
  ])('dies before build, backup, migrate and swap when TENANT_HOST_MAP %s', (_what, env) => {
    const r = run([commits.c2!], env)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/TENANT_HOST_MAP \(.*=acme\) names slug 'acme' but .* no ACTIVE tenant/)
    untouched(r.calls)
  })

  it('dies when only the second host-map entry names a missing slug, and names that slug', () => {
    writeFileSync(join(live, '.env.production'), 'TENANT_HOST_MAP=a.example.invalid=acme,b.example.invalid=ghost\nDEMO_MODE=true\n')
    const r = run([commits.c2!])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/TENANT_HOST_MAP \(b\.example\.invalid=ghost\) names slug 'ghost'/)
    untouched(r.calls)
  })

  it('dies before build when NEXT_PUBLIC_TENANT_SLUG is not a tenant of the db, though the host map is', () => {
    writeFileSync(join(live, '.env'), readFileSync(join(live, '.env'), 'utf8').replace('NEXT_PUBLIC_TENANT_SLUG=acme', 'NEXT_PUBLIC_TENANT_SLUG=fairscore'))
    const r = run([commits.c2!])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/NEXT_PUBLIC_TENANT_SLUG in .*\.env \(baked into the image\) names slug 'fairscore' but .* no ACTIVE tenant/)
    untouched(r.calls)
  })

  it('dies before build when NEXT_PUBLIC_TENANT_SLUG is missing', () => {
    writeFileSync(join(live, '.env'), readFileSync(join(live, '.env'), 'utf8').replace('NEXT_PUBLIC_TENANT_SLUG=acme\n', ''))
    const r = run([commits.c2!])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/NEXT_PUBLIC_TENANT_SLUG missing/)
    untouched(r.calls)
  })

  it('asks the db for ACTIVE tenants only', () => {
    const r = run([commits.c2!])
    const query = r.calls.find((c) => c.includes('"Tenant"'))
    expect(query).toContain("status = 'ACTIVE'")
  })

  it('dies on a stack with no TENANT_HOST_MAP', () => {
    writeFileSync(join(live, '.env.production'), 'DEMO_MODE=true\n')
    const r = run([commits.c2!])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/no TENANT_HOST_MAP/)
    untouched(r.calls)
  })
})

describe('upgrade-stack.sh downgrade guard', () => {
  // The stack "runs" what its .env pins (the docker stub reads it).
  const runningAs = (image: string, gitSha: string) => {
    const env = readFileSync(join(live, '.env'), 'utf8').replace(/^APP_IMAGE=.*$/m, `APP_IMAGE=${image}`).replace(/^GIT_SHA=.*$/m, `GIT_SHA=${gitSha}`)
    writeFileSync(join(live, '.env'), env)
  }
  const untouched = (calls: string[]) => {
    expect(mutating(calls)).toEqual([])
    expect(pinned('APP_IMAGE')).not.toBe(`credaflow:fairscore-${short('c2')}`)
  }

  it('refuses to move to an ancestor of the current commit', () => {
    runningAs(`credaflow:fairscore-${short('c3')}`, `fairscore-${short('c3')}`)
    const r = run([commits.c2!])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(new RegExp(`${short('c2')} is not a descendant of the stack's current commit ${short('c3')}`))
    expect(r.out).toMatch(/--allow-downgrade/)
    untouched(r.calls)
  })

  it('refuses a sideways move to a commit that does not contain the current one', () => {
    const side = git(repo, 'commit-tree', `${commits.c1}^{tree}`, '-p', commits.c1!, '-m', 'side')
    git(repo, 'branch', 'side', side)
    runningAs(`credaflow:fairscore-${short('c3')}`, `fairscore-${short('c3')}`)
    const r = run([side])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/not a descendant/)
    untouched(r.calls)
  })

  it('accepts the same commit and a descendant', () => {
    runningAs(`credaflow:fairscore-${short('c2')}`, `fairscore-${short('c2')}`)
    expect(run([commits.c2!])).toMatchObject({ status: 0 })
    runningAs(`credaflow:fairscore-${short('c1')}`, `fairscore-${short('c1')}`)
    expect(run([commits.c3!])).toMatchObject({ status: 0 })
  })

  it('reads the first 7+ hex run after the prefix of a suffixed tag', () => {
    runningAs(`credaflow:fairscore-${short('c2')}-banner`, `fairscore-${short('c2')}-banner`)
    expect(run([commits.c2!])).toMatchObject({ status: 0 })
    runningAs(`credaflow:fairscore-${short('c3')}-banner`, `fairscore-${short('c3')}-banner`)
    expect(run([commits.c2!])).toMatchObject({ status: 1, out: expect.stringMatching(/not a descendant of the stack's current commit/) })
  })

  it('falls back to GIT_SHA when the image tag holds no commit', () => {
    runningAs('credaflow:fairscore-latest', `fairscore-${short('c3')}`)
    expect(run([commits.c2!])).toMatchObject({ status: 1, out: expect.stringMatching(/not a descendant/) })
  })

  it.each([
    ['an unparseable tag', 'credaflow:fairscore-banner', 'fairscore-banner', /cannot read the stack's current commit/],
    ['a commit this repo does not have', 'credaflow:fairscore-abcdef1', 'fairscore-abcdef1', /current commit abcdef1 is not in this repo/],
  ])('refuses %s, and --allow-downgrade overrides it loudly', (_what, image, gitSha, message) => {
    runningAs(image, gitSha)
    const refused = run([commits.c2!])
    expect(refused.status).toBe(1)
    expect(refused.out).toMatch(message)
    untouched(refused.calls)
    const allowed = run(['--allow-downgrade', commits.c2!])
    expect(allowed.status).toBe(0)
    expect(allowed.out).toMatch(/WARNING: --allow-downgrade: /)
    expect(pinned('APP_IMAGE')).toBe(`credaflow:fairscore-${short('c2')}`)
  })

  it('--allow-downgrade lets a real downgrade through, with a warning', () => {
    runningAs(`credaflow:fairscore-${short('c3')}`, `fairscore-${short('c3')}`)
    const r = run([commits.c2!, '--allow-downgrade'])
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/WARNING: --allow-downgrade: .*not a descendant/)
    expect(pinned('APP_IMAGE')).toBe(`credaflow:fairscore-${short('c2')}`)
  })

  it('refuses a second commit argument', () => {
    expect(run([commits.c2!, commits.c3!])).toMatchObject({ status: 1, out: expect.stringMatching(/usage: upgrade-stack\.sh \[--allow-downgrade\] \[commit\]/) })
  })
})

describe('upgrade-stack.sh secrets check', () => {
  const sha = (v: string) => createHash('sha256').update(v).digest('hex')
  const setContainer = (lines: string) => writeFileSync(join(root, 'container.env'), lines)
  const container = () => Object.entries(SECRETS).map(([k, v]) => `${k}=${v}`)
  const noLeak = (out: string, values: string[]) => {
    for (const v of values) for (const secret of [v, sha(v), sha(`${v}\n`)]) {
      expect(out).not.toContain(secret)
      expect(readFileSync(log, 'utf8')).not.toContain(secret)
    }
  }

  it('passes when the running app holds every secrets.env value, and prints no value or hash', () => {
    const r = run([commits.c2!])
    expect(r.status).toBe(0)
    noLeak(r.out, Object.values(SECRETS))
  })

  it.each([
    ['a differing value', () => container().map((l) => l.replace('cron-value-Q2', 'rotated-value-Z9')), 'CRON_SECRET'],
    ['a key the container lacks', () => container().filter((l) => !l.startsWith('WABA_ENC_KEY=')), 'WABA_ENC_KEY'],
  ])('refuses %s before any build or backup, naming only the key', (_what, lines, key) => {
    setContainer(lines().join('\n') + '\n')
    const r = run([commits.c2!])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(new RegExp(`differs from the env of the running credaflow-fairscore-app in: ${key}\\b`))
    expect(mutating(r.calls)).toEqual([])
    expect(pinned('APP_IMAGE')).toBe(OLD_IMAGE)
    noLeak(r.out, [...Object.values(SECRETS), 'rotated-value-Z9'])
  })

  it('names every differing key', () => {
    setContainer(container().map((l) => l.replace('-value-', '-other-')).join('\n') + '\n')
    const r = run([commits.c2!])
    const keys = /running credaflow-fairscore-app in: (.*?) \(/.exec(r.out)![1]!.split(' ').sort()
    expect(keys).toEqual(['CRON_SECRET', 'NEXTAUTH_SECRET', 'WABA_ENC_KEY'])
  })

  it('refuses a missing or empty secrets.env', () => {
    writeFileSync(join(data, 'secrets.env'), '')
    const r = run([commits.c2!])
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/is missing or empty/)
    expect(mutating(r.calls)).toEqual([])
  })
})
