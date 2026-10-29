import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import type { ChangeHandler, Tx } from "@/lib/maker-checker/types"
import {
  ENGINE_CONFIG_KIND, RULE_SET_KIND, parseEngineConfigPayload, parseRuleSetPayload,
  type EngineConfigPayload, type RuleSetPayload,
} from "./change-payloads"

const DELEGATE_ROLES = ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"] as const

export const decisionRuleSetHandler: ChangeHandler<RuleSetPayload> = {
  kind: RULE_SET_KIND,
  label: "Decision rule set",
  makePermission: "manage_decision_rules",
  approvePermission: "approve_decision_rules",
  parse: parseRuleSetPayload,
  async verify(tx: Tx, tenantId, payload) {
    if (!payload.productId) return
    const product = await tx.loanProduct.findFirst({ where: { id: payload.productId, tenantId }, select: { id: true } })
    if (!product) throw new InvalidPayloadError(["payload.productId: that product does not exist"])
  },
  async apply(tx: Tx, { tenantId, request, payload, checker, now }) {
    const scopeKey = payload.productId ?? "ALL"
    const latest = await tx.decisionRuleSetVersion.aggregate({ where: { tenantId, scopeKey }, _max: { version: true } })
    const version = (latest._max.version ?? 0) + 1
    // A version cannot take effect in the past: a day already gone starts today.
    const today = sastCalendarDate(now)
    const effectiveFrom = payload.effectiveFrom < today ? today : payload.effectiveFrom
    const created = await tx.decisionRuleSetVersion.create({
      data: {
        tenantId,
        scopeKey,
        productId: payload.productId,
        version,
        name: payload.name,
        rules: payload.rules as never,
        scorecard: (payload.scorecard ?? undefined) as never,
        effectiveFrom: new Date(`${effectiveFrom}T00:00:00Z`),
        challengerOnly: payload.challengerOnly,
        changeRequestId: request.id,
      },
    })
    await logAuditStrict({
      tenantId,
      userId: checker.id,
      userEmail: checker.email,
      action: AuditAction.DECISION_RULE_SET_VERSION_CREATED,
      entity: "DecisionRuleSetVersion",
      entityId: created.id,
      newValue: { scopeKey, version, name: payload.name, effectiveFrom, challengerOnly: payload.challengerOnly, rules: payload.rules.length, scorecard: payload.scorecard !== null, changeRequestId: request.id, makerId: request.makerId },
    }, tx)
  },
}

export const decisionEngineConfigHandler: ChangeHandler<EngineConfigPayload> = {
  kind: ENGINE_CONFIG_KIND,
  label: "Decision engine settings",
  makePermission: "manage_decision_rules",
  approvePermission: "approve_decision_rules",
  parse: parseEngineConfigPayload,
  async verify(tx: Tx, tenantId, payload) {
    const problems: string[] = []
    const products = await tx.loanProduct.findMany({ where: { tenantId, id: { in: payload.productIds } }, select: { id: true } })
    const missing = payload.productIds.filter((id) => !products.some((p) => p.id === id))
    if (missing.length > 0) problems.push(`payload.productIds: unknown product ${missing.join(", ")}`)
    if (payload.delegateUserId) {
      const user = await tx.user.findFirst({ where: { id: payload.delegateUserId, tenantId, active: true }, select: { role: true } })
      if (!user || !(DELEGATE_ROLES as readonly string[]).includes(user.role)) {
        problems.push("payload.delegateUserId: the delegate must be an active user of LOAN_ADMIN or above")
      }
    }
    if (payload.challengerVersionId) {
      const version = await tx.decisionRuleSetVersion.findFirst({ where: { id: payload.challengerVersionId, tenantId }, select: { id: true } })
      if (!version) problems.push("payload.challengerVersionId: no such rule set version")
    }
    if (payload.mode !== "OFF") {
      const sets = await tx.decisionRuleSetVersion.findMany({ where: { tenantId, challengerOnly: false }, select: { scopeKey: true }, distinct: ["scopeKey"] })
      const scopes = new Set(sets.map((s) => s.scopeKey))
      const bare = payload.productIds.filter((id) => !scopes.has(id) && !scopes.has("ALL"))
      if (bare.length > 0) problems.push(`payload.productIds: no approved rule set applies to ${bare.join(", ")}; approve one first`)
    }
    if (problems.length > 0) throw new InvalidPayloadError(problems)
  },
  async apply(tx: Tx, { tenantId, request, payload, checker }) {
    const previous = await tx.decisionEngineConfig.findUnique({ where: { tenantId } })
    const data = {
      mode: payload.mode,
      channels: payload.channels,
      productIds: payload.productIds,
      delegateUserId: payload.delegateUserId,
      repaymentMethod: payload.repaymentMethod,
      challengerVersionId: payload.challengerVersionId,
      challengerPercent: payload.challengerPercent,
    }
    await tx.decisionEngineConfig.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data })
    await logAuditStrict({
      tenantId,
      userId: checker.id,
      userEmail: checker.email,
      action: AuditAction.DECISION_ENGINE_CONFIG_APPLIED,
      entity: "DecisionEngineConfig",
      entityId: tenantId,
      oldValue: previous ? { mode: previous.mode, channels: previous.channels, productIds: previous.productIds, challengerPercent: previous.challengerPercent } : { mode: "OFF" },
      newValue: { ...data, changeRequestId: request.id, makerId: request.makerId },
    }, tx)
  },
}
