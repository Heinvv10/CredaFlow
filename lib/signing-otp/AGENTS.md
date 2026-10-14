<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: signing-otp
<!-- Keep under 50 lines - reference, don't duplicate -->

## Purpose
The one-time code a borrower verifies before signing. Request → deliver (the
one send pipeline) → verify → spent inside the signing transaction. Enforced
on: the credit agreement, the debit mandate, asset-finance deal documents
(`DEAL_DOCUMENT`, both e-sign paths) and `POST /api/documents/[id]/sign`.
That last route has no portal UI yet; the code step is built into the
agreement, mandate and deal-signer pages only.

## Critical Rules
- **Never SMS.** Email, or WhatsApp only when the lender runs WhatsApp Cloud.
  The `SigningOtpChallenge_channel_check` CHECK refuses anything else.
- **The code is never stored, logged or audited.** `codeHash` is an HMAC keyed
  with AUTH_SECRET and bound to the challenge id; message bodies are
  `redactStoredBody` and carry an unstored `requestRef`.
- **The request budget is serialised.** Count + PENDING insert run under a
  per-client advisory lock (5 per subject, 10 per client, per 15 min); the
  send happens after, and its outcome settles the row once.
- **A code signs exactly one thing.** Bound to client + purpose + subjectId +
  the SHA-256 of the bytes shown; each sign path re-states the binding in the
  consuming `updateMany` (`consumeSigningOtp`) inside its own transaction, and
  claims the signature with a guarded update (count must be 1).
- **A consumed challenge is signature evidence.** The `guardSigningOtpChallenge`
  trigger freezes it; its fields are also copied into the signing audit row.
- **The session decides the method, never the body.** CLIENT = portal (no
  branch exemption); staff = branch witness.
- **No NCA wording changes.** The rendered agreement/mandate do not mention the
  OTP; adding that needs the lender's legal sign-off first.

## Key Files
| File | Purpose |
|------|---------|
| `lib/signing-otp/challenge.ts` | verify / check / consume, refusal messages |
| `lib/signing-otp/request.ts` | serialised budget, mint, deliver, settle |
| `lib/signing-otp/subject.ts` | what a purpose binds to |
| `lib/signing-otp/policy.ts` | `requireSigningOtp` / branch exemption |
| `lib/signing-otp/deliver.ts` | channel availability + send |
