import { execFileSync } from "node:child_process"
import path from "node:path"

export default function setup() {
  execFileSync(process.execPath, [path.join(__dirname, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/gen-registries.ts"], {
    cwd: __dirname,
    stdio: "inherit",
  })
}
