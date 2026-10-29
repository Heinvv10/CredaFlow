-- Validates the AuditLog foreign keys 20261029100000 added NOT VALID (RESTRICT, so
-- a user or lender with audit rows cannot be deleted). VALIDATE CONSTRAINT takes
-- only a SHARE UPDATE EXCLUSIVE lock: inserts to AuditLog keep flowing.
ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "AuditLog_tenantId_fkey";
ALTER TABLE "AuditLog" VALIDATE CONSTRAINT "AuditLog_userId_fkey";
