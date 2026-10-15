import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'

// Shared harness of upgrade-stack.test.ts and upgrade-stack-swap.test.ts: shell stubs
// for docker, docker-compose, npx, npm, curl and sleep on PATH that answer what the
// scripts ask and append every call to one log (nothing reaches a real container),
// and a throwaway git repo that holds copies of the scripts under test (they find
// their repo from their own location). git and flock are real.

export const PASSWORD = 'p@ss/w:rd+1&x'
export const ENCODED_PASSWORD = 'p%40ss%2Fw%3Ard%2B1%26x'
// The image the stack runs before an upgrade: tagged with the test repo's first commit (set per test).
export let OLD_IMAGE: string
// What the app container's env holds of the shared secrets (secrets.env), one KEY=value per line.
// The recovery sequence of a failed upgrade, as the message prints it: stop, recreate the db, restore.
const RECREATE = String.raw`docker stop credaflow-fairscore-app credaflow-fairscore-portal && docker exec credaflow-fairscore-db sh -c 'dropdb -U "\$POSTGRES_USER" --force "\$POSTGRES_DB" && createdb -U "\$POSTGRES_USER" "\$POSTGRES_DB"' && `
const DUMP = String.raw`pre-[0-9a-f]{7}-\d{8}T\d{6}Z\.dump`
export const RESTORE_BY_MOUNT = new RegExp(`${RECREATE}docker exec credaflow-fairscore-db pg_restore -U credaflow -d credaflow_demo --exit-on-error /backups/${DUMP} && docker start credaflow-fairscore-app credaflow-fairscore-portal`)
export const RESTORE_BY_STDIN = new RegExp(`${RECREATE}docker exec -i credaflow-fairscore-db pg_restore -U credaflow -d credaflow_demo --exit-on-error < \\S*backups/${DUMP} && docker start credaflow-fairscore-app credaflow-fairscore-portal`)
export const SECRETS = { NEXTAUTH_SECRET: 'nextauth-value-Q1', CRON_SECRET: 'cron-value-Q2', WABA_ENC_KEY: 'waba-value-Q3' }

export let root: string
export let repo: string
export let live: string
export let data: string
export let log: string
export const commits: Record<string, string> = {}

const DOCKER_STUB = String.raw`#!/bin/sh
echo "docker $*" >> "$STUB_LOG"
case "$*" in
  "inspect -f {{range .Mounts}}"*)
    [ -n "$STUB_NO_BACKUPS_MOUNT" ] || echo "$STUB_LIVE_DIR/backups" ;;
  "exec -i credaflow-fairscore-db pg_restore -f /dev/null")
    # A real dump starts with PGDMP; the stub's pg_dump writes PGDMP-stub.
    [ -z "$STUB_RESTORE_LIST_FAIL" ] && head -c 5 | grep -q PGDMP; exit $? ;;
  "image inspect -f "*) [ -n "$STUB_IMAGE_EXISTS" ] && echo "$STUB_IMAGE_LABEL"; exit $? ;;
  "image inspect "*) [ -n "$STUB_IMAGE_EXISTS" ]; exit $? ;;
  "build "*) exit "${'$'}{STUB_BUILD_FAIL:-0}" ;;
  "inspect -f {{.Config.Image}} credaflow-demo-app") echo "$STUB_DEMO_IMAGE" ;;
  "inspect -f {{.Config.Image}} credaflow-fairscore-"*)
    # What compose would be running: the pin in .env, unless a test says otherwise.
    # Before the first 'compose up' the containers run $STUB_PRE_IMAGE_APP / _PORTAL (default: the
    # pin); afterwards $STUB_RUNNING_IMAGE (default: the pin).
    pin="$(grep '^APP_IMAGE=' "$STUB_LIVE_DIR/.env" | cut -d= -f2)"
    if [ -e "$STUB_ROOT/up.done" ]; then echo "${'$'}{STUB_RUNNING_IMAGE:-$pin}"
    else
      case "$*" in
        *-portal) echo "${'$'}{STUB_PRE_IMAGE_PORTAL:-$pin}" ;;
        *) echo "${'$'}{STUB_PRE_IMAGE_APP:-$pin}" ;;
      esac
    fi ;;
  "inspect credaflow-fairscore-"*) exit 0 ;;
  *"com.docker.compose.project.working_dir"*) echo "$STUB_LIVE_DIR" ;;
  *"com.docker.compose.project"*) echo "$STUB_PROJECT" ;;
  *"range .Config.Env"*) echo "DEMO_MODE=$STUB_DEMO_MODE"; cat "$STUB_ROOT/container.env"
    # More output after the match, once a reader that stops early has gone (SIGPIPE under pipefail).
    [ -z "$STUB_OUTPUT_TAIL" ] || { /bin/sleep 0.3; echo "PATH=/usr/bin"; echo "NODE_ENV=production"; } ;;
  *"HostPort"*credaflow-fairscore-portal) echo 3332 ;;
  *"HostPort"*) echo 3330 ;;
  *"HostIp"*) echo 127.0.0.1 ;;
  "port credaflow-fairscore-db 5432") echo "$STUB_DB_BIND"; [ -z "$STUB_OUTPUT_TAIL" ] || { /bin/sleep 0.3; echo "[::1]:5432"; } ;;
  "exec credaflow-fairscore-db printenv POSTGRES_DB") echo credaflow_demo ;;
  "exec credaflow-fairscore-db printenv POSTGRES_USER") echo credaflow ;;
  "exec credaflow-fairscore-db sh -c "*pg_dump*)
    [ -z "$STUB_DUMP_FAIL" ] || exit 1
    [ -n "$STUB_DUMP_EMPTY" ] || printf '%s' "${'$'}{STUB_DUMP_BODY:-PGDMP-stub}" ;;
  "exec -e DB="*'"Tenant"'*) echo "$STUB_TENANTS" | tr , '\n' ;;
esac
exit 0
`

