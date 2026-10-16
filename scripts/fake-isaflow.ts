#!/usr/bin/env tsx
/**
 * Runs the fake IsaFlow MCP server (lib/accounting/isaflow/fake-isaflow.integration-fixture.ts)
 * for a local browser run: a dev server connects to it from Settings → Integrations → IsaFlow
 * and pushes closed months to it. Nothing here reaches a real IsaFlow.
 *
 *   npx tsx scripts/fake-isaflow.ts [port]          # default 4010
 *
 * The chart holds every DEFAULT_ACCOUNTS code, active, plus 4999 inactive. The
 * token is fixed (FAKE_ISAFLOW_TOKEN overrides it). Start the dev server with
 *   ISAFLOW_ALLOWED_ORIGINS=http://127.0.0.1:<port>
 * (http is accepted only for a listed loopback origin under NODE_ENV
 * development or test). Ctrl-C stops it; the drafts live in memory only.
 */
import { DEFAULT_ACCOUNTS } from "../lib/accounting/accounts"
import { FakeIsaFlow } from "../lib/accounting/isaflow/fake-isaflow.integration-fixture"

const port = Number(process.argv[2] ?? process.env.FAKE_ISAFLOW_PORT ?? "4010")
const token = process.env.FAKE_ISAFLOW_TOKEN ?? "pat_fake_isaflow_dev_0123456789"

async function main(): Promise<void> {
  const codes = [...new Set(Object.values(DEFAULT_ACCOUNTS).map((a) => a.code))]
  const fake = new FakeIsaFlow({
    companyName: "Fake IsaFlow Dev Co",
    tokens: { [token]: ["write:journals", "read:reports"] },
    accounts: [
      ...codes.map((code) => ({ code, name: Object.values(DEFAULT_ACCOUNTS).find((a) => a.code === code)!.name })),
      { code: "4999", name: "Retired income account", active: false },
    ],
  })
  const url = await fake.start(port)
  process.stdout.write([
    `fake IsaFlow listening on ${url}/api/mcp`,
    `  token:    ${token}`,
    `  company:  ${fake.companyName} (${fake.companyId})`,
    `  dev env:  ISAFLOW_ALLOWED_ORIGINS=${url}`,
    "",
  ].join("\n"))
  let seen = 0
  setInterval(() => {
    for (const call of fake.calls.slice(seen)) process.stdout.write(`${new Date().toISOString()} ${call.tool} -> ${call.outcome}\n`)
    seen = fake.calls.length
  }, 500)
  process.on("SIGINT", () => void fake.stop().then(() => process.exit(0)))
}

main().catch((error: unknown) => {
  process.stderr.write(`fake IsaFlow failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
