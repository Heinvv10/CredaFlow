/**
 * How long a staff self-service reset link lasts (app/api/auth/forgot-password).
 * The operator console reads it too: it leaves a link the user asked for
 * themselves alone for its first minutes (lib/operator/console/lender-admin-reset.ts).
 */
export const STAFF_RESET_LINK_MINUTES = 30
