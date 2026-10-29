/**
 * An AuditLog row as a SIEM event. Field mapping (documented in
 * lib/audit/.claude.md):
 *
 *   AuditLog        JSON            CEF            syslog (RFC 5424)
 *   id              eventId         externalId     SD cf@32473 eventId
 *   createdAt       timestamp       rt (ms epoch)  TIMESTAMP
 *   action          action          signature + name  MSGID
 *   userId          actor.userId    suid           SD userId
 *   ipAddress       sourceIp        src            SD ip          (VALUE_ACTIONS only)
 *   entity/entityId entity/entityId cs1/cs2        SD entity, entityId
 *   chainSeq/rowHash chain.*        cn1, cs3       SD seq, rowHash
 *   old/newValue    old/newValue    cs4/cs5 (truncated)  in the CEF MSG  (VALUE_ACTIONS only, masked)
 *
 * The email is never sent (lib/audit/siem/minimise.ts).
 *
 * The syslog message body is the CEF line, so a SIEM that parses CEF needs no
 * mapping of its own; JSON carries the values whole.
 */

import { isValueAction, maskValue } from "./minimise"

export interface SiemSourceRow {
  id: string
  tenantId: string | null
  userId: string | null
  action: string
  entity: string
  entityId: string | null
  oldValue: unknown
  newValue: unknown
  ipAddress: string | null
  createdAt: Date
  chainSeq: number | null
  rowHash: string | null
  prevHash: string | null
}

export interface SiemEvent {
  eventId: string
  timestamp: string
  tenantId: string | null
  action: string
  severity: number
  actor: { userId: string | null }
  sourceIp: string | null
  entity: string
  entityId: string | null
  oldValue: unknown
  newValue: unknown
  chain: { seq: number | null; rowHash: string | null; prevHash: string | null }
}

const FACILITY_LOG_AUDIT = 13
const CEF_VALUE_CAP = 1000
/**
 * RFC 5424 structured-data id: cf@<enterprise number>. 32473 is the number RFC 5612
 * reserves for documentation; a deployment sets AUDIT_SYSLOG_PEN to its own
 * IANA-registered number.
 */
export function sdId(): string {
  const pen = process.env.AUDIT_SYSLOG_PEN
  return `cf@${pen && /^\d{1,10}$/.test(pen) ? pen : "32473"}`
}

/** CEF severity 0-10: failures and denials 5, a broken chain 9, the rest 3. */
export function severityOf(action: string): number {
  if (action === "AUDIT_CHAIN_BROKEN") return 9
  return /(FAILED|FAILURE|DENIED|REFUSED|INVALID|LOCKED)/.test(action) ? 5 : 3
}

export function toSiemEvent(row: SiemSourceRow): SiemEvent {
  const values = isValueAction(row.action)
  return {
    eventId: row.id,
    timestamp: row.createdAt.toISOString(),
    tenantId: row.tenantId,
    action: row.action,
    severity: severityOf(row.action),
    actor: { userId: row.userId },
    sourceIp: values ? row.ipAddress : null,
    entity: row.entity,
    entityId: row.entityId,
    oldValue: values ? maskValue(row.oldValue) : null,
    newValue: values ? maskValue(row.newValue) : null,
    chain: { seq: row.chainSeq, rowHash: row.rowHash, prevHash: row.prevHash },
  }
}

const cefHeader = (v: string) => v.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ")
const cefExt = (v: string) => v.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/\r/g, "\\r").replace(/\n/g, "\\n")
const capped = (value: unknown) => {
  if (value === null || value === undefined) return ""
  const text = JSON.stringify(value)
  return text.length > CEF_VALUE_CAP ? `${text.slice(0, CEF_VALUE_CAP)}...[truncated]` : text
}

export function toCef(e: SiemEvent): string {
  const ext: Array<[string, string | number | null | undefined]> = [
    ["externalId", e.eventId], ["rt", Date.parse(e.timestamp)], ["suid", e.actor.userId],
    ["src", e.sourceIp], ["act", e.action],
    ["cs1Label", "entity"], ["cs1", e.entity], ["cs2Label", "entityId"], ["cs2", e.entityId],
    ["cs3Label", "rowHash"], ["cs3", e.chain.rowHash], ["cn1Label", "chainSeq"], ["cn1", e.chain.seq],
    ["cs4Label", "oldValue"], ["cs4", capped(e.oldValue)], ["cs5Label", "newValue"], ["cs5", capped(e.newValue)],
    ["cs6Label", "tenantId"], ["cs6", e.tenantId],
  ]
  const extension = ext
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${cefExt(String(v))}`)
    .join(" ")
  return `CEF:0|CredaFlow|CredaFlow LMS|1|${cefHeader(e.action)}|${cefHeader(e.action)}|${e.severity}|${extension}`
}

const sdValue = (v: string) => v.replace(/[\\"\]]/g, (c) => `\\${c}`)
// RFC 5424 MSGID: 1-32 printable US-ASCII, no space.
const msgId = (action: string) => action.replace(/[^\x21-\x7e]/g, "_").slice(0, 32) || "-"
// Syslog severity (RFC 5424 table 2) from the CEF one.
const syslogSeverity = (cef: number) => (cef >= 9 ? 2 : cef >= 5 ? 4 : 6)

/** One RFC 5424 message (no framing). */
export function toSyslog5424(e: SiemEvent, hostname: string): string {
  const pri = FACILITY_LOG_AUDIT * 8 + syslogSeverity(e.severity)
  const sd: Array<[string, string | number | null]> = [
    ["eventId", e.eventId], ["tenant", e.tenantId], ["seq", e.chain.seq], ["rowHash", e.chain.rowHash],
    ["userId", e.actor.userId], ["ip", e.sourceIp], ["entity", e.entity], ["entityId", e.entityId],
  ]
  const params = sd.filter(([, v]) => v !== null && v !== "").map(([k, v]) => ` ${k}="${sdValue(String(v))}"`).join("")
  const host = hostname.replace(/[^\x21-\x7e]/g, "_").slice(0, 255) || "-"
  return `<${pri}>1 ${e.timestamp} ${host} credaflow - ${msgId(e.action)} [${sdId()}${params}] \uFEFF${toCef(e)}`
}

/** RFC 6587 octet-counting frame: a newline in a message cannot split it. */
export function frameOctetCounted(message: string): Buffer {
  const body = Buffer.from(message, "utf8")
  return Buffer.concat([Buffer.from(`${body.length} `, "ascii"), body])
}
