import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { lender, repo, root, sh, SRC } from "./scripts.test-helpers"

describe("docker-compose.lender.yml", () => {
  const compose = spawnSync("sh", ["-c", "docker compose version >/dev/null 2>&1 && echo 'docker compose' || (docker-compose version >/dev/null 2>&1 && echo docker-compose)"], { encoding: "utf8" }).stdout.trim()

  it.skipIf(!compose)("is valid compose that publishes only the app port and pins no container name", () => {
    const dir = mkdtempSync(join(tmpdir(), "lender-compose-"))
    cpSync(join(SRC, "docker-compose.lender.yml"), join(dir, "docker-compose.yml"))
    writeFileSync(join(dir, ".env"), "")
    const env = { ...process.env, APP_IMAGE: "cf:x", APP_PORT: "3999", PORTAL_PORT: "3998", PORTAL_NEXTAUTH_URL: "https://portal.example", STAFF_AUTH_SECRET: "staff-secret", PORTAL_AUTH_SECRET: "portal-secret", POSTGRES_USER: "u", POSTGRES_PASSWORD: "p", POSTGRES_DB: "d", NEXTAUTH_SECRET: "s" }
    const [bin, ...sub] = compose.split(" ")
    const r = spawnSync(bin, [...sub, "-p", "x", "-f", join(dir, "docker-compose.yml"), "--project-directory", dir, "config", "--format", "json"], { env, encoding: "utf8" })
    rmSync(dir, { recursive: true, force: true })
    expect(r.status, r.stderr).toBe(0)
    const cfg = JSON.parse(r.stdout) as { services: Record<string, { ports?: { published: string; host_ip: string }[]; container_name?: string; environment?: Record<string, string> }> }
    expect(cfg.services.db.ports).toBeUndefined()
    expect(cfg.services.app.ports).toEqual([expect.objectContaining({ published: "3999", host_ip: "127.0.0.1" })])
    expect(Object.values(cfg.services).some((s) => s.container_name)).toBe(false)
    expect(cfg.services["app-portal"].ports).toEqual([expect.objectContaining({ published: "3998" })])
    // each host gets only its own session secret, and the portal its own origin
    expect(cfg.services.app.environment).toMatchObject({ AUTH_SECRET: "staff-secret", APP_MODE: "staff" })
    expect(cfg.services["app-portal"].environment).toMatchObject({ AUTH_SECRET: "portal-secret", APP_MODE: "client", NEXTAUTH_URL: "https://portal.example", AUTH_URL: "https://portal.example" })
    expect(JSON.stringify(cfg.services.app)).not.toContain("portal-secret")
    expect(JSON.stringify(cfg.services["app-portal"])).not.toContain("staff-secret")
  })
})

describe("admin.sh", () => {
  it("runs the admin CLI from the tools image of the deployed image, scoped to this lender, with the host operator", () => {
    writeFileSync(join(lender, "state/current-image"), "cf:new\n")
    const r = sh("admin.sh", [lender, "--email", "a@b.example", "--break-glass"])
    expect(r.status).toBe(0)
    const run = r.calls.find((c) => c.startsWith("run --rm"))!
    expect(run).toContain("--network credaflow-lender-stub-lender_default")
    expect(run).toMatch(/-e LENDER_OPERATOR=\S+@\S+/)
    expect(run).toContain("cf-tools:new npx tsx scripts/lender/bootstrap-admin-cli.ts --tenant stub-lender --email a@b.example --break-glass")
    expect(run).not.toContain("p@db") // the database password is passed by variable name, never in argv
  })

  it("refuses before anything is deployed", () => {
    const r = sh("admin.sh", [lender, "--email", "a@b.example"])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/nothing deployed/)
  })
})

