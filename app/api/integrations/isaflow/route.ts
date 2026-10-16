import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { superAdminPolicyWrite, type PolicyWriteContext } from "@/lib/security/policy-write-guard"
import { IsaFlowError } from "@/lib/accounting/isaflow/client"
import {
  disconnectIsaFlow, isaflowStatus, markIsaFlowNeedsReconnect, parseConnectInput, probeIsaFlow, recordIsaFlowVerified, redactTokens, saveIsaFlowConnection,
  verifyProbe,
  type Probe,
} from "@/lib/accounting/isaflow/connection"

// Settings → Integrations → IsaFlow. GET (ADMIN): status, never the token.
// POST { action: "connect", baseUrl, token } proves the token against IsaFlow
// and stores it sealed; { action: "verify" } proves the stored one again;
// { action: "disconnect" }. Writes: a SUPER_ADMIN whose session verified a
// TOTP code, re-checked on the locked row (superAdminPolicyWrite). The
// IsaFlow calls run before that transaction and write nothing; what they
// found (a refusal, a token IsaFlow no longer takes) is recorded inside it,
// after the re-check. Audited, refusals included; no audit row carries the token.

type Refusal = { kind: IsaFlowError["kind"]; message: string }
type Input =
  | { action: "connect"; baseUrl: string; token: string; probe?: Probe; refused?: Refusal }
  | { action: "verify"; probe?: Probe; refused?: Refusal }
  | { action: "disconnect" }

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => NextResponse.json(await isaflowStatus(prisma, tenant.id)))
}

function parse(body: unknown): Response | Input {
  const action = (body as { action?: unknown } | null)?.action
  if (action === "verify" || action === "disconnect") return { action }
  if (action !== "connect") return NextResponse.json({ error: "action must be connect, verify or disconnect" }, { status: 400 })
  const input = parseConnectInput(body)
  return typeof input === "string" ? NextResponse.json({ error: input }, { status: 400 }) : { action, ...input }
}

/** The IsaFlow calls: no writes here, whatever IsaFlow answers. */
async function prepare(raw: object, ctx: PolicyWriteContext): Promise<Input> {
  const input = raw as Input
  if (input.action === "disconnect") return input
  try {
    const probe = input.action === "connect"
      ? await probeIsaFlow({ baseUrl: input.baseUrl, token: input.token })
      : await verifyProbe(prisma, ctx.tenantId)
    return { ...input, probe }
  } catch (error) {
    if (!(error instanceof IsaFlowError)) throw error
    return { ...input, refused: { kind: error.kind, message: error.message } }
  }
}

export async function POST(req: NextRequest) {
  return superAdminPolicyWrite(req, parse, async (tx, raw, ctx) => {
    const input = raw as Input
    const who = { tenantId: ctx.tenantId, actor: ctx.actor, ip: ctx.ip }
    if (input.action !== "disconnect" && input.refused) {
      const { kind, message } = input.refused
      if (input.action === "verify" && kind === "auth") await markIsaFlowNeedsReconnect(tx, { ...who, reason: message })
      await logAuditStrict({
        tenantId: ctx.tenantId, userId: ctx.actor.id, userEmail: ctx.actor.email, action: AuditAction.ISAFLOW_CONNECT_REFUSED,
        entity: "IsaFlowConnection", entityId: ctx.tenantId, ipAddress: ctx.ip, newValue: { action: input.action, kind, reason: redactTokens(message).slice(0, 500) },
      }, tx)
      return NextResponse.json({ error: message }, { status: kind === "unknown" ? 502 : 422 })
    }
    try {
      if (input.action === "connect") await saveIsaFlowConnection(tx, { ...who, probe: input.probe!, token: input.token })
      else if (input.action === "verify" && !(await recordIsaFlowVerified(tx, { ...who, probe: input.probe! }))) {
        return NextResponse.json({ error: "IsaFlow is no longer connected; connect it again" }, { status: 409 })
      } else if (input.action === "disconnect") await disconnectIsaFlow(tx, who)
    } catch (error) {
      if (error instanceof IsaFlowError) return NextResponse.json({ error: error.message }, { status: 503 })
      throw error
    }
    return NextResponse.json(await isaflowStatus(tx, ctx.tenantId))
  }, prepare)
}
