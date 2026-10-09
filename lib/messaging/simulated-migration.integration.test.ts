/**
 * Behavioural proof for the SIMULATED enum and the guards that keep local
 * simulation receipts and unevidenced delivery claims apart from provider
 * evidence (Message_truthful_dry_run, Message_legacy_placeholder_guard,
 * Conversation_truthful_last_outbound, NotificationLog_truthful_delivery_guard,
 * EmailLog_truthful_graph_evidence, EmailLog_stage_ambiguous_status).
 *
 * Run only against a throwaway PostgreSQL database migrated with the baseline:
 *
 *   RUN_SIMULATED_MIGRATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/simulated-migration.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_SIMULATED_MIGRATION_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

function psql(args: string[]): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the simulated migration test")
  const psqlUrl = new URL(databaseUrl)
  // Prisma accepts this application-level query option; libpq/psql does not.
  psqlUrl.searchParams.delete("schema")
  return execFileSync(
    "psql",
    ["--no-psqlrc", "--dbname", psqlUrl.toString(), "-X", "-v", "ON_ERROR_STOP=1", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim()
}

function sql(value: string): string {
  return psql(["-At", "-c", value])
}

suite("SIMULATED message migration", () => {
  const tenantId = `tenant_simulation_${token}`
  // One contact per conversation: Conversation_one_open_per_contact allows a
  // contact only one open conversation.
  const contactId = `contact_simulation_${token}`
  const waContactId = `contact_wa_simulation_${token}`
  const emailContactId = `contact_email_simulation_${token}`
  const conversationId = `conversation_simulation_${token}`
  const waConversationId = `conversation_wa_simulation_${token}`
  const emailConversationId = `conversation_email_simulation_${token}`
  const realMessageId = `message_real_${token}`
  const wrongPairMessageId = `message_wrong_pair_${token}`
  const rollingWriterMessageId = `message_rolling_writer_${token}`
  const rollingWriterAuditId = `audit_rolling_writer_${token}`
  const rollingNotificationId = `notification_rolling_${token}`
  const linkedNotificationId = `notification_linked_${token}`
  const danglingLinkNotificationId = `notification_dangling_link_${token}`
  const rollingGraphMessageId = `message_rolling_graph_${token}`
  const rollingGraphAuditId = `audit_rolling_graph_${token}`
  const rollingGraphEmailLogId = `email_rolling_graph_${token}`
  const stagedAmbiguousEmailLogId = `email_staged_ambiguous_${token}`
  const validGraphMessageId = `message_valid_graph_${token}`
  const validGraphEmailLogId = `email_valid_graph_${token}`
  const rollingSmsPlaceholderMessageId = `message_rolling_sms_placeholder_${token}`
  const rollingSmsPlaceholderAuditId = `audit_rolling_sms_placeholder_${token}`
  const rollingWaPlaceholderMessageId = `message_rolling_wa_placeholder_${token}`
  const rollingWaPlaceholderAuditId = `audit_rolling_wa_placeholder_${token}`

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt")
      VALUES ('${tenantId}', 'simulation-${token}', 'Simulation migration test', CURRENT_TIMESTAMP);

      INSERT INTO "Contact" (
        "id", "tenantId", "firstSeenChannel", "updatedAt"
      ) VALUES
        ('${contactId}', '${tenantId}', 'SMS', CURRENT_TIMESTAMP),
        ('${waContactId}', '${tenantId}', 'WHATSAPP', CURRENT_TIMESTAMP),
        ('${emailContactId}', '${tenantId}', 'EMAIL', CURRENT_TIMESTAMP);

      INSERT INTO "Conversation" (
        "id", "tenantId", "contactId", "channel", "lastOutboundAt", "updatedAt"
      ) VALUES
        ('${conversationId}', '${tenantId}', '${contactId}', 'SMS', TIMESTAMP '2026-07-18 09:00:00', CURRENT_TIMESTAMP),
        ('${waConversationId}', '${tenantId}', '${waContactId}', 'WHATSAPP', TIMESTAMP '2026-07-18 09:20:00', CURRENT_TIMESTAMP),
        ('${emailConversationId}', '${tenantId}', '${emailContactId}', 'EMAIL', TIMESTAMP '2026-07-18 09:45:00', CURRENT_TIMESTAMP);

      INSERT INTO "Message" (
        "id", "tenantId", "conversationId", "channel", "direction", "provider",
        "providerMessageId", "status", "sentAt"
      ) VALUES
        (
          '${realMessageId}', '${tenantId}', '${conversationId}', 'SMS', 'OUTBOUND',
          'BULKSMS', 'provider-${token}', 'SENT', TIMESTAMPTZ '2026-07-18 08:55:00+00'
        ),
        (
          '${wrongPairMessageId}', '${tenantId}', '${waConversationId}', 'WHATSAPP', 'OUTBOUND',
          'BULKSMS', 'dry-run-${token}-wrong-pair', 'SENT', TIMESTAMPTZ '2026-07-18 09:20:00+00'
        );
    `)
  })

  it("orders SIMULATED after SENT", () => {
    expect(sql(`
      SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
      FROM pg_enum
      WHERE enumtypid = '"MsgStatus"'::regtype;
    `)).toContain("QUEUED,SENT,SIMULATED,DELIVERED")
  })

  it("rejects a NotificationLog link to a Message that does not exist", () => {
    sql(`
      INSERT INTO "NotificationLog" (
        "id", "tenantId", "event", "channel", "status", "createdAt"
      ) VALUES (
        '${danglingLinkNotificationId}', '${tenantId}', 'dangling_sms', 'sms',
        'review_required', CURRENT_TIMESTAMP
      );
    `)

    expect(() => sql(`
      UPDATE "NotificationLog"
      SET "messageId" = 'missing-message-${token}'
      WHERE "id" = '${danglingLinkNotificationId}';
    `)).toThrow()
  })

  it("protects messages, conversation metadata and delivery logs from legacy writers", () => {
    sql(`
      INSERT INTO "Message" (
        "id", "tenantId", "conversationId", "channel", "direction", "provider",
        "providerMessageId", "status"
      ) VALUES (
        '${rollingWriterMessageId}', '${tenantId}', '${conversationId}', 'SMS', 'OUTBOUND',
        'BULKSMS', NULL, 'QUEUED'
      );

      UPDATE "Message"
      SET "providerMessageId" = 'dry-run-rolling-${token}',
          "status" = 'SENT',
          "sentAt" = TIMESTAMP '2026-07-18 10:00:00',
          "dispatchProviderAcceptedAt" = TIMESTAMP '2026-07-18 10:00:00'
      WHERE "id" = '${rollingWriterMessageId}';

      UPDATE "Conversation"
      SET "lastOutboundAt" = TIMESTAMP '2026-07-18 10:00:01'
      WHERE "id" = '${conversationId}';

      INSERT INTO "AuditLog" (
        "id", "tenantId", "userEmail", "action", "entity", "entityId",
        "newValue", "createdAt"
      ) VALUES (
        '${rollingWriterAuditId}', '${tenantId}', 'legacy-writer@example.test',
        'MESSAGE_SENT', 'Message', '${rollingWriterMessageId}',
        '{"status":"SENT","providerAcceptedAt":"2026-07-18T10:00:00.000Z"}'::jsonb, CURRENT_TIMESTAMP
      );
    `)

    expect(sql(`
      SELECT concat_ws('|', "status"::text, coalesce("sentAt"::text, 'NULL'),
        coalesce("providerMessageId", 'NULL'),
        coalesce("dispatchProviderMessageId", 'NULL'),
        coalesce("dispatchProviderAcceptedAt"::text, 'NULL'),
        coalesce("simulationReceiptId", 'NULL'))
      FROM "Message"
      WHERE "id" = '${rollingWriterMessageId}';
    `)).toBe(`SIMULATED|NULL|NULL|NULL|NULL|dry-run-rolling-${token}`)
    expect(sql(`
      SELECT to_char("lastOutboundAt", 'YYYY-MM-DD HH24:MI:SS')
      FROM "Conversation"
      WHERE "id" = '${conversationId}';
    `)).toBe("2026-07-18 08:55:00")
    expect(sql(`
      SELECT concat_ws('|', "action", "newValue" ->> 'status',
        "newValue" ->> 'simulated', "newValue" ->> 'compatibilityCorrection',
        coalesce("newValue" ->> 'providerAcceptedAt', 'NULL'))
      FROM "AuditLog"
      WHERE "id" = '${rollingWriterAuditId}';
    `)).toBe("MESSAGE_SIMULATED|SIMULATED|true|legacy_dry_run_writer|NULL")

    sql(`
      INSERT INTO "NotificationLog" (
        "id", "tenantId", "event", "channel", "status", "createdAt"
      ) VALUES (
        '${rollingNotificationId}', '${tenantId}', 'rolling_email', 'email',
        'sent', CURRENT_TIMESTAMP
      );

      INSERT INTO "NotificationLog" (
        "id", "tenantId", "event", "channel", "status", "messageId", "createdAt"
      ) VALUES (
        '${linkedNotificationId}', '${tenantId}', 'linked_sms', 'sms',
        'sent', '${realMessageId}', CURRENT_TIMESTAMP
      );
    `)

    expect(sql(`
      SELECT concat_ws('|', "status", coalesce("messageId", 'NULL'))
      FROM "NotificationLog"
      WHERE "id" = '${rollingNotificationId}';
    `)).toBe("review_required|NULL")
    expect(sql(`
      SELECT "status"
      FROM "NotificationLog"
      WHERE "id" = '${linkedNotificationId}';
    `)).toBe("sent")
    expect(sql(`
      SELECT "action"
      FROM "AuditLog"
      WHERE "id" = 'notification-unlinked-delivery-guard-${rollingNotificationId}';
    `)).toBe("NOTIFICATION_UNLINKED_DELIVERY_CLAIM_BLOCKED")

    sql(`
      INSERT INTO "Message" (
        "id", "tenantId", "conversationId", "channel", "direction", "provider",
        "providerMessageId", "status", "sentAt"
      ) VALUES
        (
          '${rollingSmsPlaceholderMessageId}', '${tenantId}', '${conversationId}',
          'SMS', 'OUTBOUND', 'BULKSMS', 'sent', 'SENT',
          TIMESTAMPTZ '2026-07-18 10:30:00+00'
        ),
        (
          '${rollingWaPlaceholderMessageId}', '${tenantId}', '${waConversationId}',
          'WHATSAPP', 'OUTBOUND', 'WA_UNOFFICIAL', 'unknown', 'SENT',
          TIMESTAMPTZ '2026-07-18 10:35:00+00'
        );

      UPDATE "Conversation"
      SET "lastOutboundAt" = TIMESTAMPTZ '2026-07-18 10:40:00+00'
      WHERE "id" IN ('${conversationId}', '${waConversationId}');

      INSERT INTO "AuditLog" (
        "id", "tenantId", "userEmail", "action", "entity", "entityId",
        "newValue", "createdAt"
      ) VALUES
        (
          '${rollingSmsPlaceholderAuditId}', '${tenantId}', 'legacy-writer@example.test',
          'MESSAGE_SENT', 'Message', '${rollingSmsPlaceholderMessageId}',
          '{"status":"SENT","providerMessageId":"sent"}'::jsonb, CURRENT_TIMESTAMP
        ),
        (
          '${rollingWaPlaceholderAuditId}', '${tenantId}', 'legacy-writer@example.test',
          'MESSAGE_SENT', 'Message', '${rollingWaPlaceholderMessageId}',
          '{"status":"SENT","providerMessageId":"unknown"}'::jsonb, CURRENT_TIMESTAMP
        );
    `)

    for (const messageId of [rollingSmsPlaceholderMessageId, rollingWaPlaceholderMessageId]) {
      expect(sql(`
        SELECT concat_ws('|', "status"::text, "dispatchState"::text,
          coalesce("sentAt"::text, 'NULL'), coalesce("providerMessageId", 'NULL'),
          coalesce("dispatchProviderMessageId", 'NULL'),
          coalesce("dispatchProviderAcceptedAt"::text, 'NULL'),
          coalesce("dispatchEvidenceReference", 'NULL'), "errorClass")
        FROM "Message" WHERE "id" = '${messageId}';
      `)).toBe(
        "QUEUED|AMBIGUOUS|NULL|NULL|NULL|NULL|NULL|RETRY_LEGACY_PLACEHOLDER_MANUAL_RECONCILIATION",
      )
      expect(sql(`
        SELECT concat_ws('|', "action", "oldValue" ->> 'providerMessageId',
          "newValue" ->> 'status', "newValue" ->> 'reason')
        FROM "AuditLog"
        WHERE "id" = 'message-legacy-placeholder-guard-${messageId}';
      `)).toBe(
        "MESSAGE_DELIVERY_EVIDENCE_RECONCILIATION_REQUIRED|"
        + `${messageId === rollingSmsPlaceholderMessageId ? "sent" : "unknown"}`
        + "|QUEUED|legacy_provider_placeholder_has_no_dispatch_evidence",
      )
    }

    for (const auditId of [rollingSmsPlaceholderAuditId, rollingWaPlaceholderAuditId]) {
      expect(sql(`
        SELECT concat_ws('|', "action", "newValue" ->> 'status',
          "newValue" ->> 'compatibilityCorrection',
          coalesce("newValue" ->> 'providerMessageId', 'NULL'))
        FROM "AuditLog" WHERE "id" = '${auditId}';
      `)).toBe(
        "MESSAGE_DELIVERY_EVIDENCE_RECONCILIATION_REQUIRED|QUEUED|"
        + "legacy_provider_placeholder_writer|NULL",
      )
    }
    expect(sql(`
      SELECT to_char("lastOutboundAt", 'YYYY-MM-DD HH24:MI:SS')
      FROM "Conversation" WHERE "id" = '${conversationId}';
    `)).toBe("2026-07-18 08:55:00")
    expect(sql(`
      SELECT to_char("lastOutboundAt", 'YYYY-MM-DD HH24:MI:SS')
      FROM "Conversation" WHERE "id" = '${waConversationId}';
    `)).toBe("2026-07-18 09:20:00")

    sql(`
      INSERT INTO "Message" (
        "id", "tenantId", "conversationId", "channel", "direction", "provider",
        "providerMessageId", "status", "sentAt"
      ) VALUES (
        '${rollingGraphMessageId}', '${tenantId}', '${emailConversationId}', 'EMAIL',
        'OUTBOUND', 'MSGRAPH', 'graph-1721300400000', 'SENT',
        TIMESTAMPTZ '2026-07-18 11:00:00+00'
      );

      INSERT INTO "AuditLog" (
        "id", "tenantId", "userEmail", "action", "entity", "entityId",
        "newValue", "createdAt"
      ) VALUES (
        '${rollingGraphAuditId}', '${tenantId}', 'legacy-writer@example.test',
        'MESSAGE_SENT', 'Message', '${rollingGraphMessageId}',
        '{"status":"SENT","providerMessageId":"graph-1721300400000"}'::jsonb,
        CURRENT_TIMESTAMP
      );

      INSERT INTO "EmailLog" (
        "id", "tenantId", "toAddress", "subject", "bodyHtml", "status",
        "provider", "providerEvidenceReference", "sentAt", "updatedAt"
      ) VALUES (
        '${rollingGraphEmailLogId}', '${tenantId}', 'synthetic@example.test',
        'Rolling Graph', '<p>Rolling Graph</p>', 'SENT', 'MSGRAPH',
        'MSGRAPH_HTTP_202', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

      INSERT INTO "Message" (
        "id", "tenantId", "conversationId", "channel", "direction", "provider",
        "status", "sentAt", "dispatchState", "dispatchProviderAcceptedAt",
        "dispatchEvidenceReference"
      ) VALUES (
        '${validGraphMessageId}', '${tenantId}', '${emailConversationId}', 'EMAIL',
        'OUTBOUND', 'MSGRAPH', 'SENT', TIMESTAMPTZ '2026-07-18 11:05:00+00',
        'ACCEPTED', TIMESTAMPTZ '2026-07-18 11:05:00+00',
        'MSGRAPH_CLIENT_REQUEST_ID:11111111-1111-4111-8111-111111111111'
      );

      INSERT INTO "EmailLog" (
        "id", "tenantId", "toAddress", "subject", "bodyHtml", "status",
        "provider", "providerEvidenceReference", "sentAt", "updatedAt"
      ) VALUES (
        '${validGraphEmailLogId}', '${tenantId}', 'synthetic@example.test',
        'Valid Graph', '<p>Valid Graph</p>', 'SENT', 'MSGRAPH',
        'MSGRAPH_CLIENT_REQUEST_ID:11111111-1111-4111-8111-111111111111',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      );

      INSERT INTO "EmailLog" (
        "id", "tenantId", "toAddress", "subject", "bodyHtml", "status",
        "provider", "errorMessage", "updatedAt"
      ) VALUES (
        '${stagedAmbiguousEmailLogId}', '${tenantId}', 'synthetic@example.test',
        'Ambiguous overlap', '<p>Ambiguous overlap</p>', 'AMBIGUOUS', 'SMTP',
        'SMTP outcome unknown', CURRENT_TIMESTAMP
      );
    `)

    expect(sql(`
      SELECT concat_ws('|', "status"::text, "dispatchState"::text,
        coalesce("providerMessageId", 'NULL'), coalesce("sentAt"::text, 'NULL'))
      FROM "Message" WHERE "id" = '${rollingGraphMessageId}';
    `)).toBe("QUEUED|AMBIGUOUS|NULL|NULL")
    expect(sql(`
      SELECT concat_ws('|', "action", "newValue" ->> 'status',
        "newValue" ->> 'compatibilityCorrection')
      FROM "AuditLog" WHERE "id" = '${rollingGraphAuditId}';
    `)).toBe(
      "MESSAGE_DELIVERY_EVIDENCE_RECONCILIATION_REQUIRED|QUEUED|legacy_graph_writer",
    )
    expect(sql(`
      SELECT concat_ws('|', "status"::text, coalesce("sentAt"::text, 'NULL'))
      FROM "EmailLog" WHERE "id" = '${rollingGraphEmailLogId}';
    `)).toBe("FAILED|NULL")
    expect(sql(`
      SELECT "action" FROM "AuditLog"
      WHERE "id" = 'email-graph-evidence-guard-${rollingGraphEmailLogId}';
    `)).toBe("EMAIL_DELIVERY_EVIDENCE_RECONCILIATION_REQUIRED")
    expect(sql(`
      SELECT "status"::text FROM "Message" WHERE "id" = '${validGraphMessageId}';
    `)).toBe("SENT")
    expect(sql(`
      SELECT "status"::text FROM "EmailLog" WHERE "id" = '${validGraphEmailLogId}';
    `)).toBe("SENT")
    expect(sql(`
      SELECT concat_ws('|', "status"::text,
        "errorMessage" LIKE '%[PROVIDER_OUTCOME_AMBIGUOUS]%')
      FROM "EmailLog" WHERE "id" = '${stagedAmbiguousEmailLogId}';
    `)).toBe("FAILED|t")
    expect(sql(`
      SELECT concat_ws('|', "newValue" ->> 'status', "newValue" ->> 'providerOutcome')
      FROM "AuditLog"
      WHERE "id" = 'email-ambiguous-status-stage-${stagedAmbiguousEmailLogId}';
    `)).toBe("FAILED|AMBIGUOUS")
  })
})
