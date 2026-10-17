# Accepted core remediation and private release evidence

Core PR168 merged through the existing merge queue at 2026-10-17T16:09:55Z as `9dfb76b90fa5b8b5a87fb1430d1af3ffedca5f4a`. Its reviewed source `63a96479d290b215049b3a3e46977dc09305c21f` is an ancestor of that main commit and their Git trees are identical. This documentation follow-up records acceptance after the frozen build; it does not claim these later documentation commits were baked into the image.

Immutable private image: `sha256:1d3ad6299b0054726ca80ac40776fce6663cc148a817029d27ad07794eb5c4fe`. The local portable package is `/home/hein/credaflow-release-candidates/gtm-20261017-63a96479d290`: source archive, Docker-save image, SHA256SUMS, build inputs, gate evidence, paired synthetic database/uploads backups and rollback instructions. Independent reviewer A checked all 1,842 checksum entries, 28 image blob digests, 5,272 source Git blobs, all 112 migration checksums, four actual database restores and every upload byte. Source archive SHA256 is `67db048a2d2c4113d7671618a323112f81066d74a835442e2ab341b12b413aef`; image archive SHA256 is `1090666810633508e2c7d7f431d42b8a003356f09ed5b872a00a4e13e1f9eee2`. Dumps, credentials, tokens and private enrollment data remain outside Git.

## Exact-source checks

- Full local quality: exit0, 1,519 files/19,675 tests passed, 338 files/2,953 tests skipped; 14 actual face-model checks and production build passed.
- Full owned PostgreSQL integration: exit0, 333 files/2,930 tests passed, two accuracy files/tests explicitly skipped, 335 selected suites, 686.65 seconds; disposable container credaflow-ci-1389968 removed with volumes. The gap map records local guards and external boundaries, not unsupported provider/AI claims.
- Required hosted quality and integration both SUCCESS on exact63a, run39046617072. Main was freshly checked before queue admission; no unrelated queue was modified.
- Pristine git-archive Docker build passed; baked source/labels independently verified. Network-none runner verified pinned weights/licenses/NOTICE/native ONNX loading. This check is distinct from actual inference tests.
- Nine PDF fingerprints and five rendered samples/23pages retain extracted text and decoded pixels against the preserved baseline. No fingerprint was repinned and no legal approval is inferred.

## Browser and recovery evidence

Independent B reviewed scoped final portal32, pricing9, financial14, accounting UI/CSV, PO staff, staff/READONLY/operator and recovery/token evidence. Accounting used a fresh owned baseline fork; its actual CSV has139rows and exact debit/credit sums407510112 cents matching the closed preview. Financial acceptance exercised all AVS flag combinations and an actual approved context, verified stored subject/application/audit bindings, and opened the accessible irreversible-disbursement warning without dispatching a payout.

Real synthetic SMTP messages drove staff/portal recovery, operator invites and PASQ/selfie token routes, including wrong/expired/replayed requests. The PASQ was generated and acknowledged through normal guards; no acknowledgement, signature, closed batch or audit history was reset. Selfie landing/token boundaries do not establish camera/KYC/provider matching. F08 intake/assessment copy is truthful; an unaffordable PO proposal remains refused. No new underwriting rule was invented.

Private ingress/configuration failures and harness races were preserved and corrected explicitly. Final canonical URLs use localhost with supported NEXTAUTH_URL and PORTAL_PUBLIC_ORIGIN; strict host allowlists/internal networking remain. Four private app pools use supported DATABASE_URL connection_limit5 after observed capacity exhaustion. Post-correction authenticated/token/accounting checks passed. Provider flags were restored; scheduler/VLM/StatementAI remain disabled. Runtime superuser fixtures are not evidence of production least-privileged RLS; real-DB enforcement suites separately exercise restricted roles.

## Deployment and legal boundary

This image bakes a synthetic Tsela tenant selector and public Turnstile TEST sitekey. It cannot be promoted unchanged to production: a named target requires a new build with approved tenant/anti-bot inputs, target-specific acceptance, explicit deployment authorization and remaining lender legal/insurance/provider/scheduler configuration. No public demo or production environment was changed, and this is not a deployment approval request.

F15 declaration changes remain a separate unmerged legal proposal. Its code/migration are absent from this accepted core image. Technical tests/rendered evidence and a private legal proposal runtime do not replace lender legal sign-off before mandated presentation changes merge. See the tracker for precise outstanding legal/provider decisions.
