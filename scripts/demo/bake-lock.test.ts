import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// bake.sh's host-wide sim stack lock. Every tool bake.sh could reach next (npm,
// npx, docker, docker-compose) is a stub that logs and exits 7, so a run that
// gets past the lock touches nothing real and fails with a different message.

const SCRIPT = join(__dirname, 'bake.sh')

let root: string
let calls: string
let holder: ChildProcess | undefined

function bake(dataDir: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, '--image', 'credaflow:test'], {
    env: { PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, NODE_ENV: 'test', HOME: root, DEMO_DATA_DIR: join(root, dataDir), ...env },
    encoding: 'utf8',
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

async function hold(lock: string): Promise<void> {
  // One process: bash takes the lock on fd 9, then becomes sleep, so kill() releases it.
  const child = spawn('bash', ['-c', 'exec 9>>"$1"; flock 9; echo held; exec sleep 30', 'holder', lock])
  holder = child
  await new Promise<void>((resolve, reject) => {
    child.stdout?.once('data', () => resolve())
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`lock holder exited ${code}`)))
  })
}

const logged = (): string => (existsSync(calls) ? readFileSync(calls, 'utf8') : '')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bake-lock-'))
  calls = join(root, 'calls.log')
  mkdirSync(join(root, 'bin'))
  for (const tool of ['npm', 'npx', 'docker', 'docker-compose']) {
    writeFileSync(join(root, 'bin', tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 7\n`)
    chmodSync(join(root, 'bin', tool), 0o755)
  }
})

afterEach(() => {
  holder?.kill()
  holder = undefined
  rmSync(root, { recursive: true, force: true })
})

describe('bake.sh sim stack lock', () => {
  it('refuses a second lender\'s bake while another holds the default host lock, before running anything', async () => {
    await hold(join(root, '.credaflow-demo-sim.lock'))
    const r = bake('fairscore-data', { DEMO_LENDER: 'fairscore' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/the sim stack is in use by another bake/)
    expect(logged()).toBe('')
  })

  it('honours DEMO_SIM_LOCK', async () => {
    const lock = join(root, 'elsewhere.lock')
    await hold(lock)
    const r = bake('acme-data', { DEMO_SIM_LOCK: lock })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/in use by another bake \(lock .*elsewhere\.lock\)/)
    expect(logged()).toBe('')
  })

  it('waits DEMO_SIM_LOCK_WAIT seconds for the lock, as a cron bake does', async () => {
    await hold(join(root, '.credaflow-demo-sim.lock'))
    setTimeout(() => holder?.kill(), 1000)
    const r = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn('bash', [SCRIPT, '--image', 'credaflow:test'], {
        env: { PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, NODE_ENV: 'test', HOME: root, DEMO_DATA_DIR: join(root, 'acme-data'), DEMO_SIM_LOCK_WAIT: '20' },
      })
      let out = ''
      child.stdout?.on('data', (d) => { out += d })
      child.stderr?.on('data', (d) => { out += d })
      child.once('close', (status) => resolve({ status, out }))
    })
    expect(r.out).not.toMatch(/in use by another bake/)
    expect(r.out).toMatch(/demo:typecheck failed/)
  }, 15_000)

  it('goes past the lock when nobody holds it', () => {
    const r = bake('acme-data')
    expect(r.out).not.toMatch(/in use by another bake/)
    expect(logged()).toMatch(/^npm run -s demo:typecheck/)
    expect(r.out).toMatch(/demo:typecheck failed/)
  })
})
