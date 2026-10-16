import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// bake.sh's preflight on the sim app's environment. bake.sh runs from a fake
// repo root (a copy of bake.sh + lib.sh, so lib.sh's DEMO_ROOT is the fake),
// whose fresh-stack.sh is a stub and whose npm, npx, docker and docker-compose
// are stubs on PATH; nothing reaches a real container. The npx stub logs every
// call and fails the simulate step, so "got past the preflight" is "simulate.ts
// was called". The sim app's env is whatever STUB_SIM_ENV says.

const DEMO = __dirname
const SECRET_VALUE = 'sentinel-secret-value-9f3a'
const FULL_ENV = `PATH=/usr/bin\nDEMO_MODE=true\nUNSUB_TOKEN_SECRET=${SECRET_VALUE}\nNODE_ENV=production`
const SECRETS = [
  'DEBIT_MANDATE_CREDITOR_BANK_NAME=Synthetic Bank',
  'DEBIT_MANDATE_CREDITOR_ACCOUNT_NUMBER=0000000000',
  'DEBIT_MANDATE_CREDITOR_BRANCH_CODE=000000',
  `UNSUB_TOKEN_SECRET=${SECRET_VALUE}`,
].join('\n') + '\n'

let root: string
let calls: string

const stub = (name: string, body: string, dir = join(root, 'bin')) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), body)
  chmodSync(join(dir, name), 0o755)
}

function bake(env: Record<string, string> = {}) {
  const started = Date.now()
  const r = spawnSync('bash', [join(root, 'repo', 'scripts', 'demo', 'bake.sh'), '--image', 'credaflow:test'], {
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, NODE_ENV: 'test', HOME: join(root, 'home'),
      DEMO_DATA_DIR: join(root, 'data'), STUB_LOG: calls, STUB_SIM_ENV: FULL_ENV, ...env,
    },
    encoding: 'utf8',
  })
  return {
    status: r.status, out: `${r.stdout}${r.stderr}`, ms: Date.now() - started,
    calls: readFileSync(calls, 'utf8').split('\n'),
    secrets: readFileSync(join(root, 'data', 'secrets.env'), 'utf8'),
  }
}

const simulated = (c: string[]) => c.some((l) => l.includes('scripts/demo/simulate.ts'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bake-preflight-'))
  calls = join(root, 'calls.log')
  writeFileSync(calls, '')
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'scripts', 'demo', 'sim'), { recursive: true })
  for (const f of ['bake.sh', 'lib.sh']) copyFileSync(join(DEMO, f), join(repo, 'scripts', 'demo', f))
  mkdirSync(join(repo, 'prisma', 'migrations', '20260101000000_baseline'), { recursive: true })
  mkdirSync(join(root, 'home'))
  mkdirSync(join(root, 'data'))
  writeFileSync(join(root, 'data', 'secrets.env'), SECRETS)
  // The real fresh-stack.sh destroys the sim volumes; this one only drops a secret on request.
  stub('fresh-stack.sh', '#!/bin/sh\n[ -z "$STUB_DROP_SECRET" ] || sed -i "/^UNSUB_TOKEN_SECRET=/d" "$DEMO_DATA_DIR/secrets.env"\n', join(repo, 'scripts', 'demo', 'sim'))
  stub('npm', '#!/bin/sh\nexit 0\n')
  stub('npx', '#!/bin/sh\necho "npx $*" >> "$STUB_LOG"\ncase "$*" in *demo-lender.ts*) echo acme; exit 0 ;; esac\nexit 7\n')
  stub('docker-compose', '#!/bin/sh\necho "docker-compose $*" >> "$STUB_LOG"\nexit 0\n')
  stub('docker', String.raw`#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  "image inspect "*) exit 0 ;;
  "run --rm --entrypoint ls "*) echo 20260101000000_baseline ;;
  "inspect -f {{range .Config.Env}}"*"credaflow-demo-sim-app") [ -z "$STUB_NO_SIM_APP" ] || exit 1; printf '%s\n' "$STUB_SIM_ENV" ;;
esac
exit 0
`)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('bake.sh sim env preflight', () => {
  it('runs simulate.ts when the sim app has DEMO_MODE=true and UNSUB_TOKEN_SECRET and secrets.env has it', () => {
    const r = bake()
    expect(simulated(r.calls)).toBe(true)
    expect(r.out).not.toMatch(/sim env incomplete/)
  })

  it.each([
    ['DEMO_MODE is absent', 'PATH=/usr/bin\nUNSUB_TOKEN_SECRET=' + SECRET_VALUE, 'DEMO_MODE=true'],
    ['DEMO_MODE is not true', 'DEMO_MODE=false\nUNSUB_TOKEN_SECRET=' + SECRET_VALUE, 'DEMO_MODE=true'],
    ['UNSUB_TOKEN_SECRET is absent', 'DEMO_MODE=true\nPATH=/usr/bin', 'UNSUB_TOKEN_SECRET'],
    ['UNSUB_TOKEN_SECRET is empty', 'DEMO_MODE=true\nUNSUB_TOKEN_SECRET=', 'UNSUB_TOKEN_SECRET'],
  ])('refuses within seconds, before simulate.ts, naming the key, when %s on the sim app', (_what, env, key) => {
    const r = bake({ STUB_SIM_ENV: env })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('sim env incomplete')
    expect(r.out).toContain(`credaflow-demo-sim-app: ${key}`)
    expect(simulated(r.calls)).toBe(false)
    expect(r.ms).toBeLessThan(5000)
  })

  it('names both keys when both are missing', () => {
    const r = bake({ STUB_SIM_ENV: 'PATH=/usr/bin' })
    expect(r.out).toContain('credaflow-demo-sim-app: DEMO_MODE=true')
    expect(r.out).toContain('credaflow-demo-sim-app: UNSUB_TOKEN_SECRET')
    expect(simulated(r.calls)).toBe(false)
  })

  it('refuses when secrets.env lost UNSUB_TOKEN_SECRET, naming the key', () => {
    const r = bake({ STUB_DROP_SECRET: '1' })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('secrets.env: UNSUB_TOKEN_SECRET')
    expect(simulated(r.calls)).toBe(false)
  })

  it('refuses when the sim app container does not exist', () => {
    const r = bake({ STUB_NO_SIM_APP: '1' })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain('credaflow-demo-sim-app not found')
    expect(simulated(r.calls)).toBe(false)
  })

  it('never prints a secret value, on success or on failure', () => {
    for (const env of <Record<string, string>[]>[{}, { STUB_SIM_ENV: 'PATH=/usr/bin' }, { STUB_DROP_SECRET: '1' }]) {
      expect(bake(env).out).not.toContain(SECRET_VALUE)
    }
  })
})