// STUB_COMPOSE_FAIL=config fails 'config'; STUB_COMPOSE_FAIL_UP_IMAGE=<image> fails 'up'
// while the stack is pinned to that image.
const COMPOSE_STUB = String.raw`#!/bin/sh
echo "docker-compose $* [cwd=$(basename "$PWD") $(grep '^APP_IMAGE=' .env)]" >> "$STUB_LOG"
# Which of the compose-interpolated variables this process inherited from the caller's shell.
leaked="$(env | grep -E '^(APP_IMAGE|GIT_SHA|BUILD_TIME|POSTGRES_USER|POSTGRES_PASSWORD|POSTGRES_DB|PORTAL_AUTH_URL)=' | cut -d= -f1)"
[ -z "$leaked" ] || echo "$leaked" >> "$STUB_ROOT/compose.leaked"
case " $* " in
  *" config "*) [ "$STUB_COMPOSE_FAIL" != config ] || { echo "compose: variable is not set" >&2; exit 1; } ;;
  *" up "*)
    touch "$STUB_ROOT/up.done"
    [ -z "$STUB_COMPOSE_FAIL_UP_IMAGE" ] || ! grep -q "^APP_IMAGE=$STUB_COMPOSE_FAIL_UP_IMAGE\$" .env || exit 1 ;;
esac
exit 0
`

// "npx tsx …" prints the lender slug (demo_slug); "npx prisma migrate deploy"
// records what a real one would see: its cwd, DATABASE_URL, the backups so far.
const NPX_STUB = String.raw`#!/bin/sh
echo "npx $*" >> "$STUB_LOG"
case "$*" in
  "tsx prisma/demo-lender.ts slug") echo "${'$'}{DEMO_LENDER:-acme}" ;;
  "prisma migrate status")
    echo "$DATABASE_URL" > "$STUB_ROOT/status.url"
    echo "$PWD" > "$STUB_ROOT/status.cwd"
    echo "${'$'}{STUB_STATUS_OUT:-Database schema is up to date!}"
    exit "${'$'}{STUB_STATUS_RC:-0}" ;;
  "prisma migrate deploy")
    [ -f package.json ] || { echo "no package.json in $PWD" >&2; exit 4; }
    echo "$PWD" > "$STUB_ROOT/migrate.cwd"
    echo "$DATABASE_URL" > "$STUB_ROOT/migrate.url"
    ls -A "$STUB_LIVE_DIR/backups" > "$STUB_ROOT/migrate.backups"
    [ -z "$STUB_MIGRATE_FAIL" ] || exit 3 ;;
esac
exit 0
`

const NPM_STUB = String.raw`#!/bin/sh
echo "npm $*" >> "$STUB_LOG"
[ -z "$STUB_NPM_FAIL" ] || exit 1
mkdir -p node_modules
exit 0
`

// /api/health fails while the stack is pinned to $STUB_HEALTH_FAIL_IMAGE (the new one),
// on every address, or only on $STUB_HEALTH_FAIL_ADDR when that is set; with
// $STUB_HEALTH_FAIL_ALL it always fails. A page request (-w prints the status code)
// answers 200, or 404 when its argv contains $STUB_PAGE_FAIL.
const CURL_STUB = String.raw`#!/bin/sh
echo "curl $*" >> "$STUB_LOG"
case "$*" in
  *"--max-time "*) ;;
  *) echo "curl without --max-time" >&2; exit 28 ;;
esac
case "$*" in
  *"/api/health"*)
    [ -z "$STUB_HEALTH_FAIL_ALL" ] || exit 22
    [ -z "$STUB_HEALTH_FAIL_IMAGE" ] || ! grep -q "^APP_IMAGE=$STUB_HEALTH_FAIL_IMAGE\$" "$STUB_LIVE_DIR/.env" \
      || { [ -n "$STUB_HEALTH_FAIL_ADDR" ] && ! echo "$*" | grep -q -- "$STUB_HEALTH_FAIL_ADDR"; } ;;
  *)
    if [ -n "$STUB_PAGE_FAIL" ] && echo "$*" | grep -q -- "$STUB_PAGE_FAIL"; then echo 404; else echo 200; fi ;;
esac
`

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

export function commit(name: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(repo, file, '..'), { recursive: true })
    writeFileSync(join(repo, file), content)
  }
  for (const file of Object.keys(files)) if (file.endsWith('.sh')) chmodSync(join(repo, file), 0o755)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', name)
  commits[name] = git(repo, 'rev-parse', 'HEAD')
}

