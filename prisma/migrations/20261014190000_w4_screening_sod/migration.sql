-- ── Hand-written enforcement (prisma migrate dev never diffs these) ──────────
-- W4 segregation-of-duties follow-up (PR #81 at 1a474cdb). Schema unchanged.
--
-- R2: the per-lender maker-checker trigger also guards INSERT, so a row cannot
-- be written already decided / approved by its own maker: a self-approved
-- RMCP version, a ScreeningCheck reviewed by whoever started it, an STR case
-- assessed by whoever raised it. The function (enforceSecondReviewer) reads
-- only NEW and is unchanged; only its triggers are replaced.
-- Behaviour: lib/screening/breaker-repros-round3.integration.test.ts and
-- lib/screening/db-enforcement-round2.integration.test.ts (RUN_SCREENING_IT).
DROP TRIGGER "ScreeningCheck_second_reviewer" ON "ScreeningCheck";
DROP TRIGGER "SuspiciousReportCase_second_reviewer" ON "SuspiciousReportCase";
DROP TRIGGER "RmcpDocument_second_reviewer" ON "RmcpDocument";

CREATE TRIGGER "ScreeningCheck_second_reviewer" BEFORE INSERT OR UPDATE ON "ScreeningCheck" FOR EACH ROW EXECUTE FUNCTION "enforceSecondReviewer"();
CREATE TRIGGER "SuspiciousReportCase_second_reviewer" BEFORE INSERT OR UPDATE ON "SuspiciousReportCase" FOR EACH ROW EXECUTE FUNCTION "enforceSecondReviewer"();
CREATE TRIGGER "RmcpDocument_second_reviewer" BEFORE INSERT OR UPDATE ON "RmcpDocument" FOR EACH ROW EXECUTE FUNCTION "enforceSecondReviewer"();