describe("provision-lender.sh", () => {
  const provision = (dir: string, extra: string[] = [], env: Record<string, string> = {}) => {
    writeFileSync(join(root, "cfg.json"), JSON.stringify({ slug: "stub-lender" }))
    return sh("provision-lender.sh", [dir, "--config", join(root, "cfg.json"), "--port", "3999", "--public-url", "https://staff.example",
      "--portal-port", "3998", "--portal-url", "https://portal.example", "--image", "cf:new", "--admin-email", "a@b.example", ...extra], { STUB_LENDER: dir, ...env })
  }

  it("refuses a lender directory inside the git checkout", () => {
    const r = provision(join(repo, "lender-here"))
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/inside the git checkout/)
    expect(existsSync(join(repo, "lender-here"))).toBe(false)
  })

  it("refuses the same host port for staff and portal", () => {
    const r = provision(join(root, "new-lender"), ["--portal-port", "3999"])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/must differ/)
  })

  it("generates distinct staff and portal secrets in a 0600 auth.env, keeps them out of .env, and a rerun rotates nothing", () => {
    const dir = join(root, "new-lender")
    const r = provision(dir)
    expect(r.status, r.out).toBe(0)
    const auth = join(dir, "secrets/auth.env")
    expect(statSync(auth).mode & 0o777).toBe(0o600)
    const read = (f: string, k: string) => readFileSync(f, "utf8").match(new RegExp(`^${k}=(.*)$`, "m"))?.[1] ?? ""
    const staff = read(auth, "STAFF_AUTH_SECRET"), portal = read(auth, "PORTAL_AUTH_SECRET")
    expect(staff).toHaveLength(64)
    expect(portal).toHaveLength(64)
    expect(staff).not.toBe(portal)
    const envText = readFileSync(join(dir, ".env"), "utf8")
    expect(envText).not.toContain(staff)
    expect(envText).not.toContain(portal)
    expect(envText).toContain("PORTAL_NEXTAUTH_URL=https://portal.example")
    expect(envText).toContain("NEXT_PUBLIC_PORTAL_LOGIN_URL=https://portal.example/portal/login")
    expect(r.out).not.toContain(staff)

    expect(provision(dir).status).toBe(0)
    expect(read(auth, "STAFF_AUTH_SECRET")).toBe(staff)
    expect(read(auth, "PORTAL_AUTH_SECRET")).toBe(portal)
  })

  it("refuses when another stack already owns the compose project, before creating the lender directory", () => {
    const dir = join(root, "new-lender")
    const r = provision(dir, [], { STUB_PROJECT_DIR: "/srv/some-other-stack" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/project 'credaflow-lender-stub-lender' already has a container with working_dir '\/srv\/some-other-stack'/)
    expect(existsSync(dir)).toBe(false)
    expect(r.calls.some((c) => /\bup\b|\bbuild\b|\brun\b/.test(c))).toBe(false)
  })

  it("refuses a labelled container that records no working_dir", () => {
    const r = provision(join(root, "new-lender"), [], { STUB_PROJECT_DIR: "BLANK" })
    expect(r.status).not.toBe(0)
  })

  it("treats a volume or network already carrying the project label as a collision for a NEW directory, not for a rerun", () => {
    const dir = join(root, "new-lender")
    const fresh = provision(dir, [], { STUB_FOREIGN_VOLUME: "credaflow-lender-stub-lender_pgdata" })
    expect(fresh.status).not.toBe(0)
    expect(fresh.out).toMatch(/already has volume resource\(s\) \(credaflow-lender-stub-lender_pgdata\) and this lender directory is new/)
    expect(existsSync(dir)).toBe(false)
    expect(provision(dir).status).toBe(0)
    expect(provision(dir, [], { STUB_FOREIGN_VOLUME: "credaflow-lender-stub-lender_pgdata" }).status).toBe(0)
  })

  it("accepts the project when its recorded working_dir is this very lender directory (a rerun)", () => {
    const dir = join(root, "new-lender")
    expect(provision(dir).status).toBe(0)
    const r = provision(dir, [], { STUB_PROJECT_DIR: dir })
    expect(r.status, r.out).toBe(0)
  })

  it("on a rerun, keeps a differing existing setting and says so; --update-settings changes it explicitly", () => {
    const dir = join(root, "new-lender")
    expect(provision(dir).status).toBe(0)
    const kept = provision(dir, ["--port", "4001", "--portal-url", "https://other.example"])
    expect(kept.out).toMatch(/kept existing APP_PORT=3999 \(requested 4001; pass --update-settings/)
    expect(kept.out).toMatch(/kept existing PORTAL_NEXTAUTH_URL=https:\/\/portal.example/)
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("APP_PORT=3999")
    const updated = provision(dir, ["--port", "4001", "--update-settings"])
    expect(updated.out).toMatch(/updated APP_PORT: 3999 -> 4001/)
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("APP_PORT=4001")
  })

  it("an unchanged rerun says nothing about settings", () => {
    const dir = join(root, "new-lender")
    provision(dir)
    expect(provision(dir).out).not.toMatch(/kept existing|updated /)
  })
})

