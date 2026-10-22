# Slice 5 follow-ups part T browser acceptance: theft, trail, meter void, tracker closure

Seed: `lib/telematics/telematics-followups-browser-seed.test.ts`. Run it only on
a throwaway database that you own.

```bash
eval "$(bash scripts/it-db.sh up cf-it-telematics-followups-browser-$RANDOM)"
bash scripts/it-db.sh check
npx prisma migrate deploy
TELEMATICS_FOLLOWUPS_BROWSER_SEED=1 npx vitest run lib/telematics/telematics-followups-browser-seed.test.ts
```

It writes `/tmp/cf-telematics-followups-browser.json` (mode 600; override with
`TELEMATICS_FOLLOWUPS_BROWSER_SEED_OUT`): the slug, the shared password, the
staff TOTP secret, the staff (COLLECTIONS_OFFICER, READONLY, CREDIT_OFFICER,
LOAN_ADMIN), the borrower director's portal login, and three loans:

| Loan | State |
|---|---|
| `theft` | operating lease in good standing (ACTIVE), SIM-STEADY-0001 polled to today |
| `spike` | operating lease, SIM-SPIKE-0002 polled to day 10; its 50 000 h spike accepted by mistake |
| `settle` | instalment sale with SIM-STEADY-0003, to settle in the browser |

The lender's email points at a local capture SMTP server on 127.0.0.1 (port
`TELEMATICS_FOLLOWUPS_SMTP_PORT`, default 2526): nothing leaves the machine.
Any small SMTP sink that accepts everything and writes it to disk will do.

Run the app with two `*.localhost` hosts:

```bash
SLUG=<slug from the file>
DATABASE_URL=... NEXT_PUBLIC_TENANT_SLUG=$SLUG AUTH_SECRET=<local> CRON_SECRET=<local> \
  NEXTAUTH_URL=http://staff-t.localhost:3471 STAFF_APP_HOST=staff-t.localhost \
  TENANT_HOST_MAP="staff-t.localhost=$SLUG,portal-t.localhost=$SLUG" npx next dev -p 3471
```

Steps (goal §5 T):

1. The credit officer opens `spike` (good standing, no report): no position
   purpose (01). The collections officer opens `theft`, records a SAPS theft
   report dated two days back: it waits for a second person (02), and the
   position API still answers 409; the recorder's own confirmation is refused
   (409). The credit officer confirms it; the collections officer then shows
   the last known position and the trail, which starts 7 days before the
   reported date (03).
2. Test setup: the report's `validUntil` set to yesterday (day 31) with the
   triggers off, on the throwaway database. After a reload only a renewal is
   offered and the trail API answers 409 (04).
3. READONLY opens `theft`: no theft or position controls; the trail, record
   and confirm APIs answer 403 (05).
4. The credit officer opens `spike`: the accepted 51 060 h reading drives a
   R1.9 bn projected excess (06); asks for its void with a reason; their own
   approval is refused (07). The loan admin approves: the reading is struck
   through as voided and the projection falls to R726 600 (08).
5. The loan admin settles `settle` with the payment form at the settlement
   figure: the loan completes and the database opens the closure. The closure
   cron (`GET /api/cron/asset-finance-telematics-closure`, `x-cron-secret`)
   holds it while the lender has not approved its wording (09). Test setup:
   the synthetic lender's `assetFinanceLegalWordingApproved` set (throwaway
   database only; never a real or demo lender's). The cron, run twice,
   processes it once: the staff task shows the portal notice, "Email sent" and
   the letter (10, 11). The director, signed in to the portal, sees the notice
   on the business contract (12) and, on `spike`, the voided reading with its
   reason (13). The loan admin removes the device on the asset: the task is
   done (14).
