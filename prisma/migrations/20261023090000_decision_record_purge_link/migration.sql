-- A credit decision recorded on a person (CreditDecisionRecord.clientId, no
-- foreign key: lib/learning-loop) links them, so the dealer draft purge keeps
-- them. Redefines dealerPurgeTextLinks from 20261022100000_dealer_followups
-- with that one link added; lib/dealer/purge-schema.test.ts reads the latest
-- definition. CreditDecisionRecord.sourceEntityId is polymorphic, like
-- AuditLog.entityId, and is not a link (a Client source repeats clientId).
--
-- Rollback: re-run the 20261022100000 definition of the function.

CREATE OR REPLACE FUNCTION "dealerPurgeTextLinks"(p_table TEXT)
RETURNS TABLE ("tbl" TEXT, "col" TEXT)
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT links."tbl", links."col" FROM (SELECT * FROM (VALUES
    ('Client', 'CrmActivity', 'clientId'), ('Client', 'NotificationLog', 'clientId'), ('Client', 'ConsentRecord', 'clientId'),
    ('Client', 'AssetDocumentIssuance', 'clientId'), ('Client', 'EmailConfig', 'clientId'),
    ('Client', 'AssetMeterReading', 'recordedByClientId'), ('Client', 'LeaseEndOfTerm', 'electedByClientId'),
    ('Client', 'LeaseEndOfTerm', 'extensionNoticeByClientId'), ('Client', 'LeaseTerminationQuote', 'requestedByClientId'),
    ('Client', 'LeaseTerminationQuote', 'acceptedByClientId'),
    ('Client', 'AgentTask', 'entityId'), ('Client', 'Notification', 'entityId'), ('Client', 'AutomationLog', 'entityId'),
    ('Client', 'AutomationPause', 'entityId'), ('Client', 'CreditDecisionRecord', 'clientId'),
    ('BusinessEntity', 'ScreeningCheck', 'contextEntityId'), ('BusinessEntity', 'ScreeningBlock', 'contextEntityId'),
    ('BusinessEntity', 'NcaRegimeOverride', 'approvedEntityId'), ('BusinessEntity', 'AgentTask', 'entityId'),
    ('BusinessEntity', 'Notification', 'entityId'), ('BusinessEntity', 'AutomationLog', 'entityId'),
    ('BusinessEntity', 'AutomationPause', 'entityId')
  ) AS v("owner", "tbl", "col") WHERE v."owner" = p_table) AS links ("owner", "tbl", "col")
$function$;
