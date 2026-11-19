# Handoff — dependency security upgrades (2026-10-15)

Goal file: `.claude/handoffs/2026-10-15-dependency-security-upgrades-goal.md`.
PR **#114** `chore/dependency-security-upgrades` (worktree `/home/hein/Workspace/CredaFlow-deps`),
HEAD c932a998, queued with `mq add 114`. Not yet merged when this was written. Check `mq` / `gh pr view 114`.

## Result
- `npm audit --omit=dev`: 1 critical / 21 high → **0 / 0** (2 moderate: uuid via exceljs; the only fix is a downgrade).
- `npm audit` (incl. dev): 1 / 27 / 34 → 0 / 5 / 5. The 5 highs are one dev-only chain
  (eslint-config-next → @next/eslint-plugin-next → fast-glob 3.3.1 → micromatch → braces 3.0.3,
  GHSA-vfj7-8cjw-p6xm). No patched braces release exists. Documented in the PR.
- Upgraded: next 16.4.1, nodemailer 10.1.1 (+mailparser 3.9.39, @types/nodemailer removed),
  puppeteer 25.14.0, sharp 0.35.5, tiptap 3.32.0, postcss override 8.5.30, in-range
  ip-address/js-yaml/undici/brace-expansion. engines.node is now >=22.12.0.
- Code changes: `htmlToPdf` uses setContent(load) + waitForNetworkIdle (puppeteer 25 types);
  `next.config.ts` sets `agentRules: false` (otherwise Next 16.4 `next dev` writes into AGENTS.md
  and breaks agents:check); new `lib/kyc/biometric-image.pinned.test.ts` pins canonical image bytes.

## Evidence
ci:full green (Node 22). NCA fingerprint: 9/9 identical. Biometric pins and the compareFaces dump
are identical across the sharp upgrade. The puppeteer render is pixel-identical (AE 0). Docker
build passed and /api/health returned 200. Browser checks against the container: staff TOTP sign-in,
settings save plus the cross-origin 403, tiptap template → puppeteer PDF → view (access log rows),
and portal sign-in. Blind review SHIP (round 2) and security review SHIP.

## Open items for Hein
1. **eslint-config-next left on 16.2.12.** 16.4.1 fixes nothing and its react-hooks 7.1 rule
   fails 29 components. Upgrading it is a separate UI-refactor PR.
2. **Pre-existing: PDF generation is broken in the Docker image.** `HOME=/home/nextjs` does not
   exist, so Chromium crashes ("chrome_crashpad_handler: --database is required"). It fails the
   same way on main with puppeteer 24. Fix: one Dockerfile line (create the home dir or
   `HOME=/tmp`). Matters for any deploy, including the demo stacks.
3. **Pre-existing: ADMIN cannot view or list client documents.** `STAFF_ROLES` in
   `lib/document-auth.ts` omits ADMIN, so the result is 401 `caller_not_resolvable_in_tenant`.
   This may be deliberate. Decide.
4. eslint/next-auth: next-auth's optional nodemailer peer (^7||^8) is unmet by nodemailer 10.
   This is harmless unless someone adds the Nodemailer/Email provider.
