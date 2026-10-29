import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import type { ChangeHandler, Tx } from "@/lib/maker-checker/types"
import {
  ENGINE_CONFIG_KIND, RULE_SET_KIND, parseEngineConfigPayload, parseRuleSetPayload,
  type EngineConfigPayload, type RuleSetPayload,
} from "./change-payloads"
import { ensureSystemUser } from "./system-user"

export const decisionRuleSetHandler: ChangeHandler<RuleSetPayload> = {
  kind: RULE_SET_KIND,
  label: "Decision rule set",
  payloadVersion: 1,
  makePermission: "manage_decision_rules",
  approvePermission: "approve_decision_rules",
  parse: parseRuleSetPayload,
  async verify(tx: Tx, tenantId, payload) {
    if (!payload.productId) return
    const product = await tx.loanProduct.findFirst({ where: { id: payload.productId, tenantId }, select: { id: true } })
    if (!product) throw new InvalidPayloadError(["payload.productId: that product does not exist"])
  },
  // A new version is drafted against the latest one of its scope: if another is approved first, this one is stale.
  async baseRef(tx: Tx, tenantId, payload) {
    const latest = await tx.decisionRuleSetVersion.aggregate({ where: { tenantId, scopeKey: payload.productId ?? "ALL" }, _max: { version: true } })
    return `v${latest._max.version ?? 0}`
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
  payloadVersion: 1,
  makePermission: "manage_decision_rules",
  approvePermission: "approve_decision_rules",
  parse: parseEngineConfigPayload,
  async verify(tx: Tx, tenantId, payload) {
    const problems: string[] = []
    const products = await tx.loanProduct.findMany({ where: { tenantId, id: { in: payload.productIds } }, select: { id: true } })
    const missing = payload.productIds.filter((id) => !products.some((p) => p.id === id))
    if (missing.length > 0) problems.push(`payload.productIds: unknown product ${missing.join(", ")}`)
    if (payload.challengerVersionId) {
      const version = await tx.decisionRuleSetVersion.findFirst({ where: { id: payload.challengerVersionId, tenantId }, select: { effectiveFrom: true } })
      if (!version) problems.push("payload.challengerVersionId: no such rule set version")
      // A version runs only from its effective date, as champion or challenger.
      else if (version.effectiveFrom.toISOString().slice(0, 10) > sastCalendarDate(new Date())) {
        problems.push("payload.challengerVersionId: that version is not in effect yet; name it once its effective date has come")
      }
    }
    if (payload.mode !== "OFF") {
      const sets = await tx.decisionRuleSetVersion.findMany({ where: { tenantId, challengerOnly: false }, select: { scopeKey: true }, distinct: ["scopeKey"] })
      const scopes = new Set(sets.map((s) => s.scopeKey))
      const bare = payload.productIds.filter((id) => !scopes.has(id) && !scopes.has("ALL"))
      if (bare.length > 0) problems.push(`payload.productIds: no approved rule set applies to ${bare.join(", ")}; approve one first`)
    }
    if (problems.length > 0) throw new InvalidPayloadError(problems)
  },
  // Drafted against the settings now in force: approving over a newer change would silently undo it.
  async baseRef(tx: Tx, tenantId) {
    const current = await tx.decisionEngineConfig.findUnique({ where: { tenantId }, select: { changeRequestId: true } })
    return current?.changeRequestId ?? "none"
  },
  async apply(tx: Tx, { tenantId, request, payload, checker, now }) {
    const previous = await tx.decisionEngineConfig.findUnique({ where: { tenantId } })
    // Sign-off is kept while the wording it covered is unchanged; any other change to the notice needs a fresh one.
    const keepSignOff = payload.s71SignOff && previous?.s71SignedOffAt != null && previous.automatedDeclineNotice === payload.automatedDeclineNotice
    const data = {
      mode: payload.mode,
      channels: payload.channels,
      productIds: payload.productIds,
      repaymentMethod: payload.repaymentMethod,
      challengerVersionId: payload.challengerVersionId,
      challengerPercent: payload.challengerPercent,
      automatedDeclineNotice: payload.automatedDeclineNotice,
      s71SignedOffAt: payload.s71SignOff ? (keepSignOff ? previous!.s71SignedOffAt : now) : null,
      s71SignedOffById: payload.s71SignOff ? (keepSignOff ? previous!.s71SignedOffById : checker.id) : null,
      changeRequestId: request.id,
    }
    if (payload.mode !== "OFF") await ensureSystemUser(tx, tenantId)
    await tx.decisionEngineConfig.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data })
    await logAuditStrict({
      tenantId,
      userId: checker.id,
      userEmail: checker.email,
      action: AuditAction.DECISION_ENGINE_CONFIG_APPLIED,
      entity: "DecisionEngineConfig",
      entityId: tenantId,
      oldValue: previous ? { mode: previous.mode, channels: previous.channels, productIds: previous.productIds, challengerPercent: previous.challengerPercent, s71SignedOff: previous.s71SignedOffAt !== null } : { mode: "OFF" },
      newValue: { mode: data.mode, channels: data.channels, productIds: data.productIds, repaymentMethod: data.repaymentMethod, challengerVersionId: data.challengerVersionId, challengerPercent: data.challengerPercent, s71SignedOff: data.s71SignedOffAt !== null, noticeSet: data.automatedDeclineNotice !== null, changeRequestId: request.id, makerId: request.makerId },
    }, tx)
  },
}
