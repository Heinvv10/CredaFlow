/**
 * Calls a Next.js Server Action over HTTP exactly as the page's client code
 * does: POST to the page's route with a `Next-Action` header naming the
 * action, the arguments encoded the way React's `encodeReply` encodes them,
 * and an RSC (`text/x-component`) response whose row 1 is the return value.
 *
 * Action ids are build-specific hashes. They are read from the running sim
 * image's server-reference manifest (read-only `docker exec`), keyed by the
 * exported function name and the page that imports it.
 *
 * Encoding (react-server-dom-webpack processReply, as bundled by Next 16):
 *   - plain JSON-able arguments → a text body: the JSON array of arguments;
 *   - a FormData argument → a multipart body whose entries are prefixed
 *     `_<ref>_` and whose root field "0" holds `["$K<ref>"]`. The root must be
 *     the LAST part: the server resolves the reference as soon as "0" arrives.
 */
import { execFileSync } from "node:child_process"

import { parseJsonBody, type SimClient } from "../sim/api"

const APP_CONTAINER = "credaflow-demo-sim-app"
const MANIFEST = "/app/.next/server/server-reference-manifest.json"

interface ManifestEntry {
  exportedName?: string
  workers: Record<string, unknown>
}

let manifest: Record<string, ManifestEntry> | null = null

function actionId(name: string, page: string): string {
  if (!manifest) {
    const raw = execFileSync("docker", ["exec", APP_CONTAINER, "cat", MANIFEST], { encoding: "utf8" })
    manifest = parseJsonBody<{ node: Record<string, ManifestEntry> }>("EXEC", MANIFEST, 0, raw).node
  }
  const worker = `app/(dashboard)${page}/page`
  const hit = Object.entries(manifest).find(([, e]) => e.exportedName === name && worker in e.workers)
  if (!hit) throw new Error(`no server action ${name} for ${worker} in ${MANIFEST}`)
  return hit[0]
}

/** Parses the action's return value out of the RSC payload (row "1"). */
function returnValue<T>(body: string, name: string): T {
  const row = body.split("\n").find((l) => l.startsWith("1:"))
  if (!row) throw new Error(`${name}: no return row in the action response: ${body.slice(0, 300)}`)
  const raw = row.slice(2)
  // An action returning undefined serialises as "$undefined".
  return (raw === '"$undefined"' ? undefined : parseJsonBody<T>("ACTION", name, 200, raw)) as T
}

async function post<T>(actor: SimClient, name: string, page: string, body: FormData | string): Promise<T> {
  const headers: Record<string, string> = {
    "Next-Action": actionId(name, page),
    accept: "text/x-component",
    origin: actor.baseUrl,
  }
  if (typeof body === "string") headers["content-type"] = "text/plain;charset=UTF-8"
  const res = await actor.request("POST", page, body, { headers, expect: [200] })
  return returnValue<T>(res.text, name)
}

/** An action called with one FormData argument (a form's `new FormData(form)`). */
export async function callFormAction<T>(actor: SimClient, name: string, page: string, form: FormData): Promise<T> {
  const body = new FormData()
  for (const [key, value] of form.entries()) body.append(`_1_${key}`, value)
  body.append("0", '["$K1"]')
  return post<T>(actor, name, page, body)
}

/** An action called with string arguments. */
export async function callAction<T>(actor: SimClient, name: string, page: string, args: string[]): Promise<T> {
  return post<T>(actor, name, page, JSON.stringify(args))
}