export const short = (name: string): string => commits[name]!.slice(0, 7)
export const script = (name: string): string => join(repo, 'scripts', 'demo', name)

export function run(args: string[] = [], env: Record<string, string> = {}, name = 'upgrade-stack.sh') {
  const r = spawnSync('bash', [script(name), ...args], {
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`, NODE_ENV: 'test', HOME: root,
      TMPDIR: root, DEMO_DATA_DIR: data, LIVE_DIR: live, DEMO_LIVE_PROJECT: 'credaflow-fairscore',
      STUB_LOG: log, STUB_ROOT: root, STUB_LIVE_DIR: live, STUB_PROJECT: 'credaflow-fairscore', STUB_DEMO_MODE: 'true',
      STUB_DEMO_IMAGE: `credaflow:demo-${short('c2')}`, STUB_DB_BIND: '127.0.0.1:5466', STUB_TENANTS: 'acme', STUB_IMAGE_LABEL: 'acme',
      ...env,
    },
    encoding: 'utf8',
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, calls: logged() }
}

export const logged = (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean)
export const idx = (calls: string[], needle: string): number => calls.findIndex((c) => c.includes(needle))
export const liveEnv = (): string => readFileSync(join(live, '.env'), 'utf8')
export const pinned = (key: string): string => new RegExp(`^${key}=(.*)$`, 'm').exec(liveEnv())?.[1] ?? ''
export const worktrees = (): string[] => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '))
export const mutating = (calls: string[]): string[] =>
  calls.filter((c) => /pg_dump|migrate deploy|docker-compose|docker build|npm ci/.test(c))

// Several tests run the script twice or more, each run a bash process tree.
const TEST_TIMEOUT_MS = 30_000

export function installStackHooks(): void {
  vi.setConfig({ testTimeout: TEST_TIMEOUT_MS, hookTimeout: TEST_TIMEOUT_MS })
  beforeEach(setupStack)
  afterEach(teardownStack)
}

function setupStack(): void {
  root = mkdtempSync(join(tmpdir(), 'upgrade-stack-'))
  repo = join(root, 'repo')
  live = join(root, 'fairscore')
  data = join(root, 'data')
  log = join(root, 'calls.log')
  writeFileSync(log, '')
  mkdirSync(repo)
  mkdirSync(join(root, 'bin'))
  const stub = (name: string, body: string) => {
    writeFileSync(join(root, 'bin', name), body)
    chmodSync(join(root, 'bin', name), 0o755)
  }
  stub('docker', DOCKER_STUB)
  stub('docker-compose', COMPOSE_STUB)
  stub('npx', NPX_STUB)
  stub('npm', NPM_STUB)
  stub('curl', CURL_STUB)
  stub('sleep', '#!/bin/sh\nexit 0\n')

  git(repo, 'init', '-q', '-b', 'main')
  const demo = (n: string) => readFileSync(join(__dirname, n), 'utf8')
  commit('c1', {
    'package.json': '{"name":"upgrade-test"}', 'package-lock.json': '{"v":1}', Dockerfile: 'FROM scratch\n', '.gitignore': 'node_modules/\n',
    'scripts/demo/upgrade-stack.sh': demo('upgrade-stack.sh'),
    'scripts/demo/upgrade-stack.lib.sh': demo('upgrade-stack.lib.sh'),
    'scripts/demo/build-image.sh': demo('build-image.sh'),
    'scripts/demo/lib.sh': demo('lib.sh'),
    'prisma/demo-lender.ts': '// stub\n',
  })
  commit('c2', { README: 'two' })
  commit('c3', { README: 'three' })

  OLD_IMAGE = `credaflow:fairscore-${short('c1')}`
  mkdirSync(live)
  const secrets = Object.entries(SECRETS).map(([k, v]) => `${k}=${v}\n`).join('')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'secrets.env'), secrets)
  writeFileSync(join(root, 'container.env'), `PORT=3300\n${secrets}`)
  writeFileSync(join(live, 'docker-compose.demo.yml'), '')
  writeFileSync(join(live, '.env.production'), 'TENANT_HOST_MAP=fairscore.example.invalid=acme,fairscore-staff.example.invalid=acme\nDEMO_MODE=true\n')
  writeFileSync(join(live, '.env'), [
    'POSTGRES_USER=credaflow', `POSTGRES_PASSWORD=${PASSWORD}`, 'POSTGRES_DB=credaflow_demo', 'PORTAL_AUTH_URL=https://fairscore.example.invalid',
    'NEXT_PUBLIC_TENANT_SLUG=acme', 'NEXT_PUBLIC_PORTAL_LOGIN_URL=https://fairscore.example.invalid/portal/login',
    `APP_IMAGE=${OLD_IMAGE}`, `GIT_SHA=fairscore-${short('c1')}`, 'BUILD_TIME=2026-01-01T00:00:00Z', '',
  ].join('\n'))
}

function teardownStack(): void {
  rmSync(root, { recursive: true, force: true })
}
