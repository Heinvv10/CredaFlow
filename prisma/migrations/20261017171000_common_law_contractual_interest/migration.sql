ALTER TABLE "RepaymentSchedule" ADD COLUMN "commonLawContractualInterestDue" INTEGER;
ALTER TABLE "RepaymentSchedule" ADD CONSTRAINT "RepaymentSchedule_common_law_interest_snapshot" CHECK (
 "commonLawContractualInterestDue" IS NULL OR "commonLawContractualInterestDue" >= "interestDue");
