# Onboarding a new lender (first draft)

Runbook for standing up one lender on its own stack and database, written from
what `scripts/lender/` actually does. `docs/DEPLOY.md` has the detail behind each
step and the full environment-variable list. Items marked **TODO** are not done by
any script and need a human, a credential or a sign-off.

## 0. Gather first

- Legal name, trading name, NCR number (`NCRCP…`), FSP licence number, CIPC number
  (`YYYY/NNNNNN/NN`), registered office (1-6 lines), public and collections
  contacts (+27 phones, emails). These print on NCA documents; get them from the
  lender's registration certificates, not from an email.
- Brand colours (three hex values) and logo. The tenant API refuses a colour set
  that fails WCAG AA.
- Where it runs: host, a free port, the public hostname, who terminates TLS.
- Who the first administrator is (a named person's email).

## 1. Write the tenant config

Copy `scripts/lender/lender.example.json` outside the repo and edit it. It holds
`slug`, `name`, optional `domain`, `colours`, `features` and the 17 `identity`
columns, plus `statutoryConfirm`: the NCR, FSP and CIPC numbers **typed a second
time**, as Settings > Lender identity requires. A mismatch is rejected.

The slug becomes the compose project (`credaflow-<slug>`), the build-time
`NEXT_PUBLIC_TENANT_SLUG` and the tenant key. It cannot be changed later.

Validate without a database (an invalid file exits 2 with every error):

```bash
npm run --silent lender:bootstrap-tenant -- --config /path/to/lender.json --dry-run
```

With `DATABASE_URL` unset a valid file stops at "DATABASE_URL is not set".

## 2. Provision

From a clean checkout at the commit you intend to run:

```bash
scripts/lender/provision-lender.sh /srv/lenders/<slug> \
  --config /path/to/lender.json --port <free port> \
  --public-url https://<public host> --admin-email <first admin> --build
```

What it does, in order, each step safe to rerun: creates the 0700 directory and a 0600
`.env` with generated secrets; builds the runtime and tools images; starts the
database; `prisma migrate deploy`; tenant dry-run then create (tenant, config,
audit rows, default document and message templates); sets
`DEBIT_MANDATE_CREDITOR_TENANT_ID`; creates the first SUPER_ADMIN; then
`deploy.sh` (backup, switch, health check). It refuses a dirty tree, and a lender
directory inside the checkout.

At the credentials banner copy the email, the one-time password and the TOTP
secret/URI **now**. They are shown once.

- [ ] Enrol the TOTP secret in the administrator's authenticator.
- [ ] Copy `/srv/lenders/<slug>/secrets/backup.passphrase` to a password manager or
      another host. Without it no backup restores.

## 3. Check it is alive

```bash
curl -s http://127.0.0.1:<port>/api/health     # status ok, commit = the image's
```

Sign in at `<public url>/login` as the administrator with email, password and the
6-digit TOTP code.

## 4. In the app (Settings)

- [ ] Change the one-time password (Settings > Users; the forgot-password flow also works once email is configured).
- [ ] Settings > Lender identity: confirm every value against the lender's
      registration documents.
- [ ] Upload the logo; check colours in light and dark mode.
- [ ] Create staff users and branches.
- [ ] Loan products: none are created (provisioning never creates demo data or
      pricing). Enter the lender's real products and fees.
- [ ] Review the default message and document templates for the lender's wording.

## 5. Provider credentials

Fill the commented block at the bottom of `<dir>/.env`, then redeploy with the same
image (`deploy.sh <dir> <image>`) so the container is recreated with the new values.

> **TODO(provider credentials): Stitch** client id/secret, webhook secret and the
> beneficiary bank account; register the lender's webhook URL with Stitch.
>
> **TODO(provider credentials): credit bureaus** TransUnion, Experian: keys in
> Settings (TransUnion/BulkSMS/Netcash) and `EXPERIAN_*` in `.env`. Clear every
> `*_DRY_RUN` flag; on a production build a financial dry-run throws.
>
> **TODO(provider credentials): SmileIdentity** partner id, API key,
> `SMILE_IDENTITY_ENV=production`.
>
> **TODO(provider credentials): WhatsApp** Cloud API app secret, verify token
> (generated), Meta app id, number registration.
>
> **TODO(provider credentials): email/SMTP** configure in Settings > Email (needs
> `WABA_ENC_KEY`, generated). Set `EMAIL_DELIVERY_MODE=unrestricted` only when the
> lender is live; until then mail is restricted to an allowlist on purpose.
>
> **TODO(provider credentials): debit-order creditor account**
> `DEBIT_MANDATE_CREDITOR_BANK_NAME`, `_ACCOUNT_NUMBER`, `_BRANCH_CODE`: the
> lender's real collection account, printed on every mandate.

## 6. Legal sign-off

> **TODO(legal sign-off): NCA renders.** Render the credit agreement, pre-agreement,
> Section 129 notice, debit mandate and certificate of balance for this lender and
> have **its** legal team sign them off before any real client touches the system.
> Wording comes from `lib/pdf/*.ts` and is not edited per lender; an identity
> number that is wrong prints on every document. See `lib/pdf/.claude.md` and
> `CLAUDE.md` ("NCA documents are exact").

## 7. Go-live checklist

- [ ] TLS and DNS in front of `127.0.0.1:<port>`; `TRUSTED_PROXY` set to the proxy count.
- [ ] `NEXTAUTH_URL`/`AUTH_URL` equal the public origin.
- [ ] **TODO:** an external scheduler calling `dpd-update`, `reminders`, `escalations`
      with `x-cron-secret` (not installed by these scripts).
- [ ] Nightly `backup.sh` and a weekly `restore.sh … --drop-scratch` in cron (lines in
      `docs/DEPLOY.md`), backups copied off the host.
- [ ] A restore drill done once by hand and the counts compared.
- [ ] Break-glass procedure known to a second person (`docs/DEPLOY.md`).
- [ ] No `DEMO_MODE`, no dry-run flags, no staff TOTP switched off.

## 8. Afterwards

Deploy a new version: `scripts/lender/deploy.sh <dir> <image> --build` (health-checked,
rolls back the image on failure; a migration is not reverted). Lockout:
`--break-glass`. Remove a lender: `DEPLOY.md`, "Tearing a lender down".
