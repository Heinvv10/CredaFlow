/**
 * Where a staff role is sent for a page it may not open: a page inside the
 * staff app that says so (app/(dashboard)/no-access). Never "/", which on a
 * shared host renders the lender's public website. Used by lib/auth-guards.ts
 * and proxy.ts (which cannot import the guards' server-side auth).
 */
export const NO_ACCESS_PAGE = "/no-access"
