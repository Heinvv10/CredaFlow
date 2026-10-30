-- The chainer and the verifier read AuditLog by lender and time. CONCURRENTLY, so a real book is
-- not locked against inserts while the index builds: this file must hold this one statement only
-- (Prisma runs a single statement outside a transaction block; CONCURRENTLY refuses to run inside
-- one). IF NOT EXISTS so a rerun after a cancelled build, which leaves an invalid index to drop
-- by hand, is explicit rather than silent.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");
