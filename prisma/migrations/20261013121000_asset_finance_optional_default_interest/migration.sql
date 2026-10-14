-- A prepared NON_NCA contract may disable default interest. In that case the
-- signed margin remains NULL while the other six snapshot columns prove that
-- preparation happened. An entirely unprepared deal still has all seven NULL.
ALTER TABLE "AssetFinanceDeal" DROP CONSTRAINT "AssetFinanceDeal_signed_terms_complete";
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_signed_terms_complete" CHECK (
  (
    num_nonnulls("plannedStartDate", "signedBaseInstalmentCents", "signedResultingRate", "signedTotalInterestCents",
      "signedCollectionFeeCents", "preparedSigners") = 0
    AND "signedArrearsMarginRate" IS NULL
  )
  OR num_nonnulls("plannedStartDate", "signedBaseInstalmentCents", "signedResultingRate", "signedTotalInterestCents",
      "signedCollectionFeeCents", "preparedSigners") = 6
);
