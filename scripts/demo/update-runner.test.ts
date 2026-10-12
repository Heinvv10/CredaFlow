import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// update-runner.sh against a throwaway repo and a detached worktree of it. npm
// and npx are stubs on PATH that only log their arguments (FAIL_NPM=1 makes
// npm fail); git and flock are real.

const SCRIPT = join(__dirname, 'update-runner.sh')

let root: string
let repo: string
let runner: string
let data: string
let calls: string
const commits: Record<string, string> = {}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

function commit(name: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) writeFileSync(join(repo, file), content)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', name)
  commits[name] = git(repo, 'rev-parse', 'HEAD')
}

function run(target: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', [SCRIPT, target], {
    env: { PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, NODE_ENV: 'test', HOME: root, DEMO_DATA_DIR: data, DEMO_RUNNER_DIR: runner, ...env },
    encoding: 'utf8',
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

const logged = (): string[] => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [])
const head = (): string => git(runner, 'rev-parse', 'HEAD')
const state = (): unknown => JSON.parse(readFileSync(join(data, 'runner.json'), 'utf8'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'update-runner-'))
  repo = join(root, 'repo')
  runner = join(root, 'runner')
  data = join(root, 'data')
  calls = join(root, 'calls.log')
  mkdirSync(repo)
  mkdirSync(join(root, 'bin'))
  for (const tool of ['npm', 'npx']) {
    writeFileSync(join(root, 'bin', tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\n[ "${tool}" = npm ] && [ "$FAIL_NPM" = 1 ] && exit 3\nexit 0\n`)
    chmodSync(join(root, 'bin', tool), 0o755)
  }
  git(repo, 'init', '-q', '-b', 'main')
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: 'runner-test', scripts })
  commit('c1', { 'package.json': pkg({ 'face-models:fetch': 'true' }), 'package-lock.json': '{"v":1}', '.gitignore': '.env.demo-sim\n', 'README': 'one' })
  commit('c2', { README: 'two' })
  commit('c3', { 'package-lock.json': '{"v":2}' })
  commit('c4', { 'package.json': pkg({}) })
  git(repo, 'worktree', 'add', '-q', '--detach', runner, commits.c1!)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('update-runner.sh', () => {
  it('moves the runner to a branch commit and records it; no npm ci when the lockfile is unchanged', () => {
    expect(run(commits.c2!)).toMatchObject({ status: 0 })
    expect(head()).toBe(commits.c2)
    expect(logged()).toEqual(['npx prisma generate', 'npm run face-models:fetch'])
    expect(state()).toMatchObject({ commit: commits.c2, previous: commits.c1, updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) })
  })

  it('runs npm ci --legacy-peer-deps when package-lock.json changed', () => {
    expect(run(commits.c3!)).toMatchObject({ status: 0 })
    expect(logged()).toEqual(['npm ci --legacy-peer-deps', 'npx prisma generate', 'npm run face-models:fetch'])
  })

  it('skips face-models:fetch when the new commit has no such script', () => {
    git(runner, 'checkout', '-q', '--detach', commits.c3!)
    expect(run(commits.c4!)).toMatchObject({ status: 0 })
    expect(logged()).toEqual(['npx prisma generate'])
  })

  it('records nothing when a step fails', () => {
    const r = run(commits.c3!, { FAIL_NPM: '1' })
    expect(r.status).not.toBe(0)
    expect(existsSync(join(data, 'runner.json'))).toBe(false)
  })

  it.each([
    ['a modified tracked file', () => writeFileSync(join(runner, 'README'), 'edited')],
    ['an untracked file', () => writeFileSync(join(runner, 'notes.txt'), 'x')],
  ])('refuses a runner with %s', (_label, dirty) => {
    dirty()
    const r = run(commits.c2!)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/uncommitted or untracked changes/)
    expect(head()).toBe(commits.c1)
    expect(logged()).toEqual([])
  })

  it('allows gitignored files in the runner', () => {
    writeFileSync(join(runner, '.env.demo-sim'), 'KEY=value\n')
    expect(run(commits.c2!)).toMatchObject({ status: 0 })
  })

  it('refuses a commit that does not exist or is on no local branch', () => {
    expect(run('0000000000000000000000000000000000000000')).toMatchObject({ status: 1, out: expect.stringMatching(/no commit/) })
    const dangling = git(repo, 'commit-tree', `${commits.c4}^{tree}`, '-p', commits.c4!, '-m', 'dangling')
    expect(run(dangling)).toMatchObject({ status: 1, out: expect.stringMatching(/not reachable from any local branch/) })
    expect(head()).toBe(commits.c1)
  })

  it('refuses a path that is not a checkout', () => {
    expect(run(commits.c2!, { DEMO_RUNNER_DIR: data })).toMatchObject({ status: 1, out: expect.stringMatching(/not the top of a git checkout/) })
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
      // One process: bash takes the lock on fd 9, then becomes sleep, so kill() releases it.
      const child = spawn('bash', ['-c', 'exec 9>"$1"; flock 9; echo held; exec sleep 30', 'holder', join(data, lock)])
      holder = child
      await new Promise<void>((resolve) => child.stdout?.once('data', () => resolve()))
      const r = run(commits.c2!)
      expect(r.status).toBe(1)
      expect(r.out).toMatch(message)
      expect(head()).toBe(commits.c1)
    })
  })
})
