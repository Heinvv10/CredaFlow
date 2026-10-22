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

1. The collections officer opens `theft`: no position purpose (01); records a
   SAPS theft report, valid 30 days (02); shows the last known position and
   the trail, which starts 7 days before the report (03).
2. Test setup: the report's `validUntil` set to yesterday (day 31) with the
   triggers off, on the throwaway database. After a reload only a renewal is
   offered and the trail API answers 409 (04).
3. READONLY opens `theft`: no theft or position controls; the trail and theft
   report APIs answer 403 (05).
4. The credit officer opens `spike`: the accepted 51 060 h reading drives a
   R1.9 bn projected excess (06); asks for its void with a reason; their own
   approval is refused (07). The loan admin approves: the reading is struck
   through as voided and the projection falls to R726 600 (08).
5. The loan admin settles `settle` with the payment form at the settlement
   figure: the loan completes and the database opens the closure. The closure
   cron (`GET /api/cron/asset-finance-telematics-closure` with `x-cron-secret`)
   is called twice. The staff page shows the task, the portal notice, "Email sent" and
   the letter (09, 10). The director, signed in to the portal, sees the notice
   on the business contract (11). The loan admin removes the device on the
   asset: the task is done (12).
