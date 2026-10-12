import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// status.sh against a temp demo data dir and runner. docker is a stub on PATH
// that answers only the reads status.sh makes of the live stack: the app's
// image and state, the db's database list (STUB_OLD_DBS) and the app's uploads
// directory (STUB_UPLOADS). Nothing reaches a real container.

const SCRIPT = join(__dirname, 'status.sh')
const IMAGE = 'credaflow:status-test'

let root: string
let data: string
let runner: string

function git(...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', runner, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function status(env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT], {
    env: { PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, HOME: root, DEMO_DATA_DIR: data, DEMO_RUNNER_DIR: runner, ...env },
    encoding: 'utf8',
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

const recordRunner = (commit: string): void =>
  writeFileSync(join(data, 'runner.json'), JSON.stringify({ commit, previous: commit, updatedAt: '2026-10-12T07:00:00Z' }))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'demo-status-'))
  data = join(root, 'data')
  runner = join(root, 'runner')
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'docker'), [
    '#!/bin/sh',
    'case "$*" in',
    `  "inspect -f {{.Config.Image}} credaflow-demo-app") echo ${IMAGE} ;;`,
    '  "inspect -f {{.State.Status}} credaflow-demo-app") echo running ;;',
    '  "exec -e DB=postgres -e SQL="*" credaflow-demo-db "*) printf "%s\\n" "$STUB_OLD_DBS" ;;',
    '  "exec credaflow-demo-app ls -A /app/uploads") printf "%b" "$STUB_UPLOADS" ;;',
    '  *) echo "docker stub: unexpected $*" >&2; exit 1 ;;',
    'esac',
    '',
  ].join('\n'))
  chmodSync(join(root, 'bin', 'docker'), 0o755)
  mkdirSync(join(data, 'snapshots', 'latest'), { recursive: true })
  writeFileSync(join(data, 'snapshots', 'latest', 'meta.json'), JSON.stringify({
    stamp: '20261012T000000Z', image: IMAGE, finishedAt: new Date().toISOString(),
    simWindow: { start: '2026-04-01', until: '2026-10-12' },
  }))
  mkdirSync(runner)
  spawnSync('git', ['init', '-q', '-b', 'main', runner])
  git('commit', '-q', '--allow-empty', '-m', 'first')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('status.sh', () => {
  it('needs no attention with a recorded, clean runner and no leftovers', () => {
    recordRunner(git('rev-parse', 'HEAD'))
    const r = status({ STUB_UPLOADS: 'clients\\n' })
    expect(r.out).toMatch(/runner: .* at [0-9a-f]{7} first/)
    expect(r).toMatchObject({ status: 0 })
  })

  it('flags a runner with no update record', () => {
    const r = status()
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/!! the runner has no update record/)
  })

  it('flags a runner at another commit than the recorded one', () => {
    recordRunner('0000000000000000000000000000000000000000')
    expect(status()).toMatchObject({ status: 1, out: expect.stringMatching(/!! the runner is not at the commit/) })
  })

  it('does not flag a missing runner that was never recorded', () => {
    rmSync(runner, { recursive: true })
    expect(status()).toMatchObject({ status: 0, out: expect.stringMatching(/runner: none at/) })
  })

  it('flags leftover databases of earlier restores', () => {
    recordRunner(git('rev-parse', 'HEAD'))
    const r = status({ STUB_OLD_DBS: 'credaflow_old_20261001023000 credaflow_old_20261005023000' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/!! leftover databases from earlier restores: credaflow_old_20261001023000 credaflow_old_20261005023000/)
  })

  it('flags leftover upload copies of earlier restores', () => {
    recordRunner(git('rev-parse', 'HEAD'))
    const r = status({ STUB_UPLOADS: '.old-20261001023000\\nclients\\n.old-20261005023000\\n' })
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/!! leftover upload copies from earlier restores in credaflow-demo-app:\/app\/uploads: \.old-20261001023000 \.old-20261005023000/)
  })
})
