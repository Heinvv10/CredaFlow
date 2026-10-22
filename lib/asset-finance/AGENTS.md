<!-- GENERATED — do not edit. Canonical source: ./.claude.md -->
<!-- Regenerate: npm run agents:mirror   ·   Verify: npm run agents:check -->
<!-- You are reading the AGENTS.md view of the Claude-facing docs. Prose
     below may refer to ".claude.md" when describing the canonical side;
     that is accurate — only PATH references are rewritten to AGENTS.md. -->
# Module: asset finance legal enforcement
<!-- summary: asset surrender receipt windows, withdrawal, surplus and NCA schedule splits -->

- Valuation notice issue is not receipt. `surrender-lifecycle.ts` records
  actual receipt once with delivery evidence. Pre-migration issued/listed/sold
  notices also require the historical issue date, attested with that evidence. No NCA listing, sale or proceeds
  receipt is allowed until the ten SA business days following receipt finish.
- A timely s127 withdrawal records the actual goods handover. An agreement
  still in default cannot resume possession by this withdrawal path. Linked
  recovery withdrawal and surrender withdrawal share one transaction.
- `surrender-store.ts` applies standalone proceeds and their state/audit in
  one transaction under the loan then surrender locks. Both standalone and
  recovery freezes feed `lib/loan/charges-replay.ts`.
- `nca-surplus-determination.ts` records retained evidence of whether another
  credit provider has a registered credit agreement with the same consumer
  concerning the same goods (NCA s127(6)(a)). Unknown never defaults to no;
  unrelated debts do not qualify. A yes determination routes to the Tribunal.
- `nca-surplus-account.ts` records recipient bank evidence, separate
  verification and separate release authority. `nca-surplus.ts` prepares the
  instruction before actual external bank execution. An ordinary final notice
  requires exact executed remittance; an instruction alone cannot confirm paid.
- The expressly authorised unverified-consumer-account exception issues an
  accurate statement, but the surplus remains payable and statutory termination
  has not occurred. Later release/execution retains that original statement and
  exception and provides a supplemental confirmation, for standalone/linked
  s127 and s131. Loan COMPLETED describes financial debt settlement only.
- `nca-surplus-execution.ts` records an already executed payment, never initiates
  a transfer. Require exact amount/date, explicit matching destination confirmed
  from bank proof, unique normalised reference and live borrower-owned hash-bound
  staff proof. Preparation is server-timestamped; proof is row-locked against
  deletion. Only actual remittance permits NCA surplus closure; legacy refunds
  cannot bypass it or duplicate the payment. Evidence/confirmation reads log access.
- `schedule-records.ts` excludes fees from capital: every NCA row satisfies
  capital + interest + fees = payment. Premiums remain fees in the PASQ billing
  layer; the shared consumer PASQ output must not change without approval.
- Asset wording stays DRAFT until the lender approves it. This work never
  authorises setting the legal approval flag or changing consumer PDF pins.
- Agreements, suretyships and resolutions are issued only through
  `documents/templates/issuance.ts` (`selectIssuableTemplate`, then
  `recordIssuance` in the issuing transaction): never render one for a signer
  without the selected version, and never fall back to the starter. A new
  DealSigner row needs its AssetDocumentIssuance (DB trigger).
- Re-renders that compare hashes (e-sign, contract) use `pinnedIssuance`: the
  issued version and lender identity, not the current ones.
- The legacy flag `assetFinanceLegalWordingApproved` governs only the NCA
  quotation and the system notices; it approves no template document.
- An issuance's input snapshot is personal data kept as long as its PDF; a
  purge must keep `ASSET_NCA_QUOTE_ISSUED` audit rows (DB-immutable). See
  SPEC.md §4 in docs/asset-finance/evidence/lender-owned-templates/.
- A GUIDE valuation (`lib/valuation-guides/AGENTS.md`) is a reference: never a sale's or a purchase's independent valuation; exclude it wherever INTERNAL is excluded.
- `guardRecovery` and `guardSurrenderRequest` refuse a GUIDE valuation through `20261021090200`'s DO-block patches, which the static SQL reader cannot see: a later CREATE OR REPLACE of either must keep that clause (`lib/valuation-guides/migration.test.ts` fails otherwise).
- Dealer deals (`dealerId`, `lib/dealer/AGENTS.md`): staff submit 409s them (accept only); the borrower-figure graph never imports `lib/dealer/*`; one preview solver, `deal-preview.ts`.
- The introducer's commission disclosure (`documents/wording/commission-disclosure.ts`) is an "Introducer" row (`Dealer.name` and kind, `wording/dealer-name.ts`) plus one fixed, protected paragraph that never contains the name, printed only when `data.dealer` is set (`AssetFinanceDeal.dealerId`); the NCA documents give it a section of its own. Loaders select `dealer: { name, kind }`; `pinnedIssuance` pins the introducer from the retained input, so a re-render never reads `Dealer` as it is now. No figure on any document may include a commission; lender text may not say "commission" or hide it with an invisible character (`validate.ts`). A new document that prints it needs a `dealer` shape in `templates/preview.ts` and a `SYSTEM_REVISION` bump.
- Meter readings have a third source, TELEMATICS (`lib/telematics/AGENTS.md`): written only by `recordMeterReading`'s telematics arm, bound to its device event; never insert one directly.
