# PR #289 mutations at 879097a6 (blind review)

Own clone, private Postgres. Runner: selected unit files first, then ls-letters, ls-arrears-letter, ls-walk, flow, gate integration suites; stops at the first failing stage. Not the whole test suite, so a survivor may be killed by a test not run. Kills were recorded by exit code; the failing test name was not captured. "unit" kills of DB mutants are the static migration test (offer-arrears-migration.test.ts), not behaviour.

| Mutant | Result | Stage |
|---|---|---|
| branch: witness attestation dropped | KILLED | it |
| branch: first OTP check before accept dropped | KILLED | it |
| sign: branch no longer forces OTP | KILLED | it |
| sign: agreementSignedByUserId dropped | KILLED | it |
| arrears: staffMessageRefusal dropped | KILLED | it |
| arrears: locked re-read compare dropped | SURVIVED |  |
| arrears: refused letter leaves file | KILLED | it |
| arrears: dunning category dropped | KILLED | unit |
| arrears: PDF attachment dropped | KILLED | it |
| arrears: figures use stored arrears not settlement | SURVIVED |  |
| arrears: LoanNote dropped | KILLED | it |
| arrears route: canDo dropped | KILLED | it |
| branch route: role READONLY | SURVIVED |  |
| deliver: whatsapp without number | KILLED | unit |
| issue: no notice | KILLED | it |
| decide: issue on approval dropped | KILLED | it |
| issue-on-approval rethrows | KILLED | it |
| presub: amount not matched | KILLED | unit |
| presub: term not matched | KILLED | unit |
| presub: product not matched | KILLED | unit |
| presub: 24h window dropped | SURVIVED |  |
| presub: spent statement reusable | KILLED | unit |
| presub: old template version ok | KILLED | unit |
| presub: other client ok | KILLED | unit |
| presub: INDICATIVE banner dropped | KILLED | it |
| portal apply: statement not claimed | KILLED | unit |
| quote route: role check dropped | SURVIVED |  |
| quote route: regime check dropped | SURVIVED |  |
| quote route: rate limit dropped | SURVIVED |  |
| otp route: regime test dropped (ZA staff bypass) | KILLED | unit |
| identity: any 266 number | KILLED | unit |
| collections page: S129 button on KF | KILLED | page.test.tsx (rerun separately; first harness omitted this file) |
| DB: S129 guard no-op | KILLED | it |
| DB: offer ack before signature dropped | SURVIVED |  |
| DB: offer terms hash dropped | SURVIVED |  |
| DB: offer ack by borrower dropped | SURVIVED |  |
| DB: arrears approved-version check dropped | KILLED | unit |
| DB: arrears wording hash dropped | SURVIVED |  |
| DB: arrears sample not derived | KILLED | unit |
| DB: arrears immutable dropped | KILLED | unit |
| DB: arrears file not kept | KILLED | unit |
| DB: arrears regime check dropped | KILLED | unit |

## Spot check at cbdb0640 (16 mutants; selected suites only)

Killed 11: identity email, identity whatsapp, challenge requester, witness payout bar, arrears lock compare, arrears stored figures, 24h window, website refusal, DB offer order, DB offer terms, DB wording hash.
Survived 5: branch-sign route READONLY, key-facts-quote role, regime, rate limit, DB offer by borrower.

## Spot check at 31d367d3

| Mutant | Result | Test |
|---|---|---|
| da6f65c4: drop setByStaffUserId from claim where | KILLED | identity-confirmation IT "another setter" (ZA+LS) |
| da6f65c4: drop value from claim where | KILLED | identity-confirmation IT "another value" (ZA+LS) |
| 22a34358: ignore accountControlRefusal in confirmContactIdentity | KILLED | identity-confirmation IT "second account" + account-control-wiring |
| 22a34358: witness removed from payoutPeople | KILLED | ls-letters IT |

## Spot check at 79dde0d4

| Mutant | Result | Test |
|---|---|---|
| signingIdentityRefusal: accountControlRefusal result ignored | KILLED | identity-confirmation IT "second account of the confirmer" (ZA+LS) |
| consumeSigningOtp: accountControlRefusal branch off | KILLED | same |
| consumeSigningOtp: same-id confirmer check off | KILLED | identity-confirmation IT "the confirmer does not witness" (ZA+LS) |
