-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'PROVISIONING');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'LOAN_ADMIN', 'CREDIT_OFFICER', 'COLLECTIONS_OFFICER', 'COLLECTIONS_AGENT', 'INSURANCE_OFFICER', 'BRANCH_MANAGER', 'READONLY');

-- CreateEnum
CREATE TYPE "ClientRiskLevel" AS ENUM ('NORMAL', 'WATCH', 'HIGH_RISK', 'DELINQUENT');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "EmploymentStatus" AS ENUM ('EMPLOYED', 'SELF_EMPLOYED', 'UNEMPLOYED', 'PENSIONER', 'PART_TIME', 'STUDENT');

-- CreateEnum
CREATE TYPE "BankAccountType" AS ENUM ('CHEQUE', 'SAVINGS', 'TRANSMISSION', 'OTHER');

-- CreateEnum
CREATE TYPE "KycStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "IncomeSourceType" AS ENUM ('SALARY', 'PENSION', 'SOCIAL_GRANT', 'BUSINESS_INCOME', 'RENTAL_INCOME', 'OTHER', 'WAGES');

-- CreateEnum
CREATE TYPE "KycVerificationMethod" AS ENUM ('PHYSICAL', 'DIGITAL', 'BIOMETRIC', 'SMILE_IDENTITY');

-- CreateEnum
CREATE TYPE "AmlStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'CLEARED', 'FLAGGED');

-- CreateEnum
CREATE TYPE "LoanPurposeCategory" AS ENUM ('DEBT_CONSOLIDATION', 'MEDICAL', 'EDUCATION', 'HOME_IMPROVEMENT', 'VEHICLE', 'BUSINESS', 'HOUSEHOLD', 'FUNERAL', 'OTHER');

-- CreateEnum
CREATE TYPE "AgreementType" AS ENUM ('SMALL', 'INTERMEDIATE', 'LARGE', 'DEVELOPMENTAL');

-- CreateEnum
CREATE TYPE "DocumentTemplateKind" AS ENUM ('SYSTEM', 'CUSTOM');

-- CreateEnum
CREATE TYPE "DocumentTemplateVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DocumentSigningMethod" AS ENUM ('NONE', 'NATIVE', 'SIGNUM');

-- CreateEnum
CREATE TYPE "DocType" AS ENUM ('ID_COPY', 'PROOF_OF_ADDRESS', 'PAYSLIP', 'BANK_STATEMENT', 'SELFIE', 'PO_DOCUMENT', 'CREDIT_AGREEMENT', 'FORM_20_PRE_AGREEMENT', 'OTHER', 'PROOF_OF_PAYMENT', 'DEBIT_MANDATE', 'EXECUTED_CREDIT_AGREEMENT', 'SIGNED_AGREEMENT_PACKET');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('MICRO', 'PERSONAL', 'PO_FUNDING');

-- CreateEnum
CREATE TYPE "InterestModel" AS ENUM ('FLAT', 'REDUCING_BALANCE', 'DAILY_ACCRUAL');

-- CreateEnum
CREATE TYPE "InitiationFeeModel" AS ENUM ('FLAT_PCT', 'NCA_REG42');

-- CreateEnum
CREATE TYPE "InitiationFeePayment" AS ENUM ('DEFERRED', 'UPFRONT');

-- CreateEnum
CREATE TYPE "CreditLifeElection" AS ENUM ('ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'DECLINED', 'DISBURSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LoanRepaymentMethod" AS ENUM ('EFT', 'DEBIT_ORDER');

-- CreateEnum
CREATE TYPE "LoanChargeType" AS ENUM ('DEFAULT_INTEREST', 'SERVICE_FEE', 'DEFAULT_ADMIN');

-- CreateEnum
CREATE TYPE "LoanStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'DEFAULTED', 'WRITTEN_OFF', 'RESTRUCTURED', 'CANCELLED', 'PENDING_WRITE_OFF');

-- CreateEnum
CREATE TYPE "CollectionsStage" AS ENUM ('NONE', 'SOFT_REMINDER', 'FORMAL_REMINDER', 'SECTION_129_SENT', 'PAYMENT_ARRANGEMENT', 'ATTORNEY_REFERRED', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('PENDING', 'PARTIAL', 'PAID', 'OVERDUE', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "PaymentAllocationStatus" AS ENUM ('ALLOCATED', 'UNAPPLIED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('EFT', 'CASH', 'DEBIT_ORDER', 'CARD', 'WAIVER');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('MANUAL', 'WEBSITE', 'REFERRAL', 'WALK_IN', 'SOCIAL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL_SENT', 'CONVERTED', 'LOST');

-- CreateEnum
CREATE TYPE "LeadLostReason" AS ENUM ('TOO_EXPENSIVE', 'WENT_ELSEWHERE', 'NOT_QUALIFIED', 'NO_RESPONSE', 'PRODUCT_MISMATCH');

-- CreateEnum
CREATE TYPE "EmploymentType" AS ENUM ('SALARIED', 'SELF_EMPLOYED', 'UNEMPLOYED', 'RETIRED', 'OTHER');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('CALL', 'EMAIL', 'WHATSAPP', 'MEETING', 'NOTE', 'FOLLOW_UP', 'LOAN_OFFER', 'INSURANCE_OFFER');

-- CreateEnum
CREATE TYPE "CrossSellType" AS ENUM ('FUNERAL_COVER', 'CREDIT_LIFE', 'PERSONAL_LOAN', 'PO_FUNDING', 'TOP_UP');

-- CreateEnum
CREATE TYPE "OpportunityStatus" AS ENUM ('PENDING', 'CONTACTED', 'INTERESTED', 'DECLINED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "InsurancePolicyType" AS ENUM ('FUNERAL_COVER', 'CREDIT_LIFE', 'LIFE_INSURANCE', 'SHORT_TERM_MOTOR', 'SHORT_TERM_HOME', 'SHORT_TERM_CONTENTS', 'BUSINESS_INSURANCE');

-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('ACTIVE', 'LAPSED', 'CANCELLED', 'CLAIMED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PolicySource" AS ENUM ('STANDALONE', 'BUNDLED_CREDIT_AGREEMENT');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'PAID');

-- CreateEnum
CREATE TYPE "PremiumStatus" AS ENUM ('DUE', 'PAID', 'OVERDUE', 'WAIVED');

-- CreateEnum
CREATE TYPE "ComplaintCategory" AS ENUM ('FEES_AND_CHARGES', 'COLLECTIONS_CONDUCT', 'CREDIT_AGREEMENT', 'INSURANCE', 'DATA_PRIVACY', 'SERVICE_QUALITY', 'OTHER');

-- CreateEnum
CREATE TYPE "ComplaintStatus" AS ENUM ('OPEN', 'UNDER_INVESTIGATION', 'RESOLVED', 'ESCALATED', 'ESCALATED_OMBUD', 'CLOSED');

-- CreateEnum
CREATE TYPE "ComplaintOutcome" AS ENUM ('UPHELD', 'PARTIALLY_UPHELD', 'NOT_UPHELD', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DsarType" AS ENUM ('ACCESS', 'CORRECTION', 'DELETION', 'OBJECTION', 'PORTABILITY');

-- CreateEnum
CREATE TYPE "DsarStatus" AS ENUM ('RECEIVED', 'IN_PROGRESS', 'COMPLETED', 'OVERDUE', 'REFUSED');

-- CreateEnum
CREATE TYPE "ComplianceType" AS ENUM ('FORM_20_PRE_AGREEMENT', 'SECTION_129_NOTICE', 'NCR_QUARTERLY_RETURN', 'POPIA_CONSENT', 'FAIS_DISCLOSURE', 'AFFORDABILITY_ASSESSMENT', 'CREDIT_BUREAU_CHECK', 'COMPLAINT', 'FSCA_QUARTERLY_RETURN', 'AGREEMENT_ARTIFACT', 'KYC_EXCEPTION', 'DEBIT_MANDATE_ARTIFACT', 'DISBURSEMENT_EXCEPTION');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('PENDING', 'COMPLETED', 'OVERDUE', 'SUBMITTED', 'ACKNOWLEDGED');

-- CreateEnum
CREATE TYPE "RateTableStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "RateBasis" AS ENUM ('AGE_BANDED', 'FLAT', 'PER_MILLE');

-- CreateEnum
CREATE TYPE "InsuredLifeType" AS ENUM ('MAIN_MEMBER', 'SPOUSE', 'CHILD', 'EXTENDED_FAMILY');

-- CreateEnum
CREATE TYPE "EligibilityLifeScope" AS ENUM ('ALL_LIVES', 'MAIN_MEMBER', 'SPOUSE', 'CHILD', 'EXTENDED_FAMILY');

-- CreateEnum
CREATE TYPE "EligibilityRuleType" AS ENUM ('MIN_ENTRY_AGE', 'MAX_ENTRY_AGE', 'MIN_COVER', 'MAX_COVER', 'MAX_TOTAL_COVER', 'WAITING_PERIOD_DAYS', 'MAX_LIVES_OF_TYPE', 'COOLING_OFF_DAYS');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'QUOTED', 'ADVICE_RECORDED', 'SUBMITTED_TO_INSURER', 'ACCEPTED', 'REJECTED', 'CONVERTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InsuredLifeStatus" AS ENUM ('PENDING', 'ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "ClientDecision" AS ENUM ('ACCEPTED_RECOMMENDATION', 'CHOSE_ALTERNATIVE', 'DECLINED_ADVICE');

-- CreateEnum
CREATE TYPE "EmailProvider" AS ENUM ('MSGRAPH', 'IMAP_SMTP');

-- CreateEnum
CREATE TYPE "EmailLogStatus" AS ENUM ('QUEUED', 'SENT', 'AMBIGUOUS', 'FAILED', 'BOUNCED', 'OPENED', 'REPLIED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID', 'CLAWED_BACK');

-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('LEAD_STALE', 'DPD_THRESHOLD', 'PAYMENT_DUE', 'LOAN_PAID_ON_TIME_N', 'LOAN_PAID_IN_FULL');

-- CreateEnum
CREATE TYPE "AutomationAction" AS ENUM ('SEND_WA', 'CREATE_ACTIVITY', 'CHANGE_COLLECTIONS_STAGE', 'NOTIFY_AGENT', 'CREATE_OPPORTUNITY', 'ISSUE_SECTION_129', 'CREATE_AGENT_TASK');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('EMAIL', 'WHATSAPP', 'VOICE', 'SMS', 'CHATBOT', 'MANUAL', 'ALL_CHANNELS');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('UNKNOWN', 'LEAD', 'CLIENT', 'STAFF', 'BLOCKED', 'SPAM', 'DORMANT', 'MERGED');

-- CreateEnum
CREATE TYPE "IdentitySource" AS ENUM ('INBOUND', 'MANUAL', 'IMPORT', 'OAUTH', 'APPLICATION_FORM');

-- CreateEnum
CREATE TYPE "ConsentPurpose" AS ENUM ('SERVICE_COMMS', 'CROSS_SELL_CREDIT', 'CROSS_SELL_INSURANCE', 'MARKETING_GENERAL', 'MARKETING_GLOBAL_OBJECTION', 'DATA_SHARING_THIRD_PARTY', 'AUTOMATED_DECISIONING', 'CREDIT_BUREAU_ENQUIRY', 'AFFORDABILITY_CHECK', 'CHATBOT_TRANSCRIPT_RETAIN');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ConsentSource" AS ENUM ('APPLICATION_FORM', 'PORTAL_TOGGLE', 'WA_REPLY_KEYWORD', 'CHATBOT_OPT_IN', 'CALL_RECORDED_VERBAL', 'IMPORT', 'MANUAL', 'EMAIL_LIST_UNSUBSCRIBE');

-- CreateEnum
CREATE TYPE "LawfulBasis" AS ENUM ('EXPLICIT_OPT_IN', 'S69_SOFT_OPT_IN', 'SERVICE_COMMS_NCA', 'TRANSACTIONAL_OPERATIONAL', 'STATUTORY_OVERRIDE');

-- CreateEnum
CREATE TYPE "ConvStatus" AS ENUM ('OPEN', 'PENDING_CUSTOMER', 'PENDING_INTERNAL', 'CLOSED');

-- CreateEnum
CREATE TYPE "ConvPriority" AS ENUM ('NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL_NOTE');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('RESEND', 'SMTP', 'MSGRAPH', 'WA_UNOFFICIAL', 'WA_CLOUD', 'WA_BSP_360DIALOG', 'TWILIO_VOICE', 'TWILIO_SMS', 'BULKSMS', 'CHATBOT', 'MANUAL');

-- CreateEnum
CREATE TYPE "MsgStatus" AS ENUM ('QUEUED', 'SENT', 'SIMULATED', 'DELIVERED', 'READ', 'FAILED', 'RETRYING', 'SUPPRESSED_BY_CONSENT', 'FAILED_PERMANENT', 'EXPIRED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "MessageDispatchState" AS ENUM ('DISPATCHING', 'ACCEPTED', 'SIMULATED', 'DEFINITELY_REJECTED', 'AMBIGUOUS', 'RECONCILED_SENT', 'RECONCILED_SIMULATED', 'RECONCILED_NOT_SENT');

-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('SERVICE', 'TRANSACTIONAL', 'MARKETING');

-- CreateEnum
CREATE TYPE "TemplateProduct" AS ENUM ('GENERAL', 'CREDIT_GENERAL', 'CREDIT_ADVISORY', 'INSURANCE');

-- CreateEnum
CREATE TYPE "DeclineCategory" AS ENUM ('AFFORDABILITY', 'BUREAU_SCORE', 'ADVERSE_LISTING', 'DEBT_REVIEW', 'DOCUMENTS_INCOMPLETE', 'IDENTITY', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "BureauSubmissionKind" AS ENUM ('DAILY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "BureauSubmissionMode" AS ENUM ('TEST', 'LIVE');

-- CreateEnum
CREATE TYPE "BureauSubmissionStatus" AS ENUM ('GENERATED', 'PUSHED', 'FAILED', 'REJECTED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CREDIT_OFFICER',
    "isCommsAgent" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "tenantId" TEXT,
    "branchId" TEXT,
    "totpSecret" TEXT,
    "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastTotpCounter" INTEGER,
    "phone" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "resetToken" TEXT,
    "resetTokenExp" TIMESTAMP(3),
    "qualificationCategory" TEXT,
    "tokenVersion" INTEGER NOT NULL DEFAULT 0,
    "faisRepresentative" BOOLEAN NOT NULL DEFAULT false,
    "faisRepresentativeNumber" TEXT,
    "faisRepresentativeFrom" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "insuranceCrossSellS69OpinionReceived" BOOLEAN NOT NULL DEFAULT false,
    "softOptInClosedLoanTailEnabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "primaryColor" TEXT NOT NULL DEFAULT '#A56C24',
    "secondaryColor" TEXT NOT NULL DEFAULT '#C8893A',
    "darkColor" TEXT NOT NULL DEFAULT '#231F20',
    "logoUrl" TEXT,
    "faviconUrl" TEXT,
    "brandName" TEXT,
    "featureLms" BOOLEAN NOT NULL DEFAULT true,
    "featureCrm" BOOLEAN NOT NULL DEFAULT false,
    "featureIms" BOOLEAN NOT NULL DEFAULT false,
    "featureBureauSubmission" BOOLEAN NOT NULL DEFAULT false,
    "featureMarketing" BOOLEAN NOT NULL DEFAULT false,
    "featurePortal" BOOLEAN NOT NULL DEFAULT true,
    "featureReports" BOOLEAN NOT NULL DEFAULT true,
    "ncrNumber" TEXT,
    "fscaNumber" TEXT,
    "companyRegNumber" TEXT,
    "legalName" TEXT,
    "registeredOffice" TEXT,
    "publicEmail" TEXT,
    "publicPhone" TEXT,
    "publicWhatsapp" TEXT,
    "collectionsEmail" TEXT,
    "collectionsPhone" TEXT,
    "collectionsPhoneSecondary" TEXT,
    "brandTagline" TEXT,
    "ncrRegistrationDate" DATE,
    "fscaAuthorisationDate" DATE,
    "ncrStatus" TEXT,
    "headOfficeCity" TEXT,
    "netcashKey" TEXT,
    "bulkSmsKey" TEXT,
    "transunionKey" TEXT,
    "smileIdentityKey" TEXT,
    "informationOfficerUserId" TEXT,
    "bureauSupplierNumber" TEXT,
    "bureauTradingName" TEXT,
    "bureauReportingStartDate" DATE,
    "bureauMinScore" INTEGER NOT NULL DEFAULT 450,
    "bureauBlockAdverse" BOOLEAN NOT NULL DEFAULT false,
    "collectionsEngineEnabled" BOOLEAN NOT NULL DEFAULT false,
    "collectionProvider" TEXT,
    "avsProvider" TEXT,
    "netcashDebitOrderKey" TEXT,
    "netcashRiskReportsKey" TEXT,
    "ndiBufferPct" INTEGER NOT NULL DEFAULT 110,
    "referralCommissionBps" INTEGER NOT NULL DEFAULT 0,
    "bankSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "absaAccountNumberMasked" TEXT,
    "absaAutoApplyHighConfidence" BOOLEAN NOT NULL DEFAULT false,
    "defaultChargesEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultAdminChargeCents" INTEGER NOT NULL DEFAULT 8200,
    "defaultAdminPostageCents" INTEGER NOT NULL DEFAULT 0,
    "defaultChargesStartedAt" TIMESTAMP(3),
    "defaultChargesStoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FailedLoginAttempt" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FailedLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "lastTotpAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "idNumber" TEXT NOT NULL,
    "branchId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "gender" "Gender",
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "whatsapp" TEXT,
    "addressLine1" TEXT,
    "suburb" TEXT,
    "city" TEXT,
    "province" TEXT,
    "postalCode" TEXT,
    "employmentStatus" "EmploymentStatus",
    "employerName" TEXT,
    "monthlyIncome" INTEGER NOT NULL DEFAULT 0,
    "monthlyExpenses" INTEGER NOT NULL DEFAULT 0,
    "bankName" TEXT,
    "bankAccountNumber" TEXT,
    "bankBranchCode" TEXT,
    "accountType" "BankAccountType",
    "grossMonthlyIncome" INTEGER,
    "incomeSourceType" "IncomeSourceType",
    "employmentStartDate" TIMESTAMP(3),
    "salaryPaymentDay" INTEGER,
    "employerAddress" TEXT,
    "nextOfKinName" TEXT,
    "nextOfKinPhone" TEXT,
    "nextOfKinRelationship" TEXT,
    "popiaConsentGiven" BOOLEAN NOT NULL DEFAULT false,
    "popiaConsentAt" TIMESTAMP(3),
    "kycVerifiedAt" TIMESTAMP(3),
    "kycVerifiedById" TEXT,
    "kycVerificationMethod" "KycVerificationMethod",
    "kycManualRejectionActive" BOOLEAN NOT NULL DEFAULT false,
    "kycManualRejectionAt" TIMESTAMP(3),
    "kycManualRejectionById" TEXT,
    "kycManualRejectionReason" TEXT,
    "kycManualRejectionResolvedAt" TIMESTAMP(3),
    "kycManualRejectionResolvedById" TEXT,
    "kycManualRejectionResolutionReason" TEXT,
    "amlScreeningStatus" "AmlStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "amlScreeningAt" TIMESTAMP(3),
    "kycStatus" "KycStatus" NOT NULL DEFAULT 'PENDING',
    "blacklisted" BOOLEAN NOT NULL DEFAULT false,
    "blacklistReason" TEXT,
    "deceasedAt" TIMESTAMP(3),
    "deceasedReason" TEXT,
    "riskLevel" "ClientRiskLevel" NOT NULL DEFAULT 'NORMAL',
    "riskFlagNote" TEXT,
    "riskFlaggedAt" TIMESTAMP(3),
    "riskFlaggedById" TEXT,
    "creditScore" INTEGER,
    "portalPassword" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "referralCount" INTEGER NOT NULL DEFAULT 0,
    "referredFromId" TEXT,
    "referralCodeId" TEXT,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "docType" "DocType" NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verificationRejectedAt" TIMESTAMP(3),
    "verificationRejectedById" TEXT,
    "uploadedByType" TEXT NOT NULL DEFAULT 'staff',
    "uploadedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedByType" TEXT,
    "deletedById" TEXT,
    "fileSize" INTEGER,
    "mimeType" TEXT,
    "storagePath" TEXT,
    "contentSha256" TEXT,
    "extractionStatus" TEXT NOT NULL DEFAULT 'pending',
    "extractionGeneration" TEXT,
    "extractionStartedAt" TIMESTAMP(3),
    "extractionResult" JSONB,
    "extractionError" TEXT,
    "validationResult" JSONB,
    "validationMismatch" BOOLEAN NOT NULL DEFAULT false,
    "validationScore" INTEGER,
    "biometricMatchScore" INTEGER,
    "biometricLiveness" INTEGER,
    "biometricVerifiedAt" TIMESTAMP(3),
    "biometricResult" JSONB,
    "biometricAttemptSequence" INTEGER,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "verificationNote" TEXT,
    "templateId" TEXT,
    "generatedFromVersionId" TEXT,
    "signatureState" TEXT,
    "signatureRequestedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "signedByIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "kind" "DocumentTemplateKind" NOT NULL,
    "systemGenerator" TEXT,
    "signingMethod" "DocumentSigningMethod" NOT NULL DEFAULT 'NONE',
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "currentVersionId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "tokensUsed" JSONB NOT NULL,
    "status" "DocumentTemplateVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentAccessLog" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "accessorType" TEXT NOT NULL,
    "accessorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanProduct" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productType" "ProductType" NOT NULL,
    "minAmount" INTEGER NOT NULL,
    "maxAmount" INTEGER NOT NULL,
    "minTermDays" INTEGER NOT NULL,
    "maxTermDays" INTEGER NOT NULL,
    "interestRatePm" DOUBLE PRECISION NOT NULL,
    "interestModel" "InterestModel" NOT NULL,
    "initiationFeeModel" "InitiationFeeModel" NOT NULL DEFAULT 'FLAT_PCT',
    "initiationFeePct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "initiationFeeMax" INTEGER NOT NULL DEFAULT 0,
    "monthlyServiceFee" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanApplication" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "branchId" TEXT,
    "appliedAmount" INTEGER NOT NULL,
    "appliedTermDays" INTEGER NOT NULL,
    "purpose" TEXT,
    "status" "AppStatus" NOT NULL DEFAULT 'DRAFT',
    "assignedToId" TEXT,
    "approvedById" TEXT,
    "affordabilityResult" JSONB,
    "decisionReason" TEXT,
    "declineCategory" "DeclineCategory",
    "loanPurposeCategory" "LoanPurposeCategory",
    "productRecommendationNote" TEXT,
    "existingDebtObligations" JSONB,
    "totalExistingDebt" INTEGER,
    "netDisposableIncome" INTEGER,
    "affordabilityNDI" INTEGER,
    "recklessLendingAssessed" BOOLEAN NOT NULL DEFAULT false,
    "recklessLendingAssessedById" TEXT,
    "recklessLendingAssessedAt" TIMESTAMP(3),
    "recklessLendingNote" TEXT,
    "bureauOverrideReason" TEXT,
    "bureauOverrideById" TEXT,
    "bureauOverrideAt" TIMESTAMP(3),
    "bureauReviewGeneration" TEXT,
    "pasqAcknowledgedAt" TIMESTAMP(3),
    "pasqAcknowledgedBy" TEXT,
    "pasqAcknowledgedSha256" TEXT,
    "pasqVersion" TEXT,
    "pasqGeneratedAt" TIMESTAMP(3),
    "pasqDocumentId" TEXT,
    "pasqDocumentSha256" TEXT,
    "pasqEvidence" JSONB,
    "pasqEvidenceSha256" TEXT,
    "approvedPasqDocumentSha256" TEXT,
    "clientAffordabilityDeclaredAt" TIMESTAMP(3),
    "agreementType" "AgreementType",
    "initiationFeePayment" "InitiationFeePayment" NOT NULL DEFAULT 'DEFERRED',
    "creditLifeElection" "CreditLifeElection",
    "creditLifeProductId" TEXT,
    "creditLifeProductName" TEXT,
    "creditLifeInsurerId" TEXT,
    "creditLifeInsurerName" TEXT,
    "creditLifeMonthlyPremiumCents" INTEGER,
    "creditLifeDisclosureVersion" TEXT,
    "creditLifeDisclosureSha256" TEXT,
    "creditLifeDisclosureAcknowledgedAt" TIMESTAMP(3),
    "creditLifeDisclosureAcknowledgedBy" TEXT,
    "incomeVerificationMethod" TEXT,
    "incomeVerifiedAt" TIMESTAMP(3),
    "incomeVerifiedById" TEXT,
    "agreementGeneratedAt" TIMESTAMP(3),
    "agreementDocumentId" TEXT,
    "agreementDocumentSha256" TEXT,
    "agreementSignedAt" TIMESTAMP(3),
    "agreementSignedMethod" TEXT,
    "agreementSignedByIp" TEXT,
    "agreementSignedByUserId" TEXT,
    "agreementSignatureData" TEXT,
    "agreementCountersignedAt" TIMESTAMP(3),
    "agreementCountersignedById" TEXT,
    "agreementCountersignedByName" TEXT,
    "agreementCountersignedByEmail" TEXT,
    "agreementCountersignatureData" TEXT,
    "agreementCountersignatureSha256" TEXT,
    "agreementCountersignatureEnvelopeSha256" TEXT,
    "agreementCountersignedDocumentSha256" TEXT,
    "agreementExecutedDocumentId" TEXT,
    "agreementExecutedDocumentSha256" TEXT,
    "signedPacketDocumentId" TEXT,
    "signedPacketDocumentSha256" TEXT,
    "debitMandatePreparedAt" TIMESTAMP(3),
    "debitMandateReference" TEXT,
    "debitMandateDraftSha256" TEXT,
    "debitMandateEvidence" JSONB,
    "debitMandateEvidenceSha256" TEXT,
    "debitMandateSignedAt" TIMESTAMP(3),
    "debitMandateSignedMethod" TEXT,
    "debitMandateSignedByIp" TEXT,
    "debitMandateSignatureData" TEXT,
    "debitMandateSignatureSha256" TEXT,
    "debitMandateDocumentId" TEXT,
    "debitMandateDocumentSha256" TEXT,
    "repaymentMethod" "LoanRepaymentMethod",
    "approvedAmount" INTEGER,
    "approvedTermDays" INTEGER,
    "approvedRate" DOUBLE PRECISION,
    "approvedAt" TIMESTAMP(3),
    "disbursedAt" TIMESTAMP(3),
    "disbursementBank" TEXT,
    "disbursementAccountNo" TEXT,
    "disbursementBranchCode" TEXT,
    "disbursementAccountType" TEXT,
    "disbursementRef" TEXT,
    "disbursementExceptionId" TEXT,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoanApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasqAcknowledgementToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "documentSha256" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sentTo" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasqAcknowledgementToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SelfieCaptureToken" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sentTo" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "invalidatedAt" TIMESTAMP(3),
    "documentId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelfieCaptureToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "principal" INTEGER NOT NULL,
    "totalInterest" INTEGER NOT NULL,
    "initiationFee" INTEGER NOT NULL,
    "creditLifePremiums" INTEGER NOT NULL DEFAULT 0,
    "totalRepayable" INTEGER NOT NULL,
    "contractualTotalInterest" INTEGER,
    "contractualTotalRepayable" INTEGER,
    "outstandingPrincipal" INTEGER NOT NULL,
    "totalPaid" INTEGER NOT NULL DEFAULT 0,
    "status" "LoanStatus" NOT NULL DEFAULT 'ACTIVE',
    "startDate" TIMESTAMP(3) NOT NULL,
    "maturityDate" TIMESTAMP(3) NOT NULL,
    "nextPaymentDate" TIMESTAMP(3),
    "interestRatePm" DOUBLE PRECISION NOT NULL,
    "interestModel" "InterestModel" NOT NULL,
    "daysInArrears" INTEGER NOT NULL DEFAULT 0,
    "arrearsAmount" INTEGER NOT NULL DEFAULT 0,
    "lastPaymentDate" TIMESTAMP(3),
    "lastPaymentAmount" INTEGER,
    "agreementDocId" TEXT,
    "collectionsStage" "CollectionsStage" NOT NULL DEFAULT 'NONE',
    "collectionsStageUpdatedAt" TIMESTAMP(3),
    "collectionsNotes" TEXT,
    "writeOffReason" TEXT,
    "writeOffRequestedById" TEXT,
    "writeOffRequestedAt" TIMESTAMP(3),
    "writeOffApprovedById" TEXT,
    "writeOffAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "chargesAccrued" INTEGER NOT NULL DEFAULT 0,
    "chargesOutstanding" INTEGER NOT NULL DEFAULT 0,
    "defaultChargesExempt" BOOLEAN NOT NULL DEFAULT false,
    "defaultChargesExemptReason" TEXT,
    "defaultChargesExemptEndedAt" TIMESTAMP(3),
    "monthlyServiceFee" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanCharge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "type" "LoanChargeType" NOT NULL,
    "day" DATE NOT NULL,
    "amount" INTEGER NOT NULL,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanCharge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentArrangement" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "arrangementDate" TIMESTAMP(3) NOT NULL,
    "agreedAmount" INTEGER NOT NULL,
    "frequency" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentArrangement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttorneyFirm" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "specialisation" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttorneyFirm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttorneyReferral" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "firmId" TEXT,
    "firmName" TEXT NOT NULL,
    "contactPerson" TEXT,
    "contactPhone" TEXT,
    "contactEmail" TEXT,
    "referralDate" TIMESTAMP(3) NOT NULL,
    "matterNumber" TEXT,
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttorneyReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditBureauCheck" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "applicationId" TEXT,
    "reviewGeneration" TEXT,
    "subjectFingerprint" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'transunion',
    "score" INTEGER,
    "riskGrade" TEXT,
    "adverseInfo" JSONB,
    "hasAdverse" BOOLEAN NOT NULL DEFAULT false,
    "deceased" BOOLEAN NOT NULL DEFAULT false,
    "underDebtReview" BOOLEAN NOT NULL DEFAULT false,
    "hasJudgement" BOOLEAN NOT NULL DEFAULT false,
    "hasNotice" BOOLEAN NOT NULL DEFAULT false,
    "unscoreable" BOOLEAN NOT NULL DEFAULT false,
    "declineReasons" JSONB,
    "obligations" JSONB,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditBureauCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvsCheck" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "applicationId" TEXT,
    "subjectFingerprint" TEXT,
    "provider" TEXT NOT NULL,
    "accountHolder" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "branchCode" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "checks" JSONB NOT NULL,
    "raw" JSONB,
    "checkedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvsCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepaymentSchedule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "installmentNo" INTEGER NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "principalDue" INTEGER NOT NULL,
    "interestDue" INTEGER NOT NULL,
    "creditLifePremiumDue" INTEGER NOT NULL DEFAULT 0,
    "feesDue" INTEGER NOT NULL,
    "totalDue" INTEGER NOT NULL,
    "totalPaid" INTEGER NOT NULL DEFAULT 0,
    "status" "ScheduleStatus" NOT NULL DEFAULT 'PENDING',
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "RepaymentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'EFT',
    "reference" TEXT,
    "notes" TEXT,
    "capturedBy" TEXT,
    "allocationStatus" "PaymentAllocationStatus" NOT NULL DEFAULT 'ALLOCATED',
    "reconciliationReason" TEXT,
    "reconciledAt" TIMESTAMP(3),
    "reconciledById" TEXT,
    "reconciliationReference" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parentPaymentId" TEXT,
    "reversed" BOOLEAN NOT NULL DEFAULT false,
    "reversedAt" TIMESTAMP(3),
    "reversedById" TEXT,
    "reversalReason" TEXT,
    "idempotencyKey" VARCHAR(128),
    "defaultInterestAllocated" INTEGER NOT NULL DEFAULT 0,
    "chargeFeesAllocated" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankStatementImport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "accountRef" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "fileHash" TEXT NOT NULL,
    "rawFilePath" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL DEFAULT 0,
    "newTxnCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BankStatementImport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "importId" TEXT NOT NULL,
    "postedDate" TIMESTAMP(3) NOT NULL,
    "valueDate" TIMESTAMP(3),
    "amountCents" INTEGER NOT NULL,
    "direction" TEXT NOT NULL,
    "rawReference" TEXT,
    "counterparty" TEXT,
    "balanceCents" INTEGER,
    "bankTxnId" TEXT,
    "dedupHash" TEXT NOT NULL,
    "matchStatus" TEXT NOT NULL DEFAULT 'UNMATCHED',
    "matchConfidence" TEXT,
    "matchedLoanId" TEXT,
    "paymentId" TEXT,
    "ignoreReason" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientExpenseBreakdown" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "housing" INTEGER NOT NULL DEFAULT 0,
    "transport" INTEGER NOT NULL DEFAULT 0,
    "food" INTEGER NOT NULL DEFAULT 0,
    "education" INTEGER NOT NULL DEFAULT 0,
    "insurance" INTEGER NOT NULL DEFAULT 0,
    "clothing" INTEGER NOT NULL DEFAULT 0,
    "entertainment" INTEGER NOT NULL DEFAULT 0,
    "medical" INTEGER NOT NULL DEFAULT 0,
    "other" INTEGER NOT NULL DEFAULT 0,
    "belowMleJustification" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientExpenseBreakdown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExistingDebtObligation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "creditProvider" TEXT NOT NULL,
    "accountType" TEXT NOT NULL,
    "outstandingBalance" INTEGER NOT NULL,
    "monthlyInstalment" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExistingDebtObligation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "submissionKey" VARCHAR(36),
    "submissionFingerprint" CHAR(64),
    "submissionReference" VARCHAR(64),
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT NOT NULL,
    "source" "LeadSource" NOT NULL DEFAULT 'MANUAL',
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedToId" TEXT,
    "notes" TEXT,
    "tags" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "convertedToClientId" TEXT,
    "convertedToApplicationId" TEXT,
    "conversionRecoveryRequired" BOOLEAN NOT NULL DEFAULT false,
    "portalAccountClientId" TEXT,
    "callbackDate" TIMESTAMP(3),
    "callbackNotes" TEXT,
    "lostReason" TEXT,
    "referredBy" TEXT,
    "employmentType" TEXT,
    "declaredIncome" INTEGER,
    "requestedAmount" INTEGER,
    "leadScore" INTEGER,
    "scoreCalculatedAt" TIMESTAMP(3),
    "referralCodeId" TEXT,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmActivity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "leadId" TEXT,
    "clientId" TEXT,
    "type" "ActivityType" NOT NULL,
    "subject" TEXT NOT NULL,
    "notes" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrossSellOpportunity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "CrossSellType" NOT NULL,
    "status" "OpportunityStatus" NOT NULL DEFAULT 'PENDING',
    "assignedToId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrossSellOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsurancePolicy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyNumber" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "InsurancePolicyType" NOT NULL,
    "status" "PolicyStatus" NOT NULL DEFAULT 'ACTIVE',
    "premiumAmount" DECIMAL(12,2) NOT NULL,
    "sumAssured" DECIMAL(12,2) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "renewalDate" TIMESTAMP(3) NOT NULL,
    "linkedLoanId" TEXT,
    "insurer" TEXT,
    "insurerId" TEXT,
    "commissionRate" DECIMAL(5,4) NOT NULL DEFAULT 0.15,
    "commissionAmount" DECIMAL(12,2),
    "waitingPeriodEnds" TIMESTAMP(3),
    "advisorId" TEXT,
    "pprIssuedAt" TIMESTAMP(3),
    "pprAcknowledgedAt" TIMESTAMP(3),
    "pprAcknowledgedBy" TEXT,
    "faisDisclosureAt" TIMESTAMP(3),
    "faisDisclosurePdfUrl" TEXT,
    "policySource" "PolicySource" NOT NULL DEFAULT 'STANDALONE',
    "faisDraftTokenHash" TEXT,
    "vehicleRegNumber" TEXT,
    "vehicleValue" DECIMAL(12,2),
    "vehicleUse" TEXT,
    "propertyAddress" TEXT,
    "constructionType" TEXT,
    "propertyValue" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "productId" TEXT,

    CONSTRAINT "InsurancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuranceBeneficiary" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "idNumber" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "relationship" TEXT NOT NULL,
    "coverAmount" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InsuranceBeneficiary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuranceClaim" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'SUBMITTED',
    "claimAmount" DECIMAL(12,2) NOT NULL,
    "approvedAmount" DECIMAL(12,2),
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "notes" TEXT,
    "claimType" TEXT,
    "incidentDate" TIMESTAMP(3),
    "fnolDate" TIMESTAMP(3),
    "assessorId" TEXT,
    "insurerRef" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsuranceClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PremiumPayment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidDate" TIMESTAMP(3),
    "status" "PremiumStatus" NOT NULL DEFAULT 'DUE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PremiumPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "ComplianceType" NOT NULL,
    "referenceId" TEXT,
    "idempotencyKey" TEXT,
    "status" "ComplianceStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsentRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT false,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress" TEXT,
    "method" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsentRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Complaint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "category" "ComplaintCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
    "assignedToId" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,
    "outcome" "ComplaintOutcome",
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataSubjectRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "type" "DsarType" NOT NULL,
    "description" TEXT,
    "status" "DsarStatus" NOT NULL DEFAULT 'RECEIVED',
    "dueDate" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSubjectRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuranceProduct" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "InsurancePolicyType" NOT NULL,
    "premiumAmount" DECIMAL(12,2) NOT NULL,
    "sumAssured" DECIMAL(12,2) NOT NULL,
    "commissionRate" DECIMAL(5,4) NOT NULL DEFAULT 0.15,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "insurerId" TEXT,

    CONSTRAINT "InsuranceProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuranceRateTable" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "insurerId" TEXT,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RateTableStatus" NOT NULL DEFAULT 'DRAFT',
    "basis" "RateBasis" NOT NULL DEFAULT 'AGE_BANDED',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsuranceRateTable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuranceRateBand" (
    "id" TEXT NOT NULL,
    "rateTableId" TEXT NOT NULL,
    "lifeType" "InsuredLifeType" NOT NULL,
    "minAge" INTEGER NOT NULL,
    "maxAge" INTEGER NOT NULL,
    "sumAssured" DECIMAL(12,2) NOT NULL,
    "premiumAmount" DECIMAL(12,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsuranceRateBand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuranceEligibilityRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "lifeScope" "EligibilityLifeScope" NOT NULL DEFAULT 'ALL_LIVES',
    "ruleType" "EligibilityRuleType" NOT NULL,
    "numericValue" DECIMAL(14,2),
    "textValue" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsuranceEligibilityRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuranceQuote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "advisorId" TEXT,
    "quoteNumber" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "rateTableId" TEXT,
    "totalPremium" DECIMAL(12,2),
    "totalSumAssured" DECIMAL(12,2),
    "eligibilityResult" JSONB,
    "ratingFailures" JSONB,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "convertedPolicyId" TEXT,
    "disclosuresIssued" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsuranceQuote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuredLife" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "idNumber" TEXT,
    "dateOfBirth" TIMESTAMP(3) NOT NULL,
    "relationship" TEXT NOT NULL,
    "lifeType" "InsuredLifeType" NOT NULL,
    "sumAssured" DECIMAL(12,2) NOT NULL,
    "premiumAmount" DECIMAL(12,2),
    "waitingPeriodEnds" TIMESTAMP(3),
    "status" "InsuredLifeStatus" NOT NULL DEFAULT 'PENDING',
    "rateBandId" TEXT,
    "quoteId" TEXT,
    "policyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsuredLife_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InsuranceAdviceRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "needsAnalysis" TEXT NOT NULL,
    "productsConsidered" JSONB NOT NULL,
    "recommendation" TEXT NOT NULL,
    "clientDecision" "ClientDecision" NOT NULL,
    "reasonIfDifferent" TEXT,
    "pdfUrl" TEXT,
    "contentHash" TEXT,
    "recordedById" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsuranceAdviceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" "EmailProvider" NOT NULL DEFAULT 'IMAP_SMTP',
    "fromName" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "replyToAddress" TEXT,
    "tenantAzureId" TEXT,
    "clientId" TEXT,
    "clientSecret" TEXT,
    "smtpHost" TEXT,
    "smtpPort" INTEGER,
    "smtpUser" TEXT,
    "smtpPass" TEXT,
    "imapHost" TEXT,
    "imapPort" INTEGER,
    "imapUser" TEXT,
    "imapPass" TEXT,
    "useTls" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastImapTestedAt" TIMESTAMP(3),
    "lastImapTestOk" BOOLEAN,
    "lastPollAt" TIMESTAMP(3),
    "lastPollOk" BOOLEAN,
    "lastPollError" VARCHAR(512),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "toName" TEXT,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "bodyText" TEXT,
    "category" TEXT,
    "referenceId" TEXT,
    "status" "EmailLogStatus" NOT NULL DEFAULT 'QUEUED',
    "provider" "Provider",
    "messageId" TEXT,
    "providerEvidenceReference" VARCHAR(512),
    "sentAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoanNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "documentId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentPlan" (
    "id" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "totalArrears" INTEGER NOT NULL,
    "installments" INTEGER NOT NULL,
    "installmentAmt" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bulkSmsTokenId" TEXT,
    "bulkSmsTokenSecret" TEXT,
    "bulkSmsActive" BOOLEAN NOT NULL DEFAULT false,
    "netcashServiceKey" TEXT,
    "netcashActive" BOOLEAN NOT NULL DEFAULT false,
    "transunionKey" TEXT,
    "transunionSecret" TEXT,
    "transunionActive" BOOLEAN NOT NULL DEFAULT false,
    "smilePartnerId" TEXT,
    "smileApiKey" TEXT,
    "smileActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT,
    "clientId" TEXT,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientOtp" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "otp" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClientOtp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StitchPaymentRequest" (
    "id" TEXT NOT NULL,
    "stitchId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "redirectUrl" TEXT NOT NULL,
    "stitchUrl" TEXT NOT NULL,
    "externalReference" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StitchPaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "referenceId" TEXT,
    "request" JSONB,
    "response" JSONB,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "userId" TEXT,
    "userEmail" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "oldValue" JSONB,
    "newValue" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "managerId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Insurer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fspNumber" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "apiEndpoint" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Insurer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaProclaimedPublicHoliday" (
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SaProclaimedPublicHoliday_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "FitAndProper" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reExamType" TEXT,
    "reExamPassDate" TIMESTAMP(3),
    "licenceNumber" TEXT,
    "licenceExpiry" TIMESTAMP(3),
    "cpdHoursRequired" INTEGER NOT NULL DEFAULT 30,
    "cpdHoursCompleted" INTEGER NOT NULL DEFAULT 0,
    "cpdPeriodEnd" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FitAndProper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "key" TEXT,
    "category" "TemplateCategory",
    "purposeRequired" "ConsentPurpose",
    "product" "TemplateProduct" NOT NULL DEFAULT 'GENERAL',
    "statutoryOverride" BOOLEAN NOT NULL DEFAULT false,
    "redactStoredBody" BOOLEAN NOT NULL DEFAULT false,
    "wabaTemplateName" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "headerType" TEXT,
    "headerContent" TEXT,
    "bodyTemplate" TEXT,
    "footer" TEXT,
    "buttons" JSONB,
    "providerStatus" TEXT,
    "providerTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoiDeclaration" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "hasConflict" BOOLEAN NOT NULL DEFAULT false,
    "details" TEXT,
    "declaredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoiDeclaration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TcfOutcome" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "outcome1" BOOLEAN NOT NULL DEFAULT false,
    "outcome2" BOOLEAN NOT NULL DEFAULT false,
    "outcome3" BOOLEAN NOT NULL DEFAULT false,
    "outcome4" BOOLEAN NOT NULL DEFAULT false,
    "outcome5" BOOLEAN NOT NULL DEFAULT false,
    "outcome6" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "completedBy" TEXT,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TcfOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientConsent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "creditBureauEnquiry" BOOLEAN NOT NULL DEFAULT false,
    "insuranceUnderwriting" BOOLEAN NOT NULL DEFAULT false,
    "smsMarketing" BOOLEAN NOT NULL DEFAULT false,
    "emailMarketing" BOOLEAN NOT NULL DEFAULT false,
    "thirdPartySharing" BOOLEAN NOT NULL DEFAULT false,
    "automatedDecisionMaking" BOOLEAN NOT NULL DEFAULT false,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "capturedBy" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BreachLog" (
    "id" TEXT NOT NULL,
    "incidentDate" TIMESTAMP(3) NOT NULL,
    "discoveredDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "affectedClients" INTEGER NOT NULL DEFAULT 0,
    "dataCategories" TEXT NOT NULL,
    "containmentAction" TEXT,
    "reportedToIC" BOOLEAN NOT NULL DEFAULT false,
    "reportedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BreachLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvisorCommission" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "advisorId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "rate" DECIMAL(5,4) NOT NULL,
    "premiumBase" DECIMAL(12,2) NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
    "clawedBackAt" TIMESTAMP(3),
    "clawbackReason" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvisorCommission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "trigger" "AutomationTrigger" NOT NULL,
    "condition" JSONB NOT NULL,
    "action" "AutomationAction" NOT NULL,
    "actionConfig" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isBuiltIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationPause" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationPause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationLog" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "error" TEXT,
    "occurrenceKey" VARCHAR(128),
    "messageId" TEXT,
    "dispatchPhase" VARCHAR(32),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assigneeId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "priority" TEXT NOT NULL DEFAULT 'MEDIUM',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "completedById" TEXT,
    "createdByRuleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "firstName" TEXT,
    "lastName" TEXT,
    "primaryEmail" TEXT,
    "primaryPhone" TEXT,
    "primaryWaJid" TEXT,
    "status" "ContactStatus" NOT NULL DEFAULT 'UNKNOWN',
    "clientId" TEXT,
    "leadId" TEXT,
    "ambiguousMatchCandidates" JSONB,
    "lastInboundAtByChannel" JSONB,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstSeenChannel" "Channel" NOT NULL,
    "firstSeenContext" TEXT,
    "blockedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "spamScore" INTEGER,
    "mergedIntoId" TEXT,
    "currentConsentIds" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactIdentity" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "value" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "source" "IdentitySource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactConsent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "purpose" "ConsentPurpose" NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "source" "ConsentSource" NOT NULL,
    "evidenceRef" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "revokedReason" TEXT,
    "capturedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactMerge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "fromContactId" TEXT NOT NULL,
    "intoContactId" TEXT NOT NULL,
    "performedById" TEXT NOT NULL,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "identitiesMoved" INTEGER NOT NULL,
    "messagesMoved" INTEGER NOT NULL,

    CONSTRAINT "ContactMerge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "subject" TEXT,
    "status" "ConvStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "ConvPriority" NOT NULL DEFAULT 'NORMAL',
    "assigneeId" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "loanId" TEXT,
    "applicationId" TEXT,
    "faisAdviceCall" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "direction" "Direction" NOT NULL,
    "provider" "Provider" NOT NULL,
    "providerMessageId" TEXT,
    "fromValue" TEXT,
    "toValue" TEXT,
    "subject" TEXT,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "documentRefs" JSONB,
    "attachmentsMeta" JSONB,
    "callDurationSec" INTEGER,
    "recordingKey" TEXT,
    "transcript" TEXT,
    "disclosureDeliveredAt" TIMESTAMP(3),
    "disclosureDeliveredById" TEXT,
    "disclosureTemplateId" TEXT,
    "templateId" TEXT,
    "lawfulBasis" "LawfulBasis",
    "basisEvidence" TEXT,
    "consentId" TEXT,
    "totpAssertionId" TEXT,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "status" "MsgStatus" NOT NULL DEFAULT 'QUEUED',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "errorClass" TEXT,
    "idempotencyKey" VARCHAR(256),
    "payloadFingerprint" CHAR(64),
    "dispatchToken" VARCHAR(64),
    "dispatchState" "MessageDispatchState",
    "dispatchAttempt" INTEGER NOT NULL DEFAULT 0,
    "dispatchStartedAt" TIMESTAMP(3),
    "dispatchLeaseExpiresAt" TIMESTAMP(3),
    "dispatchCompletedAt" TIMESTAMP(3),
    "dispatchProviderMessageId" TEXT,
    "dispatchProviderAcceptedAt" TIMESTAMP(3),
    "dispatchEvidenceReference" VARCHAR(512),
    "reconciliationEvidenceReference" VARCHAR(512),
    "simulationReceiptId" VARCHAR(512),
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "editedAt" TIMESTAMP(3),
    "editedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageMention" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageMention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralAgent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "legalName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "channel" TEXT NOT NULL DEFAULT 'FIELD',
    "notes" TEXT,
    "commissionBps" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "campaign" TEXT,
    "qrPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "agentId" TEXT,
    "codeId" TEXT,
    "leadId" TEXT,
    "eventType" TEXT NOT NULL,
    "source" TEXT,
    "attributionRaw" TEXT,
    "amountCents" INTEGER,
    "commissionCents" INTEGER,
    "commissionStatus" TEXT NOT NULL DEFAULT 'NOT_ELIGIBLE',
    "qualityFlag" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSignatureFailure" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "provider" TEXT NOT NULL,
    "sourceIp" TEXT,
    "pathname" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "rawHeaders" JSONB NOT NULL,
    "rawBodySha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookSignatureFailure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommsSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    "botsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "chatAlertEmail" TEXT,
    "waProvider" TEXT NOT NULL DEFAULT 'WA_UNOFFICIAL',
    "wabaId" TEXT,
    "wabaPhoneNumberId" TEXT,
    "wabaAccessToken" TEXT,
    "wabaAppSecret" TEXT,
    "wabaBusinessId" TEXT,
    "wabaVerifyToken" TEXT,
    "businessHours" JSONB,
    "autoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoReplyText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommsSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaBridgeNumber" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "number" TEXT,
    "status" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "lastDisconnectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaBridgeNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaBridgeAlarm" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "lastAlertedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaBridgeAlarm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CannedReply" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CannedReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualProgress" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lessonSlug" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ManualProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationThrottle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channelKey" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationThrottle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteChatHandoff" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "handedOffAt" TIMESTAMP(3) NOT NULL,
    "timedOutAt" TIMESTAMP(3),
    "alertEmailSentAt" TIMESTAMP(3),
    "alertAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebsiteChatHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BureauSubmission" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "BureauSubmissionKind" NOT NULL,
    "periodDate" DATE NOT NULL,
    "mode" "BureauSubmissionMode" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "fileName" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "recordCount" INTEGER NOT NULL,
    "heldCount" INTEGER NOT NULL,
    "header" JSONB,
    "status" "BureauSubmissionStatus" NOT NULL DEFAULT 'GENERATED',
    "pushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BureauSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BureauSubmissionRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "kind" "BureauSubmissionKind" NOT NULL,
    "mode" "BureauSubmissionMode" NOT NULL,
    "loanId" TEXT NOT NULL,
    "lineNo" INTEGER,
    "dataFlag" TEXT NOT NULL,
    "statusCode" TEXT,
    "statusDate" DATE,
    "fields" JSONB NOT NULL,
    "heldReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BureauSubmissionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BureauAdverseConfirmation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "statusCode" TEXT NOT NULL,
    "noticeDate" DATE NOT NULL,
    "confirmedById" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BureauAdverseConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_resetToken_key" ON "User"("resetToken");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_id_key" ON "User"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_domain_key" ON "Tenant"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "TenantConfig_tenantId_key" ON "TenantConfig"("tenantId");

-- CreateIndex
CREATE INDEX "LoginLog_tenantId_idx" ON "LoginLog"("tenantId");

-- CreateIndex
CREATE INDEX "LoginLog_userId_idx" ON "LoginLog"("userId");

-- CreateIndex
CREATE INDEX "LoginLog_createdAt_idx" ON "LoginLog"("createdAt");

-- CreateIndex
CREATE INDEX "FailedLoginAttempt_email_idx" ON "FailedLoginAttempt"("email");

-- CreateIndex
CREATE INDEX "FailedLoginAttempt_ip_idx" ON "FailedLoginAttempt"("ip");

-- CreateIndex
CREATE INDEX "FailedLoginAttempt_createdAt_idx" ON "FailedLoginAttempt"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "Client_reference_key" ON "Client"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Client_idNumber_key" ON "Client"("idNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Client_email_key" ON "Client"("email");

-- CreateIndex
CREATE INDEX "Client_tenantId_idx" ON "Client"("tenantId");

-- CreateIndex
CREATE INDEX "Client_tenantId_referralCodeId_idx" ON "Client"("tenantId", "referralCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_tenantId_id_key" ON "Client"("tenantId", "id");

-- CreateIndex
CREATE INDEX "ClientDocument_tenantId_idx" ON "ClientDocument"("tenantId");

-- CreateIndex
CREATE INDEX "ClientDocument_biometric_attempt_order_idx" ON "ClientDocument"("tenantId", "clientId", "docType", "biometricAttemptSequence");

-- CreateIndex
CREATE INDEX "DocumentTemplate_tenantId_idx" ON "DocumentTemplate"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_tenantId_key_key" ON "DocumentTemplate"("tenantId", "key");

-- CreateIndex
CREATE INDEX "DocumentTemplateVersion_templateId_idx" ON "DocumentTemplateVersion"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplateVersion_templateId_version_key" ON "DocumentTemplateVersion"("templateId", "version");

-- CreateIndex
CREATE INDEX "LoanProduct_tenantId_idx" ON "LoanProduct"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanProduct_tenantId_code_key" ON "LoanProduct"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "LoanProduct_tenantId_id_key" ON "LoanProduct"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LoanApplication_reference_key" ON "LoanApplication"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "LoanApplication_disbursementExceptionId_key" ON "LoanApplication"("disbursementExceptionId");

-- CreateIndex
CREATE INDEX "LoanApplication_tenantId_idx" ON "LoanApplication"("tenantId");

-- CreateIndex
CREATE INDEX "LoanApplication_tenantId_status_idx" ON "LoanApplication"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LoanApplication_tenantId_id_key" ON "LoanApplication"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LoanApplication_tenantId_id_clientId_key" ON "LoanApplication"("tenantId", "id", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "LoanApplication_tenantId_disbursementExceptionId_key" ON "LoanApplication"("tenantId", "disbursementExceptionId");

-- CreateIndex
CREATE UNIQUE INDEX "PasqAcknowledgementToken_tokenHash_key" ON "PasqAcknowledgementToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasqAcknowledgementToken_tenantId_applicationId_idx" ON "PasqAcknowledgementToken"("tenantId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "SelfieCaptureToken_tokenHash_key" ON "SelfieCaptureToken"("tokenHash");

-- CreateIndex
CREATE INDEX "SelfieCaptureToken_tenantId_applicationId_idx" ON "SelfieCaptureToken"("tenantId", "applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_reference_key" ON "Loan"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Loan_applicationId_key" ON "Loan"("applicationId");

-- CreateIndex
CREATE INDEX "Loan_tenantId_idx" ON "Loan"("tenantId");

-- CreateIndex
CREATE INDEX "Loan_tenantId_status_idx" ON "Loan"("tenantId", "status");

-- CreateIndex
CREATE INDEX "LoanCharge_tenantId_idx" ON "LoanCharge"("tenantId");

-- CreateIndex
CREATE INDEX "LoanCharge_loanId_day_idx" ON "LoanCharge"("loanId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentArrangement_loanId_key" ON "PaymentArrangement"("loanId");

-- CreateIndex
CREATE INDEX "PaymentArrangement_tenantId_idx" ON "PaymentArrangement"("tenantId");

-- CreateIndex
CREATE INDEX "AttorneyFirm_tenantId_active_idx" ON "AttorneyFirm"("tenantId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AttorneyReferral_loanId_key" ON "AttorneyReferral"("loanId");

-- CreateIndex
CREATE INDEX "CreditBureauCheck_clientId_idx" ON "CreditBureauCheck"("clientId");

-- CreateIndex
CREATE INDEX "CreditBureauCheck_applicationId_idx" ON "CreditBureauCheck"("applicationId");

-- CreateIndex
CREATE INDEX "CreditBureauCheck_applicationId_reviewGeneration_idx" ON "CreditBureauCheck"("applicationId", "reviewGeneration");

-- CreateIndex
CREATE INDEX "AvsCheck_tenantId_idx" ON "AvsCheck"("tenantId");

-- CreateIndex
CREATE INDEX "AvsCheck_clientId_createdAt_idx" ON "AvsCheck"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "RepaymentSchedule_tenantId_idx" ON "RepaymentSchedule"("tenantId");

-- CreateIndex
CREATE INDEX "Payment_tenantId_idx" ON "Payment"("tenantId");

-- CreateIndex
CREATE INDEX "Payment_tenantId_allocationStatus_idx" ON "Payment"("tenantId", "allocationStatus");

-- CreateIndex
CREATE INDEX "Payment_parentPaymentId_idx" ON "Payment"("parentPaymentId");

-- CreateIndex
CREATE INDEX "Payment_loanId_receivedAt_idx" ON "Payment"("loanId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_tenantId_idempotencyKey_key" ON "Payment"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "BankStatementImport_tenantId_idx" ON "BankStatementImport"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BankStatementImport_tenantId_fileHash_key" ON "BankStatementImport"("tenantId", "fileHash");

-- CreateIndex
CREATE INDEX "BankTransaction_tenantId_matchStatus_idx" ON "BankTransaction"("tenantId", "matchStatus");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_tenantId_dedupHash_key" ON "BankTransaction"("tenantId", "dedupHash");

-- CreateIndex
CREATE UNIQUE INDEX "ClientExpenseBreakdown_clientId_key" ON "ClientExpenseBreakdown"("clientId");

-- CreateIndex
CREATE INDEX "Lead_tenantId_status_idx" ON "Lead"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Lead_tenantId_convertedToClientId_idx" ON "Lead"("tenantId", "convertedToClientId");

-- CreateIndex
CREATE INDEX "Lead_tenantId_portalAccountClientId_idx" ON "Lead"("tenantId", "portalAccountClientId");

-- CreateIndex
CREATE INDEX "Lead_tenantId_referralCodeId_idx" ON "Lead"("tenantId", "referralCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_tenantId_submissionKey_key" ON "Lead"("tenantId", "submissionKey");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_tenantId_convertedToApplicationId_key" ON "Lead"("tenantId", "convertedToApplicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_tenantId_convertedToApplicationId_convertedToClientId_key" ON "Lead"("tenantId", "convertedToApplicationId", "convertedToClientId");

-- CreateIndex
CREATE UNIQUE INDEX "InsurancePolicy_faisDraftTokenHash_key" ON "InsurancePolicy"("faisDraftTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "InsurancePolicy_tenantId_policyNumber_key" ON "InsurancePolicy"("tenantId", "policyNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceClaim_claimNumber_key" ON "InsuranceClaim"("claimNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRecord_idempotencyKey_key" ON "ComplianceRecord"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ComplianceRecord_tenantId_type_referenceId_status_completed_idx" ON "ComplianceRecord"("tenantId", "type", "referenceId", "status", "completedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRecord_tenantId_id_key" ON "ComplianceRecord"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Complaint_reference_key" ON "Complaint"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "DataSubjectRequest_reference_key" ON "DataSubjectRequest"("reference");

-- CreateIndex
CREATE INDEX "InsuranceProduct_insurerId_idx" ON "InsuranceProduct"("insurerId");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceProduct_tenantId_code_key" ON "InsuranceProduct"("tenantId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceProduct_tenantId_id_key" ON "InsuranceProduct"("tenantId", "id");

-- CreateIndex
CREATE INDEX "InsuranceRateTable_tenantId_productId_status_idx" ON "InsuranceRateTable"("tenantId", "productId", "status");

-- CreateIndex
CREATE INDEX "InsuranceRateTable_insurerId_idx" ON "InsuranceRateTable"("insurerId");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceRateTable_tenantId_productId_version_key" ON "InsuranceRateTable"("tenantId", "productId", "version");

-- CreateIndex
CREATE INDEX "InsuranceRateBand_rateTableId_lifeType_idx" ON "InsuranceRateBand"("rateTableId", "lifeType");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceRateBand_rateTableId_lifeType_minAge_maxAge_sumAss_key" ON "InsuranceRateBand"("rateTableId", "lifeType", "minAge", "maxAge", "sumAssured");

-- CreateIndex
CREATE INDEX "InsuranceEligibilityRule_tenantId_productId_active_idx" ON "InsuranceEligibilityRule"("tenantId", "productId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceEligibilityRule_tenantId_productId_lifeScope_ruleT_key" ON "InsuranceEligibilityRule"("tenantId", "productId", "lifeScope", "ruleType");

-- CreateIndex
CREATE INDEX "InsuranceQuote_tenantId_clientId_idx" ON "InsuranceQuote"("tenantId", "clientId");

-- CreateIndex
CREATE INDEX "InsuranceQuote_tenantId_status_idx" ON "InsuranceQuote"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceQuote_tenantId_quoteNumber_key" ON "InsuranceQuote"("tenantId", "quoteNumber");

-- CreateIndex
CREATE INDEX "InsuredLife_quoteId_idx" ON "InsuredLife"("quoteId");

-- CreateIndex
CREATE INDEX "InsuredLife_policyId_idx" ON "InsuredLife"("policyId");

-- CreateIndex
CREATE INDEX "InsuredLife_idNumber_idx" ON "InsuredLife"("idNumber");

-- CreateIndex
CREATE UNIQUE INDEX "InsuranceAdviceRecord_quoteId_key" ON "InsuranceAdviceRecord"("quoteId");

-- CreateIndex
CREATE INDEX "InsuranceAdviceRecord_tenantId_idx" ON "InsuranceAdviceRecord"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailConfig_tenantId_key" ON "EmailConfig"("tenantId");

-- CreateIndex
CREATE INDEX "LoanNote_tenantId_idx" ON "LoanNote"("tenantId");

-- CreateIndex
CREATE INDEX "LoanNote_documentId_idx" ON "LoanNote"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentPlan_loanId_key" ON "PaymentPlan"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConfig_tenantId_key" ON "IntegrationConfig"("tenantId");

-- CreateIndex
CREATE INDEX "NotificationLog_tenantId_messageId_idx" ON "NotificationLog"("tenantId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "StitchPaymentRequest_stitchId_key" ON "StitchPaymentRequest"("stitchId");

-- CreateIndex
CREATE UNIQUE INDEX "StitchPaymentRequest_externalReference_key" ON "StitchPaymentRequest"("externalReference");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_tenantId_code_key" ON "Branch"("tenantId", "code");

-- CreateIndex
CREATE INDEX "Insurer_tenantId_idx" ON "Insurer"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Insurer_tenantId_name_key" ON "Insurer"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Insurer_tenantId_id_key" ON "Insurer"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FitAndProper_userId_key" ON "FitAndProper"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_tenantId_event_channel_key" ON "MessageTemplate"("tenantId", "event", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "MessageTemplate_tenantId_key_key" ON "MessageTemplate"("tenantId", "key");

-- CreateIndex
CREATE INDEX "CoiDeclaration_tenantId_idx" ON "CoiDeclaration"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CoiDeclaration_userId_year_key" ON "CoiDeclaration"("userId", "year");

-- CreateIndex
CREATE INDEX "TcfOutcome_tenantId_idx" ON "TcfOutcome"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TcfOutcome_tenantId_period_key" ON "TcfOutcome"("tenantId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "ClientConsent_clientId_key" ON "ClientConsent"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvisorCommission_advisorId_policyId_period_key" ON "AdvisorCommission"("advisorId", "policyId", "period");

-- CreateIndex
CREATE INDEX "AutomationRule_tenantId_trigger_enabled_idx" ON "AutomationRule"("tenantId", "trigger", "enabled");

-- CreateIndex
CREATE INDEX "AutomationPause_tenantId_entityId_idx" ON "AutomationPause"("tenantId", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationPause_ruleId_entityId_key" ON "AutomationPause"("ruleId", "entityId");

-- CreateIndex
CREATE INDEX "AutomationLog_ruleId_idx" ON "AutomationLog"("ruleId");

-- CreateIndex
CREATE INDEX "AutomationLog_tenantId_entityId_idx" ON "AutomationLog"("tenantId", "entityId");

-- CreateIndex
CREATE INDEX "AutomationLog_occurrence_idx" ON "AutomationLog"("tenantId", "ruleId", "entityId", "occurrenceKey");

-- CreateIndex
CREATE INDEX "AutomationLog_message_idx" ON "AutomationLog"("tenantId", "messageId");

-- CreateIndex
CREATE INDEX "AutomationLog_createdAt_idx" ON "AutomationLog"("createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "Notification_tenantId_createdAt_idx" ON "Notification"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTask_assigneeId_status_idx" ON "AgentTask"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "AgentTask_tenantId_status_idx" ON "AgentTask"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_clientId_key" ON "Contact"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_leadId_key" ON "Contact"("leadId");

-- CreateIndex
CREATE INDEX "Contact_tenantId_status_idx" ON "Contact"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Contact_tenantId_primaryEmail_idx" ON "Contact"("tenantId", "primaryEmail");

-- CreateIndex
CREATE INDEX "Contact_tenantId_primaryPhone_idx" ON "Contact"("tenantId", "primaryPhone");

-- CreateIndex
CREATE INDEX "ContactIdentity_contactId_idx" ON "ContactIdentity"("contactId");

-- CreateIndex
CREATE INDEX "ContactIdentity_tenantId_channel_value_idx" ON "ContactIdentity"("tenantId", "channel", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ContactIdentity_tenantId_channel_value_key" ON "ContactIdentity"("tenantId", "channel", "value");

-- CreateIndex
CREATE INDEX "ContactConsent_tenantId_contactId_channel_purpose_effective_idx" ON "ContactConsent"("tenantId", "contactId", "channel", "purpose", "effectiveFrom");

-- CreateIndex
CREATE INDEX "ContactConsent_tenantId_channel_purpose_status_idx" ON "ContactConsent"("tenantId", "channel", "purpose", "status");

-- CreateIndex
CREATE INDEX "ContactMerge_tenantId_performedAt_idx" ON "ContactMerge"("tenantId", "performedAt");

-- CreateIndex
CREATE INDEX "ContactMerge_fromContactId_idx" ON "ContactMerge"("fromContactId");

-- CreateIndex
CREATE INDEX "ContactMerge_intoContactId_idx" ON "ContactMerge"("intoContactId");

-- CreateIndex
CREATE INDEX "Conversation_tenantId_assigneeId_status_lastInboundAt_idx" ON "Conversation"("tenantId", "assigneeId", "status", "lastInboundAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_tenantId_channel_status_lastInboundAt_idx" ON "Conversation"("tenantId", "channel", "status", "lastInboundAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_tenantId_assigneeId_status_lastActivityAt_idx" ON "Conversation"("tenantId", "assigneeId", "status", "lastActivityAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_tenantId_channel_status_lastActivityAt_idx" ON "Conversation"("tenantId", "channel", "status", "lastActivityAt" DESC);

-- CreateIndex
CREATE INDEX "Conversation_tenantId_contactId_idx" ON "Conversation"("tenantId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_dispatchToken_key" ON "Message"("dispatchToken");

-- CreateIndex
CREATE INDEX "Message_tenantId_conversationId_createdAt_idx" ON "Message"("tenantId", "conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Message_tenantId_status_idx" ON "Message"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Message_dispatch_reconciliation_idx" ON "Message"("tenantId", "dispatchState", "dispatchLeaseExpiresAt");

-- CreateIndex
CREATE INDEX "Message_retry_idx" ON "Message"("nextRetryAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_provider_providerMessageId_key" ON "Message"("provider", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_idempotencyKey_key" ON "Message"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_id_key" ON "Message"("tenantId", "id");

-- CreateIndex
CREATE INDEX "MessageMention_tenantId_userId_createdAt_idx" ON "MessageMention"("tenantId", "userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageMention_messageId_userId_key" ON "MessageMention"("messageId", "userId");

-- CreateIndex
CREATE INDEX "ReferralAgent_tenantId_status_idx" ON "ReferralAgent"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ReferralCode_tenantId_agentId_idx" ON "ReferralCode"("tenantId", "agentId");

-- CreateIndex
CREATE INDEX "ReferralCode_tenantId_status_idx" ON "ReferralCode"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_tenantId_code_key" ON "ReferralCode"("tenantId", "code");

-- CreateIndex
CREATE INDEX "ReferralEvent_tenantId_eventType_createdAt_idx" ON "ReferralEvent"("tenantId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralEvent_tenantId_agentId_createdAt_idx" ON "ReferralEvent"("tenantId", "agentId", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralEvent_tenantId_codeId_createdAt_idx" ON "ReferralEvent"("tenantId", "codeId", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralEvent_tenantId_leadId_idx" ON "ReferralEvent"("tenantId", "leadId");

-- CreateIndex
CREATE INDEX "WebhookSignatureFailure_provider_createdAt_idx" ON "WebhookSignatureFailure"("provider", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommsSettings_tenantId_key" ON "CommsSettings"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "CommsSettings_wabaPhoneNumberId_key" ON "CommsSettings"("wabaPhoneNumberId");

-- CreateIndex
CREATE UNIQUE INDEX "WaBridgeNumber_slotId_key" ON "WaBridgeNumber"("slotId");

-- CreateIndex
CREATE INDEX "CannedReply_tenantId_idx" ON "CannedReply"("tenantId");

-- CreateIndex
CREATE INDEX "ManualProgress_tenantId_userId_idx" ON "ManualProgress"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ManualProgress_userId_lessonSlug_key" ON "ManualProgress"("userId", "lessonSlug");

-- CreateIndex
CREATE INDEX "NotificationThrottle_createdAt_idx" ON "NotificationThrottle"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationThrottle_tenantId_channelKey_windowStart_key" ON "NotificationThrottle"("tenantId", "channelKey", "windowStart");

-- CreateIndex
CREATE UNIQUE INDEX "WebsiteChatHandoff_conversationId_key" ON "WebsiteChatHandoff"("conversationId");

-- CreateIndex
CREATE INDEX "WebsiteChatHandoff_tenantId_timedOutAt_handedOffAt_idx" ON "WebsiteChatHandoff"("tenantId", "timedOutAt", "handedOffAt");

-- CreateIndex
CREATE INDEX "BureauSubmission_tenantId_createdAt_idx" ON "BureauSubmission"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BureauSubmission_tenantId_kind_periodDate_mode_sequence_key" ON "BureauSubmission"("tenantId", "kind", "periodDate", "mode", "sequence");

-- CreateIndex
CREATE INDEX "BureauSubmissionRecord_submissionId_idx" ON "BureauSubmissionRecord"("submissionId");

-- CreateIndex
CREATE INDEX "BureauSubmissionRecord_tenantId_loanId_idx" ON "BureauSubmissionRecord"("tenantId", "loanId");

-- CreateIndex
CREATE INDEX "BureauAdverseConfirmation_tenantId_idx" ON "BureauAdverseConfirmation"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "BureauAdverseConfirmation_loanId_statusCode_key" ON "BureauAdverseConfirmation"("loanId", "statusCode");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantConfig" ADD CONSTRAINT "TenantConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginLog" ADD CONSTRAINT "LoginLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoginLog" ADD CONSTRAINT "LoginLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplateVersion" ADD CONSTRAINT "DocumentTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DocumentTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanProduct" ADD CONSTRAINT "LoanProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_bureauOverrideById_fkey" FOREIGN KEY ("bureauOverrideById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_productId_fkey" FOREIGN KEY ("tenantId", "productId") REFERENCES "LoanProduct"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_creditLifeProductId_fkey" FOREIGN KEY ("tenantId", "creditLifeProductId") REFERENCES "InsuranceProduct"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_creditLifeInsurerId_fkey" FOREIGN KEY ("tenantId", "creditLifeInsurerId") REFERENCES "Insurer"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_approvedById_fkey" FOREIGN KEY ("tenantId", "approvedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_agreementCountersignedById_fkey" FOREIGN KEY ("tenantId", "agreementCountersignedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_agreementSignedByUserId_fkey" FOREIGN KEY ("tenantId", "agreementSignedByUserId") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_tenantId_disbursementExceptionId_fkey" FOREIGN KEY ("tenantId", "disbursementExceptionId") REFERENCES "ComplianceRecord"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PasqAcknowledgementToken" ADD CONSTRAINT "PasqAcknowledgementToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasqAcknowledgementToken" ADD CONSTRAINT "PasqAcknowledgementToken_tenantId_applicationId_clientId_fkey" FOREIGN KEY ("tenantId", "applicationId", "clientId") REFERENCES "LoanApplication"("tenantId", "id", "clientId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PasqAcknowledgementToken" ADD CONSTRAINT "PasqAcknowledgementToken_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SelfieCaptureToken" ADD CONSTRAINT "SelfieCaptureToken_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SelfieCaptureToken" ADD CONSTRAINT "SelfieCaptureToken_tenantId_applicationId_clientId_fkey" FOREIGN KEY ("tenantId", "applicationId", "clientId") REFERENCES "LoanApplication"("tenantId", "id", "clientId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SelfieCaptureToken" ADD CONSTRAINT "SelfieCaptureToken_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_productId_fkey" FOREIGN KEY ("productId") REFERENCES "LoanProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanCharge" ADD CONSTRAINT "LoanCharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanCharge" ADD CONSTRAINT "LoanCharge_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentArrangement" ADD CONSTRAINT "PaymentArrangement_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentArrangement" ADD CONSTRAINT "PaymentArrangement_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttorneyFirm" ADD CONSTRAINT "AttorneyFirm_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttorneyReferral" ADD CONSTRAINT "AttorneyReferral_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttorneyReferral" ADD CONSTRAINT "AttorneyReferral_firmId_fkey" FOREIGN KEY ("firmId") REFERENCES "AttorneyFirm"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditBureauCheck" ADD CONSTRAINT "CreditBureauCheck_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditBureauCheck" ADD CONSTRAINT "CreditBureauCheck_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvsCheck" ADD CONSTRAINT "AvsCheck_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvsCheck" ADD CONSTRAINT "AvsCheck_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepaymentSchedule" ADD CONSTRAINT "RepaymentSchedule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepaymentSchedule" ADD CONSTRAINT "RepaymentSchedule_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_parentPaymentId_fkey" FOREIGN KEY ("parentPaymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankStatementImport" ADD CONSTRAINT "BankStatementImport_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_importId_fkey" FOREIGN KEY ("importId") REFERENCES "BankStatementImport"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientExpenseBreakdown" ADD CONSTRAINT "ClientExpenseBreakdown_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExistingDebtObligation" ADD CONSTRAINT "ExistingDebtObligation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_convertedToClientId_fkey" FOREIGN KEY ("tenantId", "convertedToClientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_convertedToApplicationId_convertedToClientId_fkey" FOREIGN KEY ("tenantId", "convertedToApplicationId", "convertedToClientId") REFERENCES "LoanApplication"("tenantId", "id", "clientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_tenantId_portalAccountClientId_fkey" FOREIGN KEY ("tenantId", "portalAccountClientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "ReferralCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossSellOpportunity" ADD CONSTRAINT "CrossSellOpportunity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrossSellOpportunity" ADD CONSTRAINT "CrossSellOpportunity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_advisorId_fkey" FOREIGN KEY ("advisorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_insurerId_fkey" FOREIGN KEY ("insurerId") REFERENCES "Insurer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_productId_fkey" FOREIGN KEY ("productId") REFERENCES "InsuranceProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceBeneficiary" ADD CONSTRAINT "InsuranceBeneficiary_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "InsurancePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "InsurancePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceClaim" ADD CONSTRAINT "InsuranceClaim_assessorId_fkey" FOREIGN KEY ("assessorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PremiumPayment" ADD CONSTRAINT "PremiumPayment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PremiumPayment" ADD CONSTRAINT "PremiumPayment_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "InsurancePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSubjectRequest" ADD CONSTRAINT "DataSubjectRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataSubjectRequest" ADD CONSTRAINT "DataSubjectRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceProduct" ADD CONSTRAINT "InsuranceProduct_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceProduct" ADD CONSTRAINT "InsuranceProduct_insurerId_fkey" FOREIGN KEY ("insurerId") REFERENCES "Insurer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceRateTable" ADD CONSTRAINT "InsuranceRateTable_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceRateTable" ADD CONSTRAINT "InsuranceRateTable_productId_fkey" FOREIGN KEY ("productId") REFERENCES "InsuranceProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceRateTable" ADD CONSTRAINT "InsuranceRateTable_insurerId_fkey" FOREIGN KEY ("insurerId") REFERENCES "Insurer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceRateBand" ADD CONSTRAINT "InsuranceRateBand_rateTableId_fkey" FOREIGN KEY ("rateTableId") REFERENCES "InsuranceRateTable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceEligibilityRule" ADD CONSTRAINT "InsuranceEligibilityRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceEligibilityRule" ADD CONSTRAINT "InsuranceEligibilityRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "InsuranceProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceQuote" ADD CONSTRAINT "InsuranceQuote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceQuote" ADD CONSTRAINT "InsuranceQuote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceQuote" ADD CONSTRAINT "InsuranceQuote_productId_fkey" FOREIGN KEY ("productId") REFERENCES "InsuranceProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceQuote" ADD CONSTRAINT "InsuranceQuote_advisorId_fkey" FOREIGN KEY ("advisorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceQuote" ADD CONSTRAINT "InsuranceQuote_rateTableId_fkey" FOREIGN KEY ("rateTableId") REFERENCES "InsuranceRateTable"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceQuote" ADD CONSTRAINT "InsuranceQuote_convertedPolicyId_fkey" FOREIGN KEY ("convertedPolicyId") REFERENCES "InsurancePolicy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuredLife" ADD CONSTRAINT "InsuredLife_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuredLife" ADD CONSTRAINT "InsuredLife_rateBandId_fkey" FOREIGN KEY ("rateBandId") REFERENCES "InsuranceRateBand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuredLife" ADD CONSTRAINT "InsuredLife_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "InsuranceQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuredLife" ADD CONSTRAINT "InsuredLife_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "InsurancePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceAdviceRecord" ADD CONSTRAINT "InsuranceAdviceRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceAdviceRecord" ADD CONSTRAINT "InsuranceAdviceRecord_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "InsuranceQuote"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsuranceAdviceRecord" ADD CONSTRAINT "InsuranceAdviceRecord_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailConfig" ADD CONSTRAINT "EmailConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLog" ADD CONSTRAINT "EmailLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanNote" ADD CONSTRAINT "LoanNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanNote" ADD CONSTRAINT "LoanNote_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ClientDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoanNote" ADD CONSTRAINT "LoanNote_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentPlan" ADD CONSTRAINT "PaymentPlan_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationConfig" ADD CONSTRAINT "IntegrationConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationLog" ADD CONSTRAINT "NotificationLog_tenantId_messageId_fkey" FOREIGN KEY ("tenantId", "messageId") REFERENCES "Message"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StitchPaymentRequest" ADD CONSTRAINT "StitchPaymentRequest_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StitchPaymentRequest" ADD CONSTRAINT "StitchPaymentRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationLog" ADD CONSTRAINT "IntegrationLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Insurer" ADD CONSTRAINT "Insurer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FitAndProper" ADD CONSTRAINT "FitAndProper_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoiDeclaration" ADD CONSTRAINT "CoiDeclaration_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoiDeclaration" ADD CONSTRAINT "CoiDeclaration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TcfOutcome" ADD CONSTRAINT "TcfOutcome_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientConsent" ADD CONSTRAINT "ClientConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvisorCommission" ADD CONSTRAINT "AdvisorCommission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvisorCommission" ADD CONSTRAINT "AdvisorCommission_advisorId_fkey" FOREIGN KEY ("advisorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvisorCommission" ADD CONSTRAINT "AdvisorCommission_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "InsurancePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationPause" ADD CONSTRAINT "AutomationPause_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationPause" ADD CONSTRAINT "AutomationPause_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationLog" ADD CONSTRAINT "AutomationLog_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationLog" ADD CONSTRAINT "AutomationLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactIdentity" ADD CONSTRAINT "ContactIdentity_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactIdentity" ADD CONSTRAINT "ContactIdentity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactConsent" ADD CONSTRAINT "ContactConsent_capturedByUserId_fkey" FOREIGN KEY ("capturedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactMerge" ADD CONSTRAINT "ContactMerge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactMerge" ADD CONSTRAINT "ContactMerge_fromContactId_fkey" FOREIGN KEY ("fromContactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactMerge" ADD CONSTRAINT "ContactMerge_intoContactId_fkey" FOREIGN KEY ("intoContactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactMerge" ADD CONSTRAINT "ContactMerge_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "LoanApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_disclosureDeliveredById_fkey" FOREIGN KEY ("disclosureDeliveredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_disclosureTemplateId_fkey" FOREIGN KEY ("disclosureTemplateId") REFERENCES "MessageTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "ContactConsent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_tenantId_messageId_fkey" FOREIGN KEY ("tenantId", "messageId") REFERENCES "Message"("tenantId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageMention" ADD CONSTRAINT "MessageMention_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralAgent" ADD CONSTRAINT "ReferralAgent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ReferralAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "ReferralAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "ReferralCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookSignatureFailure" ADD CONSTRAINT "WebhookSignatureFailure_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommsSettings" ADD CONSTRAINT "CommsSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CannedReply" ADD CONSTRAINT "CannedReply_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualProgress" ADD CONSTRAINT "ManualProgress_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteChatHandoff" ADD CONSTRAINT "WebsiteChatHandoff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteChatHandoff" ADD CONSTRAINT "WebsiteChatHandoff_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BureauSubmission" ADD CONSTRAINT "BureauSubmission_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BureauSubmissionRecord" ADD CONSTRAINT "BureauSubmissionRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BureauSubmissionRecord" ADD CONSTRAINT "BureauSubmissionRecord_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "BureauSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BureauSubmissionRecord" ADD CONSTRAINT "BureauSubmissionRecord_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BureauAdverseConfirmation" ADD CONSTRAINT "BureauAdverseConfirmation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BureauAdverseConfirmation" ADD CONSTRAINT "BureauAdverseConfirmation_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ════════════════════════════════════════════════════════════════════════
-- Hand-written database objects Prisma's schema cannot express: functions,
-- triggers, CHECK / exclusion-style constraints, partial and expression
-- unique indexes, column defaults, and statutory reference data. Each one is
-- carried 1:1 from the final state of the squashed history (see
-- docs/ARCHITECTURE.md); only names changed. Prisma does not diff these, so `prisma migrate dev` never
-- regenerates them: a later migration that changes one must do it by hand.
-- ════════════════════════════════════════════════════════════════════════

-- SQL-language bodies reference functions defined later in this file.
SET check_function_bodies = false;

-- ── Functions ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public."assertBundledCreditLifeAgreement"(policy_tenant_id text, policy_client_id text, policy_loan_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT "resolveCreditLifeElectionForLoan"(
    policy_tenant_id,
    policy_client_id,
    policy_loan_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bundled credit-life policy is not authorised by the exact completed agreement artifact';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public."assertBundledCreditLifeDependencies"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  dependent_loan_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'Loan' THEN
    PERFORM "assertBundledCreditLifePoliciesForLoan"(OLD."id");
    IF TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id" THEN
      PERFORM "assertBundledCreditLifePoliciesForLoan"(NEW."id");
    END IF;
  ELSIF TG_TABLE_NAME = 'LoanApplication' THEN
    IF TG_OP = 'UPDATE' THEN
      FOR dependent_loan_id IN
        SELECT loan."id"
        FROM "Loan" AS loan
        WHERE loan."applicationId" IN (OLD."id", NEW."id")
        ORDER BY loan."id"
      LOOP
        PERFORM "assertBundledCreditLifePoliciesForLoan"(dependent_loan_id);
      END LOOP;
    ELSE
      FOR dependent_loan_id IN
        SELECT loan."id"
        FROM "Loan" AS loan
        WHERE loan."applicationId" = OLD."id"
        ORDER BY loan."id"
      LOOP
        PERFORM "assertBundledCreditLifePoliciesForLoan"(dependent_loan_id);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'ClientDocument' THEN
    IF TG_OP = 'UPDATE' THEN
      FOR dependent_loan_id IN
        SELECT DISTINCT loan."id"
        FROM "Loan" AS loan
        JOIN "LoanApplication" AS application
          ON application."id" = loan."applicationId"
        WHERE application."agreementDocumentId" IN (OLD."id", NEW."id")
           OR loan."agreementDocId" IN (OLD."id", NEW."id")
        ORDER BY loan."id"
      LOOP
        PERFORM "assertBundledCreditLifePoliciesForLoan"(dependent_loan_id);
      END LOOP;
    ELSE
      FOR dependent_loan_id IN
        SELECT DISTINCT loan."id"
        FROM "Loan" AS loan
        JOIN "LoanApplication" AS application
          ON application."id" = loan."applicationId"
        WHERE application."agreementDocumentId" = OLD."id"
           OR loan."agreementDocId" = OLD."id"
        ORDER BY loan."id"
      LOOP
        PERFORM "assertBundledCreditLifePoliciesForLoan"(dependent_loan_id);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'ComplianceRecord' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType" THEN
        FOR dependent_loan_id IN
          SELECT loan."id"
          FROM "Loan" AS loan
          WHERE loan."tenantId" = NEW."tenantId"
            AND loan."applicationId" = NEW."referenceId"
          ORDER BY loan."id"
        LOOP
          PERFORM "assertBundledCreditLifePoliciesForLoan"(dependent_loan_id);
        END LOOP;
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      FOR dependent_loan_id IN
        SELECT loan."id"
        FROM "Loan" AS loan
        WHERE (
          OLD."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType"
          AND loan."tenantId" = OLD."tenantId"
          AND loan."applicationId" = OLD."referenceId"
        ) OR (
          NEW."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType"
          AND loan."tenantId" = NEW."tenantId"
          AND loan."applicationId" = NEW."referenceId"
        )
        ORDER BY loan."id"
      LOOP
        PERFORM "assertBundledCreditLifePoliciesForLoan"(dependent_loan_id);
      END LOOP;
    ELSIF OLD."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType" THEN
      FOR dependent_loan_id IN
        SELECT loan."id"
        FROM "Loan" AS loan
        WHERE loan."tenantId" = OLD."tenantId"
          AND loan."applicationId" = OLD."referenceId"
        ORDER BY loan."id"
      LOOP
        PERFORM "assertBundledCreditLifePoliciesForLoan"(dependent_loan_id);
      END LOOP;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."assertBundledCreditLifePoliciesForLoan"(loan_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  policy_row RECORD;
BEGIN
  FOR policy_row IN
    SELECT
      policy."tenantId",
      policy."clientId",
      policy."linkedLoanId",
      policy."productId",
      policy."premiumAmount",
      policy."sumAssured",
      policy."startDate",
      policy."renewalDate"
    FROM "InsurancePolicy" AS policy
    WHERE policy."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
      AND policy."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource"
      AND policy."linkedLoanId" = loan_id
    ORDER BY policy."id"
  LOOP
    PERFORM "assertBundledCreditLifePolicyTerms"(
      policy_row."tenantId",
      policy_row."clientId",
      policy_row."linkedLoanId",
      policy_row."productId",
      policy_row."premiumAmount",
      policy_row."sumAssured",
      policy_row."startDate",
      policy_row."renewalDate",
      false
    );
    PERFORM "assertBundledCreditLifeAgreement"(
      policy_row."tenantId",
      policy_row."clientId",
      policy_row."linkedLoanId"
    );
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public."assertBundledCreditLifePolicyTerms"(policy_tenant_id text, policy_client_id text, policy_loan_id text, policy_product_id text, policy_premium_amount numeric, policy_sum_assured numeric, policy_start_date timestamp without time zone, policy_renewal_date timestamp without time zone, require_current_sale_config boolean)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  product_type "InsurancePolicyType";
  product_active BOOLEAN;
  product_premium_amount NUMERIC;
  product_sum_assured NUMERIC;
  loan_principal INTEGER;
  loan_start_date TIMESTAMP(3);
  loan_maturity_date TIMESTAMP(3);
  expected_sum_assured NUMERIC;
  expected_premium_amount NUMERIC;
BEGIN
  IF policy_product_id IS NULL OR policy_loan_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bundled credit-life policy requires an active tenant-bound credit-life product and loan';
  END IF;

  -- This exact row lock is the product/policy serialization boundary. It is
  -- acquired before the loan advisory lock below and conflicts with every
  -- product UPDATE/DELETE. A product mutation that starts first either becomes
  -- visible to this check or causes SERIALIZABLE to abort; one that starts
  -- second waits until the policy transaction has committed.
  SELECT
    product."type",
    product."active",
    product."premiumAmount",
    product."sumAssured"
  INTO
    product_type,
    product_active,
    product_premium_amount,
    product_sum_assured
  FROM "InsuranceProduct" AS product
  WHERE product."id" = policy_product_id
    AND product."tenantId" = policy_tenant_id
  FOR SHARE;

  IF NOT FOUND
     OR product_type IS DISTINCT FROM 'CREDIT_LIFE'::"InsurancePolicyType" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bundled credit-life policy requires a tenant-bound credit-life product';
  END IF;

  -- Active/default product configuration controls a new sale only. Once a
  -- policy is bound, its frozen policy and loan terms remain the historical
  -- source of truth even if the product is later retired or re-priced.
  IF require_current_sale_config
     AND (
       product_active IS DISTINCT FROM true
       OR product_premium_amount IS NULL
       OR product_premium_amount <= 0
       OR product_sum_assured IS NULL
       OR product_sum_assured <= 0
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bundled credit-life policy requires an active tenant-bound credit-life product with positive configured terms';
  END IF;

  PERFORM "lockBundledCreditLifeLoan"(policy_loan_id);

  SELECT
    loan."principal",
    loan."startDate",
    loan."maturityDate"
  INTO
    loan_principal,
    loan_start_date,
    loan_maturity_date
  FROM "Loan" AS loan
  WHERE loan."id" = policy_loan_id
    AND loan."tenantId" = policy_tenant_id
    AND loan."clientId" = policy_client_id
  FOR KEY SHARE;

  IF NOT FOUND OR loan_principal IS NULL OR loan_principal <= 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bundled credit-life policy requires a positive tenant-bound loan principal';
  END IF;

  expected_sum_assured := loan_principal::NUMERIC / 100;
  -- Keep the database boundary aligned with REG_3_1_MAX_PER_RAND in the
  -- disbursement writer: R4.50 per R1,000, rounded to policy currency cents.
  expected_premium_amount := ROUND(expected_sum_assured * 0.0045, 2);

  IF policy_premium_amount IS NULL
     OR policy_premium_amount <= 0
     OR policy_sum_assured IS NULL
     OR policy_sum_assured <= 0
     OR policy_start_date IS NULL
     OR policy_renewal_date IS NULL
     OR policy_renewal_date <= policy_start_date THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bundled credit-life policy requires positive monetary terms and an end date after its start date';
  END IF;

  IF policy_sum_assured IS DISTINCT FROM expected_sum_assured
     OR policy_premium_amount IS DISTINCT FROM expected_premium_amount
     OR policy_start_date IS DISTINCT FROM loan_start_date
     OR policy_renewal_date IS DISTINCT FROM loan_maturity_date THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bundled credit-life policy terms must match the frozen loan principal, premium, start date, and maturity date';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public."assertDisbursedCreditLifeCommitInvariant"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  affected_application_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'Loan' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM "assertDisbursedCreditLifeCoverage"(NEW."applicationId");
    ELSIF TG_OP = 'UPDATE' THEN
      PERFORM "assertDisbursedCreditLifeCoverage"(OLD."applicationId");
      IF NEW."applicationId" IS DISTINCT FROM OLD."applicationId" THEN
        PERFORM "assertDisbursedCreditLifeCoverage"(NEW."applicationId");
      END IF;
    ELSE
      PERFORM "assertDisbursedCreditLifeCoverage"(OLD."applicationId");
    END IF;
  ELSIF TG_TABLE_NAME = 'LoanApplication' THEN
    IF TG_OP = 'INSERT' THEN
      PERFORM "assertDisbursedCreditLifeCoverage"(NEW."id");
    ELSIF TG_OP = 'UPDATE' THEN
      PERFORM "assertDisbursedCreditLifeCoverage"(OLD."id");
      IF NEW."id" IS DISTINCT FROM OLD."id" THEN
        PERFORM "assertDisbursedCreditLifeCoverage"(NEW."id");
      END IF;
    ELSE
      PERFORM "assertDisbursedCreditLifeCoverage"(OLD."id");
    END IF;
  ELSIF TG_TABLE_NAME = 'ClientDocument' THEN
    IF TG_OP = 'INSERT' THEN
      FOR affected_application_id IN
        SELECT application."id"
        FROM "LoanApplication" AS application
        WHERE application."agreementDocumentId" = NEW."id"
        ORDER BY application."id"
      LOOP
        PERFORM "assertDisbursedCreditLifeCoverage"(affected_application_id);
      END LOOP;
    ELSIF TG_OP = 'UPDATE' THEN
      FOR affected_application_id IN
        SELECT application."id"
        FROM "LoanApplication" AS application
        WHERE application."agreementDocumentId" IN (OLD."id", NEW."id")
        ORDER BY application."id"
      LOOP
        PERFORM "assertDisbursedCreditLifeCoverage"(affected_application_id);
      END LOOP;
    ELSE
      FOR affected_application_id IN
        SELECT application."id"
        FROM "LoanApplication" AS application
        WHERE application."agreementDocumentId" = OLD."id"
        ORDER BY application."id"
      LOOP
        PERFORM "assertDisbursedCreditLifeCoverage"(affected_application_id);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'ComplianceRecord' THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType" THEN
        PERFORM "assertDisbursedCreditLifeCoverage"(NEW."referenceId");
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      IF OLD."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType" THEN
        PERFORM "assertDisbursedCreditLifeCoverage"(OLD."referenceId");
      END IF;
      IF NEW."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType"
         AND (
           OLD."type" <> 'AGREEMENT_ARTIFACT'::"ComplianceType"
           OR NEW."referenceId" IS DISTINCT FROM OLD."referenceId"
         ) THEN
        PERFORM "assertDisbursedCreditLifeCoverage"(NEW."referenceId");
      END IF;
    ELSIF OLD."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType" THEN
      PERFORM "assertDisbursedCreditLifeCoverage"(OLD."referenceId");
    END IF;
  ELSIF TG_TABLE_NAME = 'InsurancePolicy' THEN
    IF TG_OP = 'INSERT' THEN
      SELECT loan."applicationId"
      INTO affected_application_id
      FROM "Loan" AS loan
      WHERE loan."id" = NEW."linkedLoanId";
      PERFORM "assertDisbursedCreditLifeCoverage"(affected_application_id);
    ELSIF TG_OP = 'UPDATE' THEN
      FOR affected_application_id IN
        SELECT loan."applicationId"
        FROM "Loan" AS loan
        WHERE loan."id" IN (OLD."linkedLoanId", NEW."linkedLoanId")
        ORDER BY loan."applicationId"
      LOOP
        PERFORM "assertDisbursedCreditLifeCoverage"(affected_application_id);
      END LOOP;
    ELSE
      SELECT loan."applicationId"
      INTO affected_application_id
      FROM "Loan" AS loan
      WHERE loan."id" = OLD."linkedLoanId";
      PERFORM "assertDisbursedCreditLifeCoverage"(affected_application_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'InsuranceProduct' THEN
    IF TG_OP = 'INSERT' THEN
      FOR affected_application_id IN
        SELECT DISTINCT loan."applicationId"
        FROM "InsurancePolicy" AS policy
        JOIN "Loan" AS loan
          ON loan."id" = policy."linkedLoanId"
        WHERE policy."productId" = NEW."id"
        ORDER BY loan."applicationId"
      LOOP
        PERFORM "assertDisbursedCreditLifeCoverage"(affected_application_id);
      END LOOP;
    ELSIF TG_OP = 'UPDATE' THEN
      FOR affected_application_id IN
        SELECT DISTINCT loan."applicationId"
        FROM "InsurancePolicy" AS policy
        JOIN "Loan" AS loan
          ON loan."id" = policy."linkedLoanId"
        WHERE policy."productId" IN (OLD."id", NEW."id")
        ORDER BY loan."applicationId"
      LOOP
        PERFORM "assertDisbursedCreditLifeCoverage"(affected_application_id);
      END LOOP;
    ELSE
      FOR affected_application_id IN
        SELECT DISTINCT loan."applicationId"
        FROM "InsurancePolicy" AS policy
        JOIN "Loan" AS loan
          ON loan."id" = policy."linkedLoanId"
        WHERE policy."productId" = OLD."id"
        ORDER BY loan."applicationId"
      LOOP
        PERFORM "assertDisbursedCreditLifeCoverage"(affected_application_id);
      END LOOP;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."assertDisbursedCreditLifeCoverage"(target_application_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  application_status "AppStatus";
  application_disbursed_at TIMESTAMP(3);
  application_tenant_id TEXT;
  application_client_id TEXT;
  loan_id TEXT;
  loan_tenant_id TEXT;
  loan_client_id TEXT;
  loan_principal INTEGER;
  loan_start_date TIMESTAMP(3);
  loan_maturity_date TIMESTAMP(3);
  elected_credit_life BOOLEAN;
  bundled_policy_count BIGINT;
  valid_bundled_policy_count BIGINT;
BEGIN
  IF target_application_id IS NULL THEN
    RETURN;
  END IF;

  SELECT
    application."status",
    application."disbursedAt",
    application."tenantId",
    application."clientId",
    loan."id",
    loan."tenantId",
    loan."clientId",
    loan."principal",
    loan."startDate",
    loan."maturityDate"
  INTO
    application_status,
    application_disbursed_at,
    application_tenant_id,
    application_client_id,
    loan_id,
    loan_tenant_id,
    loan_client_id,
    loan_principal,
    loan_start_date,
    loan_maturity_date
  FROM "LoanApplication" AS application
  LEFT JOIN "Loan" AS loan
    ON loan."applicationId" = application."id"
  WHERE application."id" = target_application_id
  FOR KEY SHARE OF application;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- An application with no loan and no disbursement is outside this invariant.
  IF loan_id IS NULL
     AND application_status <> 'DISBURSED'::"AppStatus" THEN
    RETURN;
  END IF;

  -- A Loan row represents the money path. It and the application transition
  -- must become visible together at commit, regardless of writer version.
  IF loan_id IS NULL
     OR application_status <> 'DISBURSED'::"AppStatus"
     OR application_disbursed_at IS NULL
     OR loan_tenant_id IS DISTINCT FROM application_tenant_id
     OR loan_client_id IS DISTINCT FROM application_client_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan creation and application disbursement must commit together with matching tenant and client evidence';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "LoanApplication" AS outage_application
    WHERE outage_application."id" = target_application_id
      AND "validOutageDisbursementException"(
        outage_application."tenantId",
        outage_application."id",
        outage_application."reference",
        outage_application."disbursedAt",
        outage_application."disbursementExceptionId"
      )
  ) THEN
    SELECT COUNT(*)
    INTO bundled_policy_count
    FROM "InsurancePolicy" AS policy
    WHERE policy."linkedLoanId" = loan_id
      AND policy."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
      AND policy."policySource"
        = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource";

    IF bundled_policy_count <> 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Outage reconciliation with declined credit life cannot have a bundled policy';
    END IF;

    PERFORM "validateOutageDisbursementLoan"(loan_id);
    RETURN;
  END IF;

  elected_credit_life := "resolveCreditLifeElectionForLoan"(
    application_tenant_id,
    application_client_id,
    loan_id
  );

  SELECT COUNT(*)
  INTO bundled_policy_count
  FROM "InsurancePolicy" AS policy
  WHERE policy."linkedLoanId" = loan_id
    AND policy."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
    AND policy."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource";

  SELECT COUNT(*)
  INTO valid_bundled_policy_count
  FROM "InsurancePolicy" AS policy
  JOIN "InsuranceProduct" AS product
    ON product."id" = policy."productId"
   AND product."tenantId" = policy."tenantId"
   AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
  WHERE policy."linkedLoanId" = loan_id
    AND policy."tenantId" = application_tenant_id
    AND policy."clientId" = application_client_id
    AND policy."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
    AND policy."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource"
    AND policy."premiumAmount" > 0
    AND policy."sumAssured" > 0
    AND policy."renewalDate" > policy."startDate"
    AND policy."sumAssured" = loan_principal::NUMERIC / 100
    AND policy."premiumAmount" = ROUND((loan_principal::NUMERIC / 100) * 0.0045, 2)
    AND policy."startDate" = loan_start_date
    AND policy."renewalDate" = loan_maturity_date;

  IF elected_credit_life THEN
    IF bundled_policy_count <> 1 OR valid_bundled_policy_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Disbursed loan with elected credit life requires exactly one valid bundled policy';
    END IF;
    PERFORM "assertBundledCreditLifeAgreement"(
      application_tenant_id,
      application_client_id,
      loan_id
    );
  ELSIF bundled_policy_count <> 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Disbursed loan without a credit-life election cannot have a bundled policy';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_legacy_website_lead_conversion()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  "matchingApplicationId" TEXT;
  "matchingApplicationCount" INTEGER;
BEGIN
  IF OLD."status" <> 'CONVERTED'
    AND OLD."convertedToClientId" IS NULL
    AND OLD."convertedToApplicationId" IS NULL
    AND NEW."status" = 'QUALIFIED'
    AND NEW."convertedToClientId" IS NOT NULL
    AND NEW."convertedToApplicationId" IS NULL
    AND NEW."conversionRecoveryRequired" = false
  THEN
    SELECT
      MIN(application."id"),
      COUNT(DISTINCT application."id")::INTEGER
    INTO "matchingApplicationId", "matchingApplicationCount"
    FROM "AuditLog" AS audit
    INNER JOIN "LoanApplication" AS application
      ON application."id" = audit."entityId"
     AND application."tenantId" = NEW."tenantId"
     AND application."clientId" = NEW."convertedToClientId"
    WHERE audit."tenantId" = NEW."tenantId"
      AND audit."action" = 'APPLICATION_SUBMITTED_BY_CLIENT'
      AND audit."entity" = 'LoanApplication'
      AND audit."newValue" ->> 'source' = 'website_apply'
      AND audit."newValue" ->> 'leadId' = NEW."id"
      AND audit."newValue" ->> 'clientId' = NEW."convertedToClientId";

    IF "matchingApplicationCount" = 1 THEN
      NEW."status" = 'CONVERTED';
      NEW."convertedToApplicationId" = "matchingApplicationId";

      INSERT INTO "AuditLog" (
        "id", "tenantId", "userEmail", "action", "entity", "entityId",
        "oldValue", "newValue", "createdAt"
      ) VALUES (
        'lead-rolling-website-compat-' || NEW."id" || '-' || "matchingApplicationId",
        NEW."tenantId",
        'migration@lead-conversion-compat',
        'LEAD_CONVERTED',
        'Lead',
        NEW."id",
        jsonb_build_object(
          'status', OLD."status"::text,
          'convertedToClientId', OLD."convertedToClientId",
          'convertedToApplicationId', OLD."convertedToApplicationId"
        ),
        jsonb_build_object(
          'status', 'CONVERTED',
          'convertedToClientId', NEW."convertedToClientId",
          'convertedToApplicationId', "matchingApplicationId",
          'source', 'migrate_before_deploy_website_compatibility'
        ),
        CURRENT_TIMESTAMP
      )
      ON CONFLICT ("id") DO NOTHING;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardBoundAgreementDocument"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  bound BOOLEAN;
BEGIN
  bound := EXISTS (
    SELECT 1
    FROM "LoanApplication" AS application
    WHERE application."tenantId" = OLD."tenantId"
      AND application."clientId" = OLD."clientId"
      AND application."agreementDocumentId" = OLD."id"
      AND application."status"::TEXT IN ('APPROVED', 'DISBURSED')
  );

  IF NOT bound THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A bound credit-agreement document is immutable';
  END IF;

  -- Deliberately NARROW, unlike the PASQ guard's whole-row immutability. The
  -- signing ceremony legitimately writes verified, verifiedAt, verifiedById,
  -- signatureState and signedAt onto this exact row, and countersigning reads
  -- it. Freezing the whole row would break the ceremony this document exists
  -- for. Only the retirement transition is refused.
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A bound credit-agreement document may not be retired; return the application to review to re-paper it';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardBoundDebitMandateDocument"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  bound_as_signed_mandate BOOLEAN;
  bound_as_signed_bank_statement BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM "LoanApplication" AS application
    WHERE application."debitMandateDocumentId" = OLD."id"
  ) INTO bound_as_signed_mandate;

  SELECT EXISTS (
    SELECT 1
    FROM "LoanApplication" AS application
    WHERE application."debitMandateSignedAt" IS NOT NULL
      AND application."debitMandateEvidence" -> 'bankStatement' ->> 'documentId' = OLD."id"
  ) INTO bound_as_signed_bank_statement;

  IF (bound_as_signed_mandate OR bound_as_signed_bank_statement) AND (
    TG_OP = 'DELETE'
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."docType" IS DISTINCT FROM OLD."docType"
    OR NEW."fileUrl" IS DISTINCT FROM OLD."fileUrl"
    OR NEW."fileName" IS DISTINCT FROM OLD."fileName"
    OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
    OR NEW."fileSize" IS DISTINCT FROM OLD."fileSize"
    OR NEW."mimeType" IS DISTINCT FROM OLD."mimeType"
    OR NEW."storagePath" IS DISTINCT FROM OLD."storagePath"
    OR NEW."contentSha256" IS DISTINCT FROM OLD."contentSha256"
    OR NEW."verified" IS DISTINCT FROM OLD."verified"
    OR NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt"
    OR NEW."extractionResult" IS DISTINCT FROM OLD."extractionResult"
    OR NEW."validationMismatch" IS DISTINCT FROM OLD."validationMismatch"
    OR NEW."signatureState" IS DISTINCT FROM OLD."signatureState"
    OR NEW."signedAt" IS DISTINCT FROM OLD."signedAt"
    OR NEW."signedByIp" IS DISTINCT FROM OLD."signedByIp"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = CASE
        WHEN bound_as_signed_mandate
          THEN 'A signed debit-mandate document is immutable while bound to an application'
        ELSE 'A bank statement bound to a signed debit mandate is immutable'
      END;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardBoundExecutedAgreement"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  bound BOOLEAN;
BEGIN
  IF OLD."docType" <> 'EXECUTED_CREDIT_AGREEMENT' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  bound := EXISTS (
    SELECT 1
    FROM "LoanApplication" AS application
    WHERE application."tenantId" = OLD."tenantId"
      AND application."clientId" = OLD."clientId"
      AND application."agreementExecutedDocumentId" = OLD."id"
      AND application."status"::TEXT IN ('APPROVED', 'DISBURSED')
  );

  IF NOT bound THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A bound executed credit agreement is immutable';
  END IF;

  -- Only the retirement transition. The row is created verified/signed and
  -- nothing legitimately mutates it afterwards, but freezing the whole row
  -- would refuse writes no one has needed yet and turn a future, harmless
  -- column addition into a production outage.
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A bound executed credit agreement may not be retired; return the application to review to re-paper it';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardBoundPasqDocument"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  bound BOOLEAN;
BEGIN
  bound := EXISTS (
    SELECT 1
    FROM "LoanApplication" AS application
    WHERE application."tenantId" = OLD."tenantId"
      AND application."clientId" = OLD."clientId"
      AND application."pasqDocumentId" = OLD."id"
      AND application."status"::TEXT IN ('APPROVED', 'DISBURSED')
  );

  IF NOT bound THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An approved or disbursed PASQ document is immutable';
  END IF;

  -- Whole-row immutability, minus the single column the ceremony writes.
  -- (ClientDocument has no ORM-stamped updatedAt column; nothing else may
  -- ride along, so that any column added in future is frozen by default.)
  IF (TO_JSONB(NEW) - 'signatureState')
    IS DISTINCT FROM (TO_JSONB(OLD) - 'signatureState')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'An approved or disbursed PASQ document is immutable';
  END IF;

  -- Consumers never sign a quotation: the only state a bound PASQ document
  -- may move to is 'acknowledged', and only once the bound application has
  -- recorded the consumer's acknowledgement of these exact bytes — the flag
  -- must never exist without the evidence it summarises.
  IF NEW."signatureState" IS DISTINCT FROM OLD."signatureState" THEN
    IF NEW."signatureState" IS DISTINCT FROM 'acknowledged' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'A bound PASQ document only accepts the acknowledged signature state';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM "LoanApplication" AS application
      WHERE application."tenantId" = OLD."tenantId"
        AND application."clientId" = OLD."clientId"
        AND application."pasqDocumentId" = OLD."id"
        AND application."pasqAcknowledgedAt" IS NOT NULL
        AND application."pasqAcknowledgedSha256" = OLD."contentSha256"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'The acknowledged marking requires the bound application to hold the consumer acknowledgement of this exact document';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardBundledCreditLifeAgreement"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
       AND OLD."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Bundled credit-life policy records cannot be hard-deleted';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
     AND OLD."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource"
     AND (
       NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
       OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
       OR NEW."type" IS DISTINCT FROM OLD."type"
       OR NEW."policySource" IS DISTINCT FROM OLD."policySource"
       OR NEW."linkedLoanId" IS DISTINCT FROM OLD."linkedLoanId"
       OR NEW."productId" IS DISTINCT FROM OLD."productId"
       OR NEW."premiumAmount" IS DISTINCT FROM OLD."premiumAmount"
       OR NEW."sumAssured" IS DISTINCT FROM OLD."sumAssured"
       OR NEW."startDate" IS DISTINCT FROM OLD."startDate"
       OR NEW."renewalDate" IS DISTINCT FROM OLD."renewalDate"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bundled credit-life agreement binding is immutable';
  END IF;

  IF NEW."type" <> 'CREDIT_LIFE'::"InsurancePolicyType"
     OR NEW."policySource" <> 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource" THEN
    RETURN NEW;
  END IF;

  PERFORM "assertBundledCreditLifePolicyTerms"(
    NEW."tenantId",
    NEW."clientId",
    NEW."linkedLoanId",
    NEW."productId",
    NEW."premiumAmount",
    NEW."sumAssured",
    NEW."startDate",
    NEW."renewalDate",
    TG_OP = 'INSERT'
      OR OLD."type" IS DISTINCT FROM 'CREDIT_LIFE'::"InsurancePolicyType"
      OR OLD."policySource" IS DISTINCT FROM 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource"
  );
  PERFORM "assertBundledCreditLifeAgreement"(
    NEW."tenantId",
    NEW."clientId",
    NEW."linkedLoanId"
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardCreditLifeProductIdentity"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Product identity is frozen only after a bundled policy is bound. The
  -- policy writer takes FOR SHARE on this exact product row; this reverse
  -- predicate read completes the SERIALIZABLE cycle when a first bind races
  -- a type change. Unused products remain editable.
  IF (
       NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
       OR NEW."type" IS DISTINCT FROM OLD."type"
     )
     AND EXISTS (
       SELECT 1
       FROM "InsurancePolicy" AS policy
       WHERE policy."productId" = OLD."id"
         AND policy."tenantId" = OLD."tenantId"
         AND policy."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
         AND policy."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Credit-life insurance product identity and type are immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationBranchSignerTenant"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  locked_signer_id TEXT;
BEGIN
  IF NEW."agreementSignedAt" IS NOT NULL
     AND NEW."agreementSignedMethod" = 'branch'
     AND (
       TG_OP = 'INSERT'
       OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
       OR OLD."agreementSignedAt" IS DISTINCT FROM NEW."agreementSignedAt"
       OR OLD."agreementSignedMethod" IS DISTINCT FROM NEW."agreementSignedMethod"
       OR OLD."agreementSignedByUserId"
         IS DISTINCT FROM NEW."agreementSignedByUserId"
     )
  THEN
    SELECT signer."id"
    INTO locked_signer_id
    FROM "User" AS signer
    WHERE signer."id" = NEW."agreementSignedByUserId"
      AND signer."tenantId" = NEW."tenantId"
      AND signer."active" = TRUE
      AND signer."role" IN (
        'CREDIT_OFFICER'::"UserRole",
        'LOAN_ADMIN'::"UserRole",
        'BRANCH_MANAGER'::"UserRole",
        'ADMIN'::"UserRole",
        'SUPER_ADMIN'::"UserRole"
      )
    FOR SHARE;

    IF locked_signer_id IS NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Branch agreement signing requires an active authorised witness from the application tenant';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationCreditLifeOffer"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  locked_product_id TEXT;
  entering_approved_state BOOLEAN;
BEGIN
  entering_approved_state :=
    NEW."status"::TEXT IN ('APPROVED', 'DISBURSED')
    AND (
      TG_OP = 'INSERT'
      OR OLD."status"::TEXT NOT IN ('APPROVED', 'DISBURSED')
      OR (
        OLD."status"::TEXT <> 'DISBURSED'
        AND NEW."status"::TEXT = 'DISBURSED'
      )
      OR NEW."creditLifeElection" IS DISTINCT FROM OLD."creditLifeElection"
      OR NEW."creditLifeProductId" IS DISTINCT FROM OLD."creditLifeProductId"
      OR NEW."creditLifeProductName"
        IS DISTINCT FROM OLD."creditLifeProductName"
      OR NEW."creditLifeInsurerId" IS DISTINCT FROM OLD."creditLifeInsurerId"
      OR NEW."creditLifeInsurerName"
        IS DISTINCT FROM OLD."creditLifeInsurerName"
      OR NEW."creditLifeMonthlyPremiumCents"
        IS DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
      OR NEW."creditLifeDisclosureVersion"
        IS DISTINCT FROM OLD."creditLifeDisclosureVersion"
      OR NEW."creditLifeDisclosureSha256"
        IS DISTINCT FROM OLD."creditLifeDisclosureSha256"
      OR NEW."creditLifeDisclosureAcknowledgedAt"
        IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
      OR NEW."creditLifeDisclosureAcknowledgedBy"
        IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy"
      OR NEW."pasqEvidence" IS DISTINCT FROM OLD."pasqEvidence"
    );

  IF NOT entering_approved_state THEN
    RETURN NEW;
  END IF;

  -- No offer was disclosed, so there is no product row to lock. But the row
  -- ASSERTS that no cover was offered, and that has to still be true at
  -- approval: if an insurer was onboarded between PASQ generation and here,
  -- the assertion is now false and the application must go back to draft for
  -- a current election. The offered path re-verifies at approval and again at
  -- disbursement; without this the no-offer path verified at neither.
  IF NEW."creditLifeDisclosureVersion" = 'credit-life-no-offer-v1' THEN
    IF EXISTS (
      SELECT 1
      FROM "InsuranceProduct" AS product
      JOIN "Insurer" AS insurer
        ON insurer."id" = product."insurerId"
        AND insurer."tenantId" = product."tenantId"
      WHERE product."tenantId" = NEW."tenantId"
        AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
        AND product."active" = TRUE
        AND LENGTH(BTRIM(product."name")) > 0
        AND insurer."active" = TRUE
        AND LENGTH(BTRIM(insurer."name")) > 0
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Approval requires a current credit-life election: cover became available after this application recorded that none was offered';
    END IF;
    RETURN NEW;
  END IF;

  SELECT product."id"
  INTO locked_product_id
  FROM "InsuranceProduct" AS product
  JOIN "Insurer" AS insurer
    ON insurer."id" = product."insurerId"
    AND insurer."tenantId" = product."tenantId"
  WHERE product."id" = NEW."creditLifeProductId"
    AND product."tenantId" = NEW."tenantId"
    AND product."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
    AND product."active" = TRUE
    AND product."name" = NEW."creditLifeProductName"
    AND insurer."id" = NEW."creditLifeInsurerId"
    AND insurer."tenantId" = NEW."tenantId"
    AND insurer."active" = TRUE
    AND insurer."name" = NEW."creditLifeInsurerName"
  FOR SHARE OF product, insurer;

  IF locked_product_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Approval requires an active tenant-bound credit-life product and insurer matching the acknowledged PASQ';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationDebitMandate"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'DISBURSED'::"AppStatus" AND (
    NEW."debitMandatePreparedAt" IS NULL
    OR NEW."debitMandateReference" IS NULL
    OR LENGTH(BTRIM(NEW."debitMandateReference")) = 0
    OR NEW."debitMandateDraftSha256" !~ '^[0-9a-f]{64}$'
    OR NEW."debitMandateEvidence" IS NULL
    OR NEW."debitMandateEvidenceSha256" !~ '^[0-9a-f]{64}$'
    OR NEW."debitMandateSignedAt" IS NULL
    OR NEW."debitMandateSignedMethod" IS DISTINCT FROM 'portal'
    OR NEW."debitMandateSignatureData" IS NULL
    OR LENGTH(BTRIM(NEW."debitMandateSignatureData")) = 0
    OR NEW."debitMandateSignatureSha256" !~ '^[0-9a-f]{64}$'
    OR NEW."debitMandateDocumentId" IS NULL
    OR LENGTH(BTRIM(NEW."debitMandateDocumentId")) = 0
    OR NEW."debitMandateDocumentSha256" !~ '^[0-9a-f]{64}$'
    OR NEW."agreementSignedAt" IS NULL
    OR NEW."debitMandateSignedAt" < NEW."agreementSignedAt"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan disbursement requires a complete customer-signed debit mandate';
  END IF;

  IF NEW."status" = 'DISBURSED'::"AppStatus" AND (
    NEW."debitMandateEvidence" ->> 'version'
      IS DISTINCT FROM 'debit-mandate-v1'
    OR NEW."debitMandateEvidence" ->> 'applicationId'
      IS DISTINCT FROM NEW."id"
    OR NEW."debitMandateEvidence" ->> 'clientId'
      IS DISTINCT FROM NEW."clientId"
    OR NEW."debitMandateEvidence" ->> 'collectionReference'
      IS DISTINCT FROM NEW."debitMandateReference"
    OR (NEW."debitMandateEvidence" ->> 'preparedAt')::TIMESTAMPTZ
      IS DISTINCT FROM NEW."debitMandatePreparedAt" AT TIME ZONE 'UTC'
    OR NEW."debitMandateEvidenceSha256" IS DISTINCT FROM encode(
      sha256(convert_to(
        "canonicalJsonb"(NEW."debitMandateEvidence"),
        'UTF8'
      )),
      'hex'
    )
    OR NEW."debitMandateSignatureSha256" IS DISTINCT FROM encode(
      sha256(convert_to(NEW."debitMandateSignatureData", 'UTF8')),
      'hex'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM "ClientDocument" AS mandate
      WHERE mandate."id" = NEW."debitMandateDocumentId"
        AND mandate."tenantId" = NEW."tenantId"
        AND mandate."clientId" = NEW."clientId"
        AND mandate."docType" = 'DEBIT_MANDATE'::"DocType"
        AND mandate."fileName" = 'debit-mandate-' || NEW."id" || '.pdf'
        AND mandate."deletedAt" IS NULL
        AND mandate."verified" = true
        AND mandate."verifiedAt" = NEW."debitMandateSignedAt"
        AND mandate."signatureState" = 'signed'
        AND mandate."signedAt" = NEW."debitMandateSignedAt"
        AND mandate."contentSha256" = NEW."debitMandateDocumentSha256"
        AND mandate."storagePath" IS NOT NULL
    )
    OR NOT EXISTS (
      SELECT 1
      FROM "Client" AS client
      JOIN "ClientDocument" AS statement
        ON statement."id" =
          NEW."debitMandateEvidence" -> 'bankStatement' ->> 'documentId'
       AND statement."tenantId" = NEW."tenantId"
       AND statement."clientId" = NEW."clientId"
      WHERE client."id" = NEW."clientId"
        AND client."tenantId" = NEW."tenantId"
        AND client."bankName" IS NOT NULL
        AND client."bankBranchCode" IS NOT NULL
        AND client."bankAccountNumber" IS NOT NULL
        AND client."accountType" IN ('CHEQUE', 'SAVINGS')
        AND NEW."debitMandateEvidence" ->> 'bankDetailsSha256'
          = encode(
              sha256(convert_to(
                "canonicalJsonb"(
                  jsonb_build_object(
                    'bankName',
                      lower(regexp_replace(
                        BTRIM(client."bankName"),
                        '[[:space:]]+',
                        ' ',
                        'g'
                      )),
                    'branchCode',
                      regexp_replace(client."bankBranchCode", '[^0-9]', '', 'g'),
                    'accountNumber',
                      regexp_replace(client."bankAccountNumber", '[^0-9]', '', 'g'),
                    'accountType', client."accountType"
                  )
                ),
                'UTF8'
              )),
              'hex'
            )
        AND statement."docType" = 'BANK_STATEMENT'::"DocType"
        AND statement."deletedAt" IS NULL
        AND statement."verified" = true
        AND statement."verifiedAt" =
          (
            NEW."debitMandateEvidence"
              -> 'bankStatement'
              ->> 'verifiedAt'
          )::TIMESTAMPTZ AT TIME ZONE 'UTC'
        AND statement."validationMismatch" = false
        AND statement."contentSha256" =
          NEW."debitMandateEvidence"
            -> 'bankStatement'
            ->> 'documentSha256'
        AND regexp_replace(
          COALESCE(
            statement."extractionResult"
              -> 'fields'
              -> 'accountNumber'
              ->> 'value',
            statement."extractionResult"
              -> 'fields'
              ->> 'accountNumber',
            statement."extractionResult"
              -> 'accountNumber'
              ->> 'value',
            statement."extractionResult"
              ->> 'accountNumber',
            ''
          ),
          '[^0-9]',
          '',
          'g'
        ) = regexp_replace(
          client."bankAccountNumber",
          '[^0-9]',
          '',
          'g'
        )
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan disbursement requires exact debit-mandate, banking and document evidence';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."status" = 'DISBURSED'::"AppStatus" AND (
    NEW."debitMandatePreparedAt" IS DISTINCT FROM OLD."debitMandatePreparedAt"
    OR NEW."debitMandateReference" IS DISTINCT FROM OLD."debitMandateReference"
    OR NEW."debitMandateDraftSha256" IS DISTINCT FROM OLD."debitMandateDraftSha256"
    OR NEW."debitMandateEvidence" IS DISTINCT FROM OLD."debitMandateEvidence"
    OR NEW."debitMandateEvidenceSha256" IS DISTINCT FROM OLD."debitMandateEvidenceSha256"
    OR NEW."debitMandateSignedAt" IS DISTINCT FROM OLD."debitMandateSignedAt"
    OR NEW."debitMandateSignedMethod" IS DISTINCT FROM OLD."debitMandateSignedMethod"
    OR NEW."debitMandateSignedByIp" IS DISTINCT FROM OLD."debitMandateSignedByIp"
    OR NEW."debitMandateSignatureData" IS DISTINCT FROM OLD."debitMandateSignatureData"
    OR NEW."debitMandateSignatureSha256" IS DISTINCT FROM OLD."debitMandateSignatureSha256"
    OR NEW."debitMandateDocumentId" IS DISTINCT FROM OLD."debitMandateDocumentId"
    OR NEW."debitMandateDocumentSha256" IS DISTINCT FROM OLD."debitMandateDocumentSha256"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Debit-mandate evidence is immutable after disbursement';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationDebitMandateBankTupleRepair"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'DISBURSED'::"AppStatus" AND NOT EXISTS (
    SELECT 1
    FROM "Client" AS client
    JOIN "ClientDocument" AS statement
      ON statement."id" =
        NEW."debitMandateEvidence" -> 'bankStatement' ->> 'documentId'
     AND statement."tenantId" = NEW."tenantId"
     AND statement."clientId" = NEW."clientId"
    WHERE client."id" = NEW."clientId"
      AND client."tenantId" = NEW."tenantId"
      AND client."bankName" IS NOT NULL
      AND client."bankBranchCode" IS NOT NULL
      AND client."bankAccountNumber" IS NOT NULL
      AND client."accountType" IN ('CHEQUE', 'SAVINGS')
      AND regexp_replace(
        COALESCE(
          statement."extractionResult" -> 'fields' -> 'accountNumber' ->> 'value',
          statement."extractionResult" -> 'fields' ->> 'accountNumber',
          statement."extractionResult" -> 'accountNumber' ->> 'value',
          statement."extractionResult" ->> 'accountNumber',
          ''
        ),
        '[^0-9]',
        '',
        'g'
      ) = regexp_replace(client."bankAccountNumber", '[^0-9]', '', 'g')
      AND "canonicalBankName"(
        COALESCE(
          statement."extractionResult" -> 'fields' -> 'bankName' ->> 'value',
          statement."extractionResult" -> 'fields' ->> 'bankName',
          statement."extractionResult" -> 'bankName' ->> 'value',
          statement."extractionResult" ->> 'bankName',
          ''
        )
      ) = "canonicalBankName"(client."bankName")
      AND (
        lower(
          regexp_replace(
            COALESCE(
              statement."extractionResult" -> 'fields' -> 'accountType' ->> 'value',
              statement."extractionResult" -> 'fields' ->> 'accountType',
              statement."extractionResult" -> 'accountType' ->> 'value',
              statement."extractionResult" ->> 'accountType',
              ''
            ),
            '[^a-zA-Z]',
            '',
            'g'
          )
        ) IN ('', 'other')
        OR "canonicalAccountType"(
          COALESCE(
            statement."extractionResult" -> 'fields' -> 'accountType' ->> 'value',
            statement."extractionResult" -> 'fields' ->> 'accountType',
            statement."extractionResult" -> 'accountType' ->> 'value',
            statement."extractionResult" ->> 'accountType',
            ''
          )
        ) = client."accountType"::TEXT
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan disbursement requires the signed mandate bank statement to match the complete payout bank tuple';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationDebitMandateContractTerms"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  contract_evidence JSONB;
  approval_evidence JSONB;
  mandate_terms JSONB;
  billing_schedule JSONB;
  contract_schedule JSONB;
  schedule_length INTEGER;
  expected_frequency TEXT;
  expected_first_amount BIGINT;
  expected_recurring_amount BIGINT;
  expected_first_date TEXT;
  expected_initiation_fee BIGINT;
  initiation_fee_payment TEXT;
BEGIN
  IF NEW."status" IS DISTINCT FROM 'DISBURSED'::"AppStatus"
    AND NEW."debitMandateSignedAt" IS NULL
  THEN
    RETURN NEW;
  END IF;

  contract_evidence := NEW."affordabilityResult" -> 'contract';
  approval_evidence := NEW."affordabilityResult" -> 'approval';
  mandate_terms := NEW."debitMandateEvidence" -> 'terms';
  billing_schedule := NEW."pasqEvidence" -> 'billing' -> 'schedule';
  contract_schedule :=
    contract_evidence -> 'calculator' -> 'schedule';

  IF jsonb_typeof(contract_evidence) IS DISTINCT FROM 'object'
    OR jsonb_typeof(approval_evidence) IS DISTINCT FROM 'object'
    OR jsonb_typeof(mandate_terms) IS DISTINCT FROM 'object'
    OR jsonb_typeof(billing_schedule) IS DISTINCT FROM 'array'
    OR jsonb_typeof(contract_schedule) IS DISTINCT FROM 'array'
    OR contract_evidence ->> 'fingerprint' IS NULL
    OR contract_evidence ->> 'fingerprint'
      !~ '^[0-9a-f]{64}$'
    OR NEW."debitMandateEvidence" ->> 'contractFingerprint'
      IS DISTINCT FROM contract_evidence ->> 'fingerprint'
    OR NEW."pasqEvidence" ->> 'version'
      IS DISTINCT FROM 'pasq-v3'
    OR NEW."pasqEvidence" #>> '{calculator,contractFingerprint}'
      IS DISTINCT FROM
        contract_evidence ->> 'acceptedPasqContractFingerprint'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Loan disbursement requires debit-mandate terms bound to the signed contract';
  END IF;

  schedule_length := jsonb_array_length(billing_schedule);
  IF schedule_length < 1
    OR jsonb_array_length(contract_schedule) <> schedule_length
    OR jsonb_typeof(billing_schedule -> 0 -> 'totalDueCents')
      IS DISTINCT FROM 'number'
    OR jsonb_typeof(contract_evidence -> 'calculator' -> 'initiationFeeCents')
      IS DISTINCT FROM 'number'
    OR contract_schedule -> 0 ->> 'dueDate' IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Loan disbursement requires debit-mandate terms bound to the signed contract';
  END IF;

  expected_frequency :=
    CASE WHEN schedule_length = 1 THEN 'ONCE_OFF' ELSE 'MONTHLY' END;
  expected_first_amount :=
    (billing_schedule -> 0 ->> 'totalDueCents')::BIGINT;
  expected_first_date := contract_schedule -> 0 ->> 'dueDate';
  initiation_fee_payment :=
    approval_evidence -> 'inputs' ->> 'initiationFeePayment';
  IF NEW."initiationFeePayment"::TEXT
      IS DISTINCT FROM initiation_fee_payment
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Loan disbursement requires debit-mandate terms bound to the signed contract';
  ELSIF initiation_fee_payment = 'DEFERRED' THEN
    expected_initiation_fee :=
      (
        contract_evidence
          -> 'calculator'
          ->> 'initiationFeeCents'
      )::BIGINT;
  ELSIF initiation_fee_payment = 'UPFRONT' THEN
    expected_initiation_fee := 0;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Loan disbursement requires debit-mandate terms bound to the signed contract';
  END IF;

  IF mandate_terms ->> 'paymentFrequency'
      IS DISTINCT FROM expected_frequency
    OR jsonb_typeof(mandate_terms -> 'firstDebitAmountCents')
      IS DISTINCT FROM 'number'
    OR (mandate_terms ->> 'firstDebitAmountCents')::BIGINT
      IS DISTINCT FROM expected_first_amount
    OR mandate_terms ->> 'firstDebitDate'
      IS DISTINCT FROM expected_first_date
    OR jsonb_typeof(mandate_terms -> 'firstDebitInitiationFeeCents')
      IS DISTINCT FROM 'number'
    OR (mandate_terms ->> 'firstDebitInitiationFeeCents')::BIGINT
      IS DISTINCT FROM expected_initiation_fee
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Loan disbursement requires debit-mandate terms bound to the signed contract';
  END IF;

  IF schedule_length = 1 THEN
    IF NOT (mandate_terms ? 'recurringDebitAmountCents')
      OR jsonb_typeof(mandate_terms -> 'recurringDebitAmountCents')
        IS DISTINCT FROM 'null'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Loan disbursement requires debit-mandate terms bound to the signed contract';
    END IF;
  ELSE
    IF jsonb_typeof(billing_schedule -> 1 -> 'totalDueCents')
        IS DISTINCT FROM 'number'
      OR jsonb_typeof(mandate_terms -> 'recurringDebitAmountCents')
        IS DISTINCT FROM 'number'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Loan disbursement requires debit-mandate terms bound to the signed contract';
    END IF;
    expected_recurring_amount :=
      (billing_schedule -> 1 ->> 'totalDueCents')::BIGINT;
    IF (mandate_terms ->> 'recurringDebitAmountCents')::BIGINT
        IS DISTINCT FROM expected_recurring_amount
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Loan disbursement requires debit-mandate terms bound to the signed contract';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationDecisionHistoryInsert"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
    AND (
      NEW."affordabilityResult" ? 'approval'
      OR NEW."affordabilityResult" ? 'contract'
      OR
      NEW."affordabilityResult" ? 'approvalHistory'
      OR NEW."affordabilityResult" ? 'contractHistory'
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Active and archived decision evidence require a validated lifecycle transition';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationOutageExceptionBinding"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  saved_bank RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."disbursementExceptionId" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Outage disbursement exception binding is immutable';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."disbursementExceptionId" IS NOT NULL THEN
    IF
      NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."reference" IS DISTINCT FROM OLD."reference"
      OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
      OR NEW."productId" IS DISTINCT FROM OLD."productId"
      OR NEW."appliedAmount" IS DISTINCT FROM OLD."appliedAmount"
      OR NEW."appliedTermDays" IS DISTINCT FROM OLD."appliedTermDays"
      OR NEW."approvedAmount" IS DISTINCT FROM OLD."approvedAmount"
      OR NEW."approvedTermDays" IS DISTINCT FROM OLD."approvedTermDays"
      OR NEW."approvedRate" IS DISTINCT FROM OLD."approvedRate"
      OR NEW."affordabilityResult" IS DISTINCT FROM OLD."affordabilityResult"
      OR NEW."repaymentMethod" IS DISTINCT FROM OLD."repaymentMethod"
      OR NEW."creditLifeElection" IS DISTINCT FROM OLD."creditLifeElection"
      OR NEW."creditLifeProductId" IS DISTINCT FROM OLD."creditLifeProductId"
      OR NEW."creditLifeInsurerId" IS DISTINCT FROM OLD."creditLifeInsurerId"
      OR NEW."creditLifeMonthlyPremiumCents"
        IS DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
      OR NEW."status" IS DISTINCT FROM OLD."status"
      OR NEW."disbursedAt" IS DISTINCT FROM OLD."disbursedAt"
      OR NEW."disbursementBank" IS DISTINCT FROM OLD."disbursementBank"
      OR NEW."disbursementAccountNo"
        IS DISTINCT FROM OLD."disbursementAccountNo"
      OR NEW."disbursementBranchCode"
        IS DISTINCT FROM OLD."disbursementBranchCode"
      OR NEW."disbursementAccountType"
        IS DISTINCT FROM OLD."disbursementAccountType"
      OR NEW."disbursementRef" IS DISTINCT FROM OLD."disbursementRef"
      OR NEW."disbursementExceptionId"
        IS DISTINCT FROM OLD."disbursementExceptionId"
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Outage disbursement exception binding is immutable';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."disbursementExceptionId" IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP <> 'UPDATE'
     OR OLD."disbursementExceptionId" IS NOT NULL
     OR OLD."status" <> 'APPROVED'::"AppStatus"
     OR NEW."status" <> 'DISBURSED'::"AppStatus"
     OR NEW."repaymentMethod" <> 'EFT'::"LoanRepaymentMethod"
     OR NEW."creditLifeElection" <> 'DECLINED'::"CreditLifeElection"
     OR NEW."creditLifeProductId" IS NOT NULL
     OR NEW."creditLifeInsurerId" IS NOT NULL
     OR NEW."creditLifeMonthlyPremiumCents" <> 0
     OR NOT "validOutageDisbursementException"(
       NEW."tenantId",
       NEW."id",
       NEW."reference",
       NEW."disbursedAt",
       NEW."disbursementExceptionId"
     )
     -- The fixed allow-list of reconcilable applications is intentionally
     -- EMPTY in this product: no application matches, so binding is refused.
     OR NOT FALSE
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Application is not eligible for the fixed outage disbursement exception';
  END IF;

  SELECT
    client."bankName" AS bank_name,
    client."bankAccountNumber" AS account_number,
    client."bankBranchCode" AS branch_code,
    client."accountType"::TEXT AS account_type
  INTO saved_bank
  FROM "Client" AS client
  WHERE client."id" = NEW."clientId"
    AND client."tenantId" = NEW."tenantId"
  FOR SHARE;

  IF NOT FOUND
     OR saved_bank.bank_name IS NULL
     OR saved_bank.account_number IS NULL
     OR saved_bank.branch_code IS NULL
     OR saved_bank.account_type IS NULL
     OR NEW."disbursementBank" IS DISTINCT FROM saved_bank.bank_name
     OR NEW."disbursementAccountNo" IS DISTINCT FROM saved_bank.account_number
     OR NEW."disbursementBranchCode" IS DISTINCT FROM saved_bank.branch_code
     OR NEW."disbursementAccountType" IS DISTINCT FROM saved_bank.account_type
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Outage reconciliation must preserve the saved payout bank tuple';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationPasqApproval"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  explicit_return_to_review BOOLEAN;
  agreement_exists_old BOOLEAN;
  agreement_exists_new BOOLEAN;
  ceremony_open BOOLEAN;
BEGIN
  -- The freeze anchor. `agreementGeneratedAt` alone is not enough: it is
  -- nullable, and nulling it on a SIGNED row used to reopen the ceremony and
  -- let the acknowledged quotation be rewritten underneath the contract the
  -- consumer had already signed. The anchor is therefore the presence of ANY
  -- agreement artefact, and it is read from OLD as well as NEW so that the
  -- retraction cannot be laundered through an intermediate state.
  agreement_exists_new :=
    NEW."agreementGeneratedAt" IS NOT NULL
    OR NEW."agreementSignedAt" IS NOT NULL
    OR NEW."agreementCountersignedAt" IS NOT NULL;

  IF TG_OP = 'UPDATE' THEN
    agreement_exists_old :=
      OLD."agreementGeneratedAt" IS NOT NULL
      OR OLD."agreementSignedAt" IS NOT NULL
      OR OLD."agreementCountersignedAt" IS NOT NULL;
  ELSE
    agreement_exists_old := FALSE;
  END IF;

  explicit_return_to_review :=
    TG_OP = 'UPDATE'
    AND OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'UNDER_REVIEW'
    AND NEW."approvedAt" IS NULL
    AND NEW."approvedById" IS NULL
    AND NEW."approvedPasqDocumentSha256" IS NULL
    AND NEW."pasqVersion" IS NULL
    AND NEW."pasqGeneratedAt" IS NULL
    AND NEW."pasqDocumentId" IS NULL
    AND NEW."pasqDocumentSha256" IS NULL
    AND NEW."pasqEvidence" IS NULL
    AND NEW."pasqEvidenceSha256" IS NULL
    AND NEW."pasqAcknowledgedAt" IS NULL
    AND NEW."pasqAcknowledgedBy" IS NULL
    AND NEW."pasqAcknowledgedSha256" IS NULL
    AND NEW."creditLifeElection"
      IS NOT DISTINCT FROM OLD."creditLifeElection"
    AND NEW."creditLifeProductId"
      IS NOT DISTINCT FROM OLD."creditLifeProductId"
    AND NEW."creditLifeProductName"
      IS NOT DISTINCT FROM OLD."creditLifeProductName"
    AND NEW."creditLifeInsurerId"
      IS NOT DISTINCT FROM OLD."creditLifeInsurerId"
    AND NEW."creditLifeInsurerName"
      IS NOT DISTINCT FROM OLD."creditLifeInsurerName"
    AND NEW."creditLifeMonthlyPremiumCents"
      IS NOT DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
    AND NEW."creditLifeDisclosureVersion"
      IS NOT DISTINCT FROM OLD."creditLifeDisclosureVersion"
    AND NEW."creditLifeDisclosureSha256"
      IS NOT DISTINCT FROM OLD."creditLifeDisclosureSha256"
    AND NEW."creditLifeDisclosureAcknowledgedAt"
      IS NOT DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
    AND NEW."creditLifeDisclosureAcknowledgedBy"
      IS NOT DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy";

  -- The only window in which PASQ evidence may be written or replaced:
  -- APPROVED, no agreement artefact before or after the write.
  ceremony_open :=
    TG_OP = 'UPDATE'
    AND OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'APPROVED'
    AND NOT agreement_exists_old
    AND NOT agreement_exists_new;

  IF TG_OP = 'UPDATE' AND OLD."status"::TEXT IN ('APPROVED', 'DISBURSED') THEN
    IF NEW."status"::TEXT NOT IN ('APPROVED', 'DISBURSED') THEN
      IF NOT explicit_return_to_review THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Approved PASQ evidence may only be invalidated by the explicit return-to-review transition';
      END IF;
    ELSIF agreement_exists_old AND NOT agreement_exists_new THEN
      -- Retracting the anchor is how the ceremony would be reopened under a
      -- contract that already exists. Tearing the agreement down is legal only
      -- through the return-to-review transition above, which also drops the row
      -- out of APPROVED/DISBURSED.
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Agreement artefacts may not be retracted while the application is approved or disbursed; PASQ evidence is immutable once an agreement exists';

    ELSIF (
      -- One-packet ceremony: an unsigned agreement draft already exists and
      -- this exact statement both acknowledges its source PASQ and records the
      -- consumer signature. A standalone staff acknowledgement remains
      -- forbidden after packet preparation.
      TG_OP = 'UPDATE'
      AND OLD."status"::TEXT = 'APPROVED'
      AND NEW."status"::TEXT = 'APPROVED'
      AND OLD."agreementGeneratedAt" IS NOT NULL
      AND NEW."agreementGeneratedAt"
        IS NOT DISTINCT FROM OLD."agreementGeneratedAt"
      AND OLD."agreementSignedAt" IS NULL
      AND OLD."agreementCountersignedAt" IS NULL
      AND NEW."agreementSignedAt" IS NOT NULL
      AND NEW."agreementSignedAt" >= NEW."pasqGeneratedAt"
      AND NEW."agreementCountersignedAt" IS NULL
      AND OLD."pasqAcknowledgedAt" IS NULL
      AND OLD."pasqAcknowledgedBy" IS NULL
      AND OLD."pasqAcknowledgedSha256" IS NULL
      AND OLD."approvedPasqDocumentSha256" IS NULL
      AND NEW."pasqAcknowledgedAt" IS NOT NULL
      AND NEW."pasqAcknowledgedAt" >= NEW."pasqGeneratedAt"
      AND NEW."pasqAcknowledgedBy" = NEW."clientId"
      AND NEW."pasqAcknowledgedSha256" = NEW."pasqDocumentSha256"
      AND NEW."approvedPasqDocumentSha256" = NEW."pasqDocumentSha256"
      AND NEW."pasqVersion" IS NOT DISTINCT FROM OLD."pasqVersion"
      AND NEW."pasqGeneratedAt" IS NOT DISTINCT FROM OLD."pasqGeneratedAt"
      AND NEW."pasqDocumentId" IS NOT DISTINCT FROM OLD."pasqDocumentId"
      AND NEW."pasqDocumentSha256"
        IS NOT DISTINCT FROM OLD."pasqDocumentSha256"
      AND NEW."pasqEvidence" IS NOT DISTINCT FROM OLD."pasqEvidence"
      AND NEW."pasqEvidenceSha256"
        IS NOT DISTINCT FROM OLD."pasqEvidenceSha256"
      AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt"
      AND NEW."approvedById" IS NOT DISTINCT FROM OLD."approvedById"
      AND NEW."creditLifeElection"
        IS NOT DISTINCT FROM OLD."creditLifeElection"
      AND NEW."creditLifeProductId"
        IS NOT DISTINCT FROM OLD."creditLifeProductId"
      AND NEW."creditLifeProductName"
        IS NOT DISTINCT FROM OLD."creditLifeProductName"
      AND NEW."creditLifeInsurerId"
        IS NOT DISTINCT FROM OLD."creditLifeInsurerId"
      AND NEW."creditLifeInsurerName"
        IS NOT DISTINCT FROM OLD."creditLifeInsurerName"
      AND NEW."creditLifeMonthlyPremiumCents"
        IS NOT DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
      AND NEW."creditLifeDisclosureVersion"
        IS NOT DISTINCT FROM OLD."creditLifeDisclosureVersion"
      AND NEW."creditLifeDisclosureSha256"
        IS NOT DISTINCT FROM OLD."creditLifeDisclosureSha256"
      AND NEW."creditLifeDisclosureAcknowledgedAt"
        IS NOT DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
      AND NEW."creditLifeDisclosureAcknowledgedBy"
        IS NOT DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy"
    ) THEN
      NULL;
    ELSIF ceremony_open THEN
      -- PASQ evidence is being written by the ceremony. Approval attribution
      -- and the credit-life disclosure the quotation restates must still not
      -- move underneath it.
      IF (
        NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
        OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
        OR NEW."creditLifeElection" IS DISTINCT FROM OLD."creditLifeElection"
        OR NEW."creditLifeProductId" IS DISTINCT FROM OLD."creditLifeProductId"
        OR NEW."creditLifeProductName"
          IS DISTINCT FROM OLD."creditLifeProductName"
        OR NEW."creditLifeInsurerId" IS DISTINCT FROM OLD."creditLifeInsurerId"
        OR NEW."creditLifeInsurerName"
          IS DISTINCT FROM OLD."creditLifeInsurerName"
        OR NEW."creditLifeMonthlyPremiumCents"
          IS DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
        OR NEW."creditLifeDisclosureVersion"
          IS DISTINCT FROM OLD."creditLifeDisclosureVersion"
        OR NEW."creditLifeDisclosureSha256"
          IS DISTINCT FROM OLD."creditLifeDisclosureSha256"
        OR NEW."creditLifeDisclosureAcknowledgedAt"
          IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
        OR NEW."creditLifeDisclosureAcknowledgedBy"
          IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy"
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Approval attribution is immutable after approval; credit-life evidence is immutable after approval';
      END IF;
    ELSIF (
      NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
      OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
      OR NEW."pasqVersion" IS DISTINCT FROM OLD."pasqVersion"
      OR NEW."pasqGeneratedAt" IS DISTINCT FROM OLD."pasqGeneratedAt"
      OR NEW."pasqDocumentId" IS DISTINCT FROM OLD."pasqDocumentId"
      OR NEW."pasqDocumentSha256" IS DISTINCT FROM OLD."pasqDocumentSha256"
      OR NEW."pasqEvidence" IS DISTINCT FROM OLD."pasqEvidence"
      OR NEW."pasqEvidenceSha256" IS DISTINCT FROM OLD."pasqEvidenceSha256"
      OR NEW."pasqAcknowledgedAt" IS DISTINCT FROM OLD."pasqAcknowledgedAt"
      OR NEW."pasqAcknowledgedBy" IS DISTINCT FROM OLD."pasqAcknowledgedBy"
      OR NEW."pasqAcknowledgedSha256"
        IS DISTINCT FROM OLD."pasqAcknowledgedSha256"
      OR NEW."approvedPasqDocumentSha256"
        IS DISTINCT FROM OLD."approvedPasqDocumentSha256"
      OR NEW."creditLifeElection" IS DISTINCT FROM OLD."creditLifeElection"
      OR NEW."creditLifeProductId" IS DISTINCT FROM OLD."creditLifeProductId"
      OR NEW."creditLifeProductName"
        IS DISTINCT FROM OLD."creditLifeProductName"
      OR NEW."creditLifeInsurerId" IS DISTINCT FROM OLD."creditLifeInsurerId"
      OR NEW."creditLifeInsurerName"
        IS DISTINCT FROM OLD."creditLifeInsurerName"
      OR NEW."creditLifeMonthlyPremiumCents"
        IS DISTINCT FROM OLD."creditLifeMonthlyPremiumCents"
      OR NEW."creditLifeDisclosureVersion"
        IS DISTINCT FROM OLD."creditLifeDisclosureVersion"
      OR NEW."creditLifeDisclosureSha256"
        IS DISTINCT FROM OLD."creditLifeDisclosureSha256"
      OR NEW."creditLifeDisclosureAcknowledgedAt"
        IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedAt"
      OR NEW."creditLifeDisclosureAcknowledgedBy"
        IS DISTINCT FROM OLD."creditLifeDisclosureAcknowledgedBy"
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Approval attribution is immutable after approval; PASQ evidence is immutable after approval; credit-life evidence is immutable after approval';
    END IF;
  END IF;

  IF NEW."status"::TEXT = 'DRAFT' AND (
    NEW."pasqVersion" IS NOT NULL
    OR NEW."pasqGeneratedAt" IS NOT NULL
    OR NEW."pasqDocumentId" IS NOT NULL
    OR NEW."pasqDocumentSha256" IS NOT NULL
    OR NEW."pasqEvidence" IS NOT NULL
    OR NEW."pasqEvidenceSha256" IS NOT NULL
    OR NEW."pasqAcknowledgedAt" IS NOT NULL
    OR NEW."pasqAcknowledgedBy" IS NOT NULL
    OR NEW."pasqAcknowledgedSha256" IS NOT NULL
    OR NEW."approvedPasqDocumentSha256" IS NOT NULL
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Draft applications may not retain PASQ or acknowledgement evidence';
  END IF;

  -- Intact-document requirement. Skipped ONLY for a pre-ceremony APPROVED
  -- application that claims no quotation at all; any claimed binding, any
  -- agreement artefact, and every DISBURSED row must still resolve to an intact
  -- bound PDF.
  IF NEW."status"::TEXT IN ('APPROVED', 'DISBURSED')
    AND (
      NEW."status"::TEXT = 'DISBURSED'
      OR agreement_exists_new
      OR NEW."pasqDocumentId" IS NOT NULL
      OR NEW."pasqDocumentSha256" IS NOT NULL
      OR NEW."pasqAcknowledgedAt" IS NOT NULL
      OR NEW."approvedPasqDocumentSha256" IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "ClientDocument" AS document
      WHERE document."id" = NEW."pasqDocumentId"
        AND document."tenantId" = NEW."tenantId"
        AND document."clientId" = NEW."clientId"
        AND document."docType"::TEXT = 'FORM_20_PRE_AGREEMENT'
        AND document."deletedAt" IS NULL
        AND document."storagePath" IS NOT NULL
        AND LENGTH(BTRIM(document."storagePath")) > 0
        AND document."mimeType" = 'application/pdf'
        AND document."fileSize" IS NOT NULL
        AND document."fileSize" > 0
        AND document."contentSha256" = NEW."pasqDocumentSha256"
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Approval requires intact application-bound PASQ document metadata';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationProviderCountersign"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  explicit_return_to_review BOOLEAN;
  expected_provider_signature_sha256 TEXT;
  expected_consumer_signature_sha256 TEXT;
  expected_envelope_sha256 TEXT;
BEGIN
  explicit_return_to_review :=
    TG_OP = 'UPDATE'
    AND OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'UNDER_REVIEW'
    AND NEW."agreementGeneratedAt" IS NULL
    AND NEW."agreementDocumentId" IS NULL
    AND NEW."agreementDocumentSha256" IS NULL
    AND NEW."agreementSignedAt" IS NULL
    AND NEW."agreementSignedMethod" IS NULL
    AND NEW."agreementSignedByUserId" IS NULL
    AND NEW."agreementSignatureData" IS NULL
    AND NEW."agreementCountersignedAt" IS NULL
    AND NEW."agreementCountersignedById" IS NULL
    AND NEW."agreementCountersignedByName" IS NULL
    AND NEW."agreementCountersignedByEmail" IS NULL
    AND NEW."agreementCountersignatureData" IS NULL
    AND NEW."agreementCountersignatureSha256" IS NULL
    AND NEW."agreementCountersignatureEnvelopeSha256" IS NULL
    AND NEW."agreementCountersignedDocumentSha256" IS NULL;

  IF NEW."agreementCountersignatureData" IS NOT NULL THEN
    expected_provider_signature_sha256 := encode(
      sha256(convert_to(NEW."agreementCountersignatureData", 'UTF8')),
      'hex'
    );
  END IF;
  IF NEW."agreementSignatureData" IS NOT NULL THEN
    expected_consumer_signature_sha256 := encode(
      sha256(convert_to(NEW."agreementSignatureData", 'UTF8')),
      'hex'
    );
  END IF;
  IF
    expected_provider_signature_sha256 IS NOT NULL
    AND expected_consumer_signature_sha256 IS NOT NULL
  THEN
    expected_envelope_sha256 := "providerCountersignEnvelopeSha256"(
      NEW."tenantId",
      NEW."id",
      NEW."clientId",
      NEW."agreementDocumentSha256",
      NEW."agreementSignedAt",
      NEW."agreementSignedMethod",
      CASE
        WHEN NEW."agreementSignedMethod" = 'portal' THEN NEW."clientId"
        ELSE NEW."agreementSignedByUserId"
      END,
      expected_consumer_signature_sha256,
      NEW."agreementCountersignedAt",
      NEW."agreementCountersignedById",
      NEW."agreementCountersignedByName",
      NEW."agreementCountersignedByEmail",
      expected_provider_signature_sha256
    );
  END IF;

  IF NEW."status"::TEXT = 'DISBURSED' AND NOT "validOutageDisbursementException"(NEW."tenantId", NEW."id", NEW."reference", NEW."disbursedAt", NEW."disbursementExceptionId") AND (
    NEW."agreementDocumentSha256" IS NULL
    OR NEW."agreementDocumentSha256" !~ '^[0-9a-f]{64}$'
    OR NEW."agreementSignedAt" IS NULL
    OR NEW."agreementSignedMethod" IS NULL
    OR NEW."agreementSignedMethod" NOT IN ('portal', 'branch')
    OR NEW."agreementSignatureData" IS NULL
    OR LENGTH(BTRIM(NEW."agreementSignatureData")) = 0
    OR (
      NEW."agreementSignedMethod" = 'portal'
      AND NEW."agreementSignedByUserId" IS NOT NULL
    )
    OR (
      NEW."agreementSignedMethod" = 'branch'
      AND (
        NEW."agreementSignedByUserId" IS NULL
        OR LENGTH(BTRIM(NEW."agreementSignedByUserId")) = 0
      )
    )
    OR NEW."agreementCountersignedAt" IS NULL
    OR NEW."agreementCountersignedById" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignedById")) = 0
    OR NEW."agreementCountersignedByName" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignedByName")) = 0
    OR NEW."agreementCountersignedByEmail" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignedByEmail")) = 0
    OR NEW."agreementCountersignatureData" IS NULL
    OR LENGTH(BTRIM(NEW."agreementCountersignatureData")) = 0
    OR NEW."agreementCountersignatureSha256"
      IS DISTINCT FROM expected_provider_signature_sha256
    OR NEW."agreementCountersignatureEnvelopeSha256"
      IS DISTINCT FROM expected_envelope_sha256
    OR NEW."agreementCountersignedDocumentSha256" IS NULL
    OR NEW."agreementCountersignedDocumentSha256" !~ '^[0-9a-f]{64}$'
    OR NEW."agreementCountersignedAt" < NEW."agreementSignedAt"
    OR NEW."agreementCountersignedDocumentSha256"
      IS DISTINCT FROM NEW."agreementDocumentSha256"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan disbursement requires provider countersign evidence bound to the exact tenant, consumer signature and agreement';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD."agreementCountersignedAt" IS NOT NULL AND (
    NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."agreementDocumentId" IS DISTINCT FROM OLD."agreementDocumentId"
    OR NEW."agreementDocumentSha256" IS DISTINCT FROM OLD."agreementDocumentSha256"
    OR NEW."agreementSignedAt" IS DISTINCT FROM OLD."agreementSignedAt"
    OR NEW."agreementSignedMethod" IS DISTINCT FROM OLD."agreementSignedMethod"
    OR NEW."agreementSignedByUserId" IS DISTINCT FROM OLD."agreementSignedByUserId"
    OR NEW."agreementSignatureData" IS DISTINCT FROM OLD."agreementSignatureData"
    OR NEW."agreementCountersignedAt" IS DISTINCT FROM OLD."agreementCountersignedAt"
    OR NEW."agreementCountersignedById" IS DISTINCT FROM OLD."agreementCountersignedById"
    OR NEW."agreementCountersignedByName" IS DISTINCT FROM OLD."agreementCountersignedByName"
    OR NEW."agreementCountersignedByEmail" IS DISTINCT FROM OLD."agreementCountersignedByEmail"
    OR NEW."agreementCountersignatureData" IS DISTINCT FROM OLD."agreementCountersignatureData"
    OR NEW."agreementCountersignatureSha256" IS DISTINCT FROM OLD."agreementCountersignatureSha256"
    OR NEW."agreementCountersignatureEnvelopeSha256"
      IS DISTINCT FROM OLD."agreementCountersignatureEnvelopeSha256"
    OR NEW."agreementCountersignedDocumentSha256"
      IS DISTINCT FROM OLD."agreementCountersignedDocumentSha256"
  ) AND NOT explicit_return_to_review THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Consumer and provider signature evidence is immutable after provider countersign';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationProviderSignerTenant"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  locked_signer_id TEXT;
BEGIN
  IF NEW."agreementCountersignedAt" IS NULL THEN
    RETURN NEW;
  END IF;

  -- Signer authority is evidence about the instant of countersignature. Once
  -- recorded, later deactivation or role changes must not freeze unrelated
  -- lifecycle updates on the application.
  IF TG_OP = 'UPDATE' AND NOT (
    NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."agreementCountersignedAt"
      IS DISTINCT FROM OLD."agreementCountersignedAt"
    OR NEW."agreementCountersignedById"
      IS DISTINCT FROM OLD."agreementCountersignedById"
    OR NEW."agreementCountersignedByName"
      IS DISTINCT FROM OLD."agreementCountersignedByName"
    OR NEW."agreementCountersignedByEmail"
      IS DISTINCT FROM OLD."agreementCountersignedByEmail"
  ) THEN
    RETURN NEW;
  END IF;

  SELECT signer."id"
  INTO locked_signer_id
  FROM "User" AS signer
  WHERE signer."id" = NEW."agreementCountersignedById"
    AND signer."tenantId" = NEW."tenantId"
    AND signer."active" = TRUE
    AND signer."role" IN (
      'LOAN_ADMIN'::"UserRole",
      'BRANCH_MANAGER'::"UserRole",
      'ADMIN'::"UserRole",
      'SUPER_ADMIN'::"UserRole"
    )
    AND signer."email" = NEW."agreementCountersignedByEmail"
    AND COALESCE(NULLIF(BTRIM(signer."name"), ''), signer."email")
      = NEW."agreementCountersignedByName"
  FOR SHARE;

  IF locked_signer_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Provider countersign requires an active authorised signer from the application tenant';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationRepaymentMethod"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."repaymentMethod" IS NOT NULL
    AND NEW."repaymentMethod" IS DISTINCT FROM OLD."repaymentMethod"
    AND NOT (
      OLD."status" = 'APPROVED'::"AppStatus"
      AND NEW."status" = 'UNDER_REVIEW'::"AppStatus"
      AND NEW."repaymentMethod" IS NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Approved repayment method is immutable; return the application to review before changing it';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanApplicationTenantBinding"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "Client" AS client
    WHERE client."id" = NEW."clientId"
      AND client."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan application client must belong to the application tenant';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "LoanProduct" AS product
    WHERE product."id" = NEW."productId"
      AND product."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan application product must belong to the application tenant';
  END IF;

  IF
    NEW."status"::TEXT IN ('APPROVED', 'DISBURSED')
    AND NEW."pasqDocumentId" IS NOT NULL
    AND NOT EXISTS (
    SELECT 1
    FROM "ClientDocument" AS document
    WHERE document."id" = NEW."pasqDocumentId"
      AND document."tenantId" = NEW."tenantId"
      AND document."clientId" = NEW."clientId"
      AND document."docType"::TEXT = 'FORM_20_PRE_AGREEMENT'
      AND document."deletedAt" IS NULL
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan application PASQ must belong to the application tenant and client';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanPasqV3Billing"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- Outage loans first. Their guard covers columns the billing early return
  -- below does not name -- the balances, the rate, the interest model -- so
  -- asking "did a billing column change?" ahead of this would skip it for
  -- exactly the writes band 2 of validateOutageDisbursementLoan exists
  -- to catch.
  IF EXISTS (
    SELECT 1
    FROM "LoanApplication" AS application
    WHERE application."id" = NEW."applicationId"
      AND "validOutageDisbursementException"(
        application."tenantId",
        application."id",
        application."reference",
        application."disbursedAt",
        application."disbursementExceptionId"
      )
  ) THEN
    PERFORM "validateOutageDisbursementLoan"(NEW."id");
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
    OR OLD."applicationId" IS DISTINCT FROM NEW."applicationId"
    OR OLD."clientId" IS DISTINCT FROM NEW."clientId"
    OR OLD."productId" IS DISTINCT FROM NEW."productId"
    OR OLD."principal" IS DISTINCT FROM NEW."principal"
    OR OLD."totalInterest" IS DISTINCT FROM NEW."totalInterest"
    OR OLD."initiationFee" IS DISTINCT FROM NEW."initiationFee"
    OR OLD."creditLifePremiums" IS DISTINCT FROM NEW."creditLifePremiums"
    OR OLD."totalRepayable" IS DISTINCT FROM NEW."totalRepayable"
    OR OLD."contractualTotalInterest"
      IS DISTINCT FROM NEW."contractualTotalInterest"
    OR OLD."contractualTotalRepayable"
      IS DISTINCT FROM NEW."contractualTotalRepayable"
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM "validateLoanPasqV3Billing"(NEW."id");
  IF TG_OP = 'UPDATE' AND OLD."id" IS DISTINCT FROM NEW."id" THEN
    PERFORM "validateLoanPasqV3Billing"(OLD."id");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardLoanPasqV3ScheduleDates"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
    OR OLD."applicationId" IS DISTINCT FROM NEW."applicationId"
    OR OLD."startDate" IS DISTINCT FROM NEW."startDate"
    OR OLD."maturityDate" IS DISTINCT FROM NEW."maturityDate"
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "LoanApplication" AS application
    WHERE application."id" = NEW."applicationId"
      AND "validOutageDisbursementException"(
        application."tenantId",
        application."id",
        application."reference",
        application."disbursedAt",
        application."disbursementExceptionId"
      )
  ) THEN
    PERFORM "validateOutageDisbursementLoan"(NEW."id");
    RETURN NEW;
  END IF;

  PERFORM "validateLoanPasqV3ScheduleDates"(NEW."id");
  IF TG_OP = 'UPDATE' AND OLD."id" IS DISTINCT FROM NEW."id" THEN
    PERFORM "validateLoanPasqV3ScheduleDates"(OLD."id");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardOutageDisbursementExceptionRecord"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."type" = 'DISBURSEMENT_EXCEPTION'::"ComplianceType"
       AND NOT "validOutageDisbursementExceptionValues"(
         NEW."tenantId",
         NEW."id",
         NEW."type",
         NEW."referenceId",
         NEW."idempotencyKey",
         NEW."status",
         NEW."completedAt",
         NEW."data"
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Outage disbursement exception evidence is invalid';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."type" = 'DISBURSEMENT_EXCEPTION'::"ComplianceType"
     OR (
       TG_OP = 'UPDATE'
       AND NEW."type" = 'DISBURSEMENT_EXCEPTION'::"ComplianceType"
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Completed outage disbursement exception evidence is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardRepaymentSchedulePasqV3Billing"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_loan_id TEXT;
BEGIN
  target_loan_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD."loanId"
    ELSE NEW."loanId"
  END;

  IF EXISTS (
    SELECT 1
    FROM "Loan" AS loan
    JOIN "LoanApplication" AS application
      ON application."id" = loan."applicationId"
    WHERE loan."id" = target_loan_id
      AND "validOutageDisbursementException"(
        application."tenantId",
        application."id",
        application."reference",
        application."disbursedAt",
        application."disbursementExceptionId"
      )
  ) THEN
    PERFORM "validateOutageDisbursementLoan"(target_loan_id);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM "validateLoanPasqV3Billing"(OLD."loanId");
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
    OR OLD."loanId" IS DISTINCT FROM NEW."loanId"
    OR OLD."installmentNo" IS DISTINCT FROM NEW."installmentNo"
    OR OLD."principalDue" IS DISTINCT FROM NEW."principalDue"
    OR OLD."interestDue" IS DISTINCT FROM NEW."interestDue"
    OR OLD."creditLifePremiumDue"
      IS DISTINCT FROM NEW."creditLifePremiumDue"
    OR OLD."feesDue" IS DISTINCT FROM NEW."feesDue"
    OR OLD."totalDue" IS DISTINCT FROM NEW."totalDue"
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM "validateLoanPasqV3Billing"(NEW."loanId");
  IF TG_OP = 'UPDATE' AND OLD."loanId" IS DISTINCT FROM NEW."loanId" THEN
    PERFORM "validateLoanPasqV3Billing"(OLD."loanId");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardRepaymentSchedulePasqV3Dates"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_loan_id TEXT;
BEGIN
  target_loan_id := CASE WHEN TG_OP = 'DELETE'
    THEN OLD."loanId"
    ELSE NEW."loanId"
  END;

  IF EXISTS (
    SELECT 1
    FROM "Loan" AS loan
    JOIN "LoanApplication" AS application
      ON application."id" = loan."applicationId"
    WHERE loan."id" = target_loan_id
      AND "validOutageDisbursementException"(
        application."tenantId",
        application."id",
        application."reference",
        application."disbursedAt",
        application."disbursementExceptionId"
      )
  ) THEN
    PERFORM "validateOutageDisbursementLoan"(target_loan_id);
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM "validateLoanPasqV3ScheduleDates"(OLD."loanId");
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND NOT (
    OLD."id" IS DISTINCT FROM NEW."id"
    OR OLD."tenantId" IS DISTINCT FROM NEW."tenantId"
    OR OLD."loanId" IS DISTINCT FROM NEW."loanId"
    OR OLD."installmentNo" IS DISTINCT FROM NEW."installmentNo"
    OR OLD."dueDate" IS DISTINCT FROM NEW."dueDate"
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM "validateLoanPasqV3ScheduleDates"(NEW."loanId");
  IF TG_OP = 'UPDATE' AND OLD."loanId" IS DISTINCT FROM NEW."loanId" THEN
    PERFORM "validateLoanPasqV3ScheduleDates"(OLD."loanId");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardSignedDebitMandateArtifact"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."docType" = 'DEBIT_MANDATE'::"DocType"
    AND OLD."signatureState" = 'signed'
    AND OLD."signedAt" IS NOT NULL
  THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Signed debit-mandate documents are immutable';
    ELSIF TO_JSONB(NEW) IS DISTINCT FROM TO_JSONB(OLD) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Signed debit-mandate documents are immutable';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardSignedDebitMandateAuthority"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  explicit_return_to_review BOOLEAN;
  expected_review_affordability JSONB;
  old_approval_history JSONB;
  old_contract_history JSONB;
  old_approval_history_present BOOLEAN;
  old_contract_history_present BOOLEAN;
  old_approval JSONB;
  new_approval JSONB;
  old_contract JSONB;
  new_contract JSONB;
  active_return_to_review BOOLEAN;
  approval_install_allowed BOOLEAN;
  contract_install_allowed BOOLEAN;
BEGIN
  old_approval := OLD."affordabilityResult" -> 'approval';
  new_approval := NEW."affordabilityResult" -> 'approval';
  old_contract := OLD."affordabilityResult" -> 'contract';
  new_contract := NEW."affordabilityResult" -> 'contract';

  active_return_to_review := COALESCE((
    OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'UNDER_REVIEW'
    AND NEW."approvedAt" IS NULL
    AND NEW."approvedById" IS NULL
    AND NEW."approvedAmount" IS NULL
    AND NEW."approvedTermDays" IS NULL
    AND NEW."approvedRate" IS NULL
    AND NEW."decisionReason" IS NULL
    AND NEW."pasqVersion" IS NULL
    AND NEW."pasqGeneratedAt" IS NULL
    AND NEW."pasqDocumentId" IS NULL
    AND NEW."pasqDocumentSha256" IS NULL
    AND NEW."pasqEvidence" IS NULL
    AND NEW."pasqEvidenceSha256" IS NULL
    AND NEW."pasqAcknowledgedAt" IS NULL
    AND NEW."pasqAcknowledgedBy" IS NULL
    AND NEW."pasqAcknowledgedSha256" IS NULL
    AND NEW."approvedPasqDocumentSha256" IS NULL
    AND NEW."agreementGeneratedAt" IS NULL
    AND NEW."agreementDocumentId" IS NULL
    AND NEW."agreementDocumentSha256" IS NULL
    AND NEW."agreementSignedAt" IS NULL
    AND NEW."agreementCountersignedAt" IS NULL
  ), FALSE);

  IF new_approval IS DISTINCT FROM old_approval THEN
    approval_install_allowed := FALSE;
    IF JSONB_TYPEOF(new_approval) = 'object' THEN
      approval_install_allowed := COALESCE((
        OLD."status"::TEXT = 'UNDER_REVIEW'
        AND NEW."status"::TEXT = 'APPROVED'
        AND NEW."approvedAt" IS NOT NULL
        AND NEW."approvedById" IS NOT NULL
        AND NEW."approvedAmount" IS NOT NULL
        AND NEW."approvedTermDays" IS NOT NULL
        AND NEW."approvedRate" IS NOT NULL
        AND (
          -- NCA s.92(1) attaches the quotation to ENTERING INTO the agreement,
          -- not to the credit decision. Under ceremony sequencing no quotation
          -- exists at approval, so these bindings apply only once one does.
          COALESCE(JSONB_TYPEOF(NEW."pasqEvidence"), 'null') = 'null'
          OR (
            NEW."pasqVersion" = 'pasq-v3'
            AND JSONB_TYPEOF(NEW."pasqEvidence") = 'object'
            AND "pasqEvidenceSha256V3"(NEW."pasqEvidence")
              = NEW."pasqEvidenceSha256"
            AND NEW."approvedPasqDocumentSha256"
              = NEW."pasqDocumentSha256"
          )
        )
        AND NEW."affordabilityResult" ->> 'schemaVersion' = '3'
        AND new_approval ->> 'stage' = 'APPROVAL'
        AND new_approval ->> 'policyVersion' = 'approval-ndi-v3'
        AND "approvalEvidenceIsIntact"(new_approval)
        AND "approvalFinancialsAreConsistent"(new_approval)
        AND new_approval ->> 'capturedById' = NEW."approvedById"
        AND new_approval ->> 'capturedAt' = TO_CHAR(
          NEW."approvedAt" AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
        AND new_approval #>> '{inputs,productId}' = NEW."productId"
        AND new_approval #>> '{inputs,principalCents}'
          = NEW."approvedAmount"::TEXT
        AND NEW."approvedAmount" = NEW."appliedAmount"
        AND new_approval #>> '{inputs,termDays}'
          = NEW."approvedTermDays"::TEXT
        AND NEW."approvedTermDays" = NEW."appliedTermDays"
        AND new_approval #>> '{inputs,interestRatePm}'
          = TO_JSONB(NEW."approvedRate")::TEXT
        AND new_approval #>> '{inputs,initiationFeePayment}'
          = NEW."initiationFeePayment"::TEXT
        AND new_approval #>> '{calculator,principalCents}'
          = NEW."approvedAmount"::TEXT
        AND (
          -- The approval snapshot used to be forced to share ONE calculator
          -- object with the PASQ, which is what made pasqGeneratedAt the
          -- approval anchor. Approval now anchors on approvedAt and the
          -- quotation is issued later, so the two can no longer be identical.
          -- Where a PASQ IS present at approval the original identity rule is
          -- kept verbatim; where it is not, the ceremony window's
          -- pricing-fingerprint clause reconciles them when the quotation is
          -- eventually issued.
          COALESCE(JSONB_TYPEOF(NEW."pasqEvidence"), 'null') = 'null'
          OR (
            new_approval #> '{calculator}'
              IS NOT DISTINCT FROM NEW."pasqEvidence" -> 'calculator'
            AND NEW."pasqEvidence" ->> 'termDays'
              = NEW."approvedTermDays"::TEXT
          )
        )
        AND new_approval #>> '{outcome,isAffordable}' = 'true'
        AND NEW."totalExistingDebt"::TEXT
          = new_approval #>> '{inputs,declaredDebtCents}'
        AND NEW."netDisposableIncome"::TEXT
          = new_approval #>> '{outcome,netDisposableIncomeCents}'
        AND NEW."affordabilityNDI"::TEXT
          = new_approval #>> '{outcome,ndiAfterLoanCents}'
        AND new_approval ->> 'inputFingerprint'
          ~ '^[0-9a-f]{64}$'
        AND new_approval ->> 'decisionFingerprint'
          ~ '^[0-9a-f]{64}$'
        AND new_approval #>> '{expenses,fingerprint}'
          ~ '^[0-9a-f]{64}$'
        AND new_approval #>> '{debts,applicationFingerprint}'
          ~ '^[0-9a-f]{64}$'
        AND new_approval #>> '{debts,clientFingerprint}'
          ~ '^[0-9a-f]{64}$'
        AND (
          new_approval - ARRAY[
            'stage',
            'policyVersion',
            'capturedAt',
            'capturedById',
            'inputs',
            'debts',
            'expenses',
            'bureauEvidence',
            'calculator',
            'outcome',
            'inputFingerprint',
            'decisionFingerprint'
          ]
        ) = '{}'::JSONB
        AND EXISTS (
          SELECT 1
          FROM "LoanProduct" AS product
          WHERE product."id" = NEW."productId"
            AND product."tenantId" = NEW."tenantId"
            AND new_approval #>> '{inputs,interestRatePm}'
              = TO_JSONB(product."interestRatePm")::TEXT
            AND new_approval #>> '{inputs,interestModel}'
              = product."interestModel"::TEXT
            AND new_approval #>> '{inputs,initiationFeeModel}'
              = product."initiationFeeModel"::TEXT
            AND new_approval #>> '{inputs,initiationFeePct}'
              = TO_JSONB(product."initiationFeePct")::TEXT
            AND new_approval #>> '{inputs,initiationFeeMaxCents}'
              = product."initiationFeeMax"::TEXT
            AND new_approval #>> '{inputs,monthlyServiceFeeCents}'
              = product."monthlyServiceFee"::TEXT
            AND new_approval #>> '{inputs,productType}'
              = product."productType"::TEXT
        )
        AND EXISTS (
          SELECT 1
          FROM "Client" AS client
          WHERE client."id" = NEW."clientId"
            AND client."tenantId" = NEW."tenantId"
            AND client."monthlyIncome"::TEXT
              = new_approval #>> '{inputs,monthlyIncomeCents}'
            AND client."monthlyExpenses"::TEXT
              = new_approval #>> '{inputs,monthlyExpensesCents}'
        )
      ), FALSE);

      IF NOT approval_install_allowed THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE =
            'Active approval evidence requires a validated approval transition';
      END IF;
    ELSIF JSONB_TYPEOF(old_approval) = 'object'
      AND NOT active_return_to_review
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Active approval evidence may only be cleared by return to review';
    ELSIF COALESCE(
      JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
        AND NEW."affordabilityResult" ? 'approval',
      FALSE
    )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Active approval evidence must be an object';
    END IF;
  END IF;

  IF new_contract IS DISTINCT FROM old_contract THEN
    contract_install_allowed := FALSE;
    IF JSONB_TYPEOF(new_contract) = 'object' THEN
      IF COALESCE((
        OLD."status"::TEXT = 'APPROVED'
        AND NEW."status"::TEXT = 'APPROVED'
        AND OLD."agreementSignedAt" IS NULL
        AND NEW."agreementSignedAt" IS NULL
        AND NEW."agreementGeneratedAt" IS NOT NULL
        AND NEW."agreementDocumentId" IS NOT NULL
        AND LENGTH(BTRIM(NEW."agreementDocumentId")) > 0
        AND NEW."agreementDocumentSha256" ~ '^[0-9a-f]{64}$'
        AND (
          NEW."agreementGeneratedAt"
            IS DISTINCT FROM OLD."agreementGeneratedAt"
          OR NEW."agreementDocumentId"
            IS DISTINCT FROM OLD."agreementDocumentId"
          OR NEW."agreementDocumentSha256"
            IS DISTINCT FROM OLD."agreementDocumentSha256"
        )
        AND JSONB_TYPEOF(new_approval) = 'object'
        AND JSONB_TYPEOF(new_contract -> 'calculator') = 'object'
        AND JSONB_TYPEOF(
          new_contract #> '{calculator,schedule}'
        ) = 'array'
        AND JSONB_TYPEOF(
          NEW."pasqEvidence" #> '{calculator,schedule}'
        ) = 'array'
        AND new_contract ->> 'version' = 'affordability-contract-v2'
        AND new_contract ->> 'establishedAt' = TO_CHAR(
          NEW."agreementGeneratedAt" AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
        AND new_contract #>> '{calculator,startDate}'
          = new_contract ->> 'establishedAt'
        AND new_contract ->> 'acceptedPasqDocumentSha256'
          = NEW."pasqDocumentSha256"
        AND new_contract ->> 'acceptedPasqContractFingerprint'
          = NEW."pasqEvidence" #>> '{calculator,contractFingerprint}'
        AND new_contract ->> 'quotePresentedAt'
          = NEW."pasqEvidence" #>> '{calculator,startDate}'
        AND new_contract ->> 'quoteValidUntilDate'
          ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        AND new_contract ->> 'quoteValidUntilDate'
          = TO_CHAR(
            "quoteValidUntilDate"(
              (
                NEW."pasqEvidence" #>> '{calculator,startDate}'
              )::TIMESTAMPTZ
            ),
            'YYYY-MM-DD'
          )
        AND NEW."agreementGeneratedAt" >= (
          (
            NEW."pasqEvidence" #>> '{calculator,startDate}'
          )::TIMESTAMPTZ AT TIME ZONE 'UTC'
        )
        AND (
          NEW."agreementGeneratedAt" AT TIME ZONE 'UTC'
            AT TIME ZONE 'Africa/Johannesburg'
        )::DATE <= "quoteValidUntilDate"(
          (
            NEW."pasqEvidence" #>> '{calculator,startDate}'
          )::TIMESTAMPTZ
        )
        AND new_contract ->> 'approvalDecisionFingerprint'
          = new_approval ->> 'decisionFingerprint'
        -- The quotation must price what was actually approved. Under the old
        -- sequencing the approval snapshot and the PASQ shared one calculator
        -- OBJECT, so this was free; the two are now built at different instants
        -- and can no longer be identical, so they are reconciled on the
        -- date-independent pricing fingerprint instead. Enforced at agreement
        -- generation, the moment NCA s.92(1) actually turns on: the contract
        -- being entered into must carry the approved price and the quoted one.
        AND "calculatorPricingSha256"(
          NEW."pasqEvidence" -> 'calculator'
        ) = "calculatorPricingSha256"(new_approval -> 'calculator')
        AND new_contract ->> 'fingerprint' ~ '^[0-9a-f]{64}$'
        AND new_contract ->> 'fingerprint'
          = "contractEvidenceSha256"(new_contract)
        AND new_contract #>> '{calculator,contractFingerprint}'
          ~ '^[0-9a-f]{64}$'
        AND new_contract #>> '{calculator,pricingFingerprint}'
          = "calculatorPricingSha256"(
            new_contract -> 'calculator'
          )
        AND new_contract #>> '{calculator,contractFingerprint}'
          = "calculatorContractSha256"(
            new_contract -> 'calculator'
          )
        AND (
          new_contract - ARRAY[
            'version',
            'establishedAt',
            'acceptedPasqDocumentSha256',
            'acceptedPasqContractFingerprint',
            'quotePresentedAt',
            'quoteValidUntilDate',
            'approvalDecisionFingerprint',
            'calculator',
            'fingerprint'
          ]
        ) = '{}'::JSONB
        AND (
          (new_contract -> 'calculator') - ARRAY[
            'startDate',
            'contractFingerprint',
            'schedule'
          ]
        ) IS NOT DISTINCT FROM (
          (NEW."pasqEvidence" -> 'calculator') - ARRAY[
            'startDate',
            'contractFingerprint',
            'schedule'
          ]
        )
        AND JSONB_ARRAY_LENGTH(
          new_contract #> '{calculator,schedule}'
        ) = JSONB_ARRAY_LENGTH(
          NEW."pasqEvidence" #> '{calculator,schedule}'
        )
      ), FALSE)
      THEN
        contract_install_allowed := NOT EXISTS (
          SELECT 1
          FROM JSONB_ARRAY_ELEMENTS(
            new_contract #> '{calculator,schedule}'
          ) WITH ORDINALITY AS contracted(value, ordinal)
          FULL JOIN JSONB_ARRAY_ELEMENTS(
            NEW."pasqEvidence" #> '{calculator,schedule}'
          ) WITH ORDINALITY AS quoted(value, ordinal)
            ON quoted.ordinal = contracted.ordinal
          WHERE contracted.value IS NULL
            OR quoted.value IS NULL
            OR contracted.value - 'dueDate'
              IS DISTINCT FROM quoted.value - 'dueDate'
            OR (
              (contracted.value ->> 'dueDate')::TIMESTAMPTZ
                AT TIME ZONE 'UTC'
            ) IS DISTINCT FROM (
              (
                (quoted.value ->> 'dueDate')::TIMESTAMPTZ
                  AT TIME ZONE 'UTC'
              )
              + (
                NEW."agreementGeneratedAt"
                - (
                  (
                    NEW."pasqEvidence"
                      #>> '{calculator,startDate}'
                  )::TIMESTAMPTZ AT TIME ZONE 'UTC'
                )
              )
            )
        );
      END IF;

      IF NOT contract_install_allowed THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE =
            'Active contract evidence requires validated agreement generation';
      END IF;
    ELSIF JSONB_TYPEOF(old_contract) = 'object'
      AND NOT active_return_to_review
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE =
          'Active contract evidence may only be cleared by return to review';
    ELSIF COALESCE(
      JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
        AND NEW."affordabilityResult" ? 'contract',
      FALSE
    )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Active contract evidence must be an object';
    END IF;
  END IF;

  -- Decision histories are immutable except for the exact route-shaped
  -- archive event: when active evidence changes, append that exact OLD
  -- object once. This remains enforced after mandate fields are cleared.
  old_approval_history_present := COALESCE(
    JSONB_TYPEOF(OLD."affordabilityResult") = 'object'
      AND OLD."affordabilityResult" ? 'approvalHistory',
    FALSE
  );
  old_contract_history_present := COALESCE(
    JSONB_TYPEOF(OLD."affordabilityResult") = 'object'
      AND OLD."affordabilityResult" ? 'contractHistory',
    FALSE
  );

  IF old_approval_history_present
    AND JSONB_TYPEOF(
      OLD."affordabilityResult" -> 'approvalHistory'
    ) IS DISTINCT FROM 'array'
  THEN
    IF NEW."affordabilityResult" -> 'approvalHistory'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'approvalHistory'
      OR NEW."affordabilityResult" -> 'approval'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'approval'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Archived approval evidence is immutable';
    END IF;
  ELSE
    old_approval_history := CASE
      WHEN old_approval_history_present
        THEN OLD."affordabilityResult" -> 'approvalHistory'
      ELSE '[]'::JSONB
    END;

    IF JSONB_TYPEOF(
      OLD."affordabilityResult" -> 'approval'
    ) = 'object'
      AND NEW."affordabilityResult" -> 'approval'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'approval'
    THEN
      IF NOT COALESCE(
        JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
          AND NEW."affordabilityResult" ? 'approvalHistory'
          AND NEW."affordabilityResult" -> 'approvalHistory'
            IS NOT DISTINCT FROM (
              old_approval_history
              || JSONB_BUILD_ARRAY(
                OLD."affordabilityResult" -> 'approval'
              )
            ),
        FALSE
      )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE =
            'Archived approval evidence must exactly record the replaced decision';
      END IF;
    ELSIF old_approval_history_present THEN
      IF NOT COALESCE(
        JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
          AND NEW."affordabilityResult" ? 'approvalHistory'
          AND NEW."affordabilityResult" -> 'approvalHistory'
            IS NOT DISTINCT FROM old_approval_history,
        FALSE
      )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Archived approval evidence is immutable';
      END IF;
    ELSIF COALESCE(
      JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
        AND NEW."affordabilityResult" ? 'approvalHistory',
      FALSE
    )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Archived approval evidence cannot be fabricated';
    END IF;
  END IF;

  IF old_contract_history_present
    AND JSONB_TYPEOF(
      OLD."affordabilityResult" -> 'contractHistory'
    ) IS DISTINCT FROM 'array'
  THEN
    IF NEW."affordabilityResult" -> 'contractHistory'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'contractHistory'
      OR NEW."affordabilityResult" -> 'contract'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'contract'
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Archived contract evidence is immutable';
    END IF;
  ELSE
    old_contract_history := CASE
      WHEN old_contract_history_present
        THEN OLD."affordabilityResult" -> 'contractHistory'
      ELSE '[]'::JSONB
    END;

    IF JSONB_TYPEOF(
      OLD."affordabilityResult" -> 'contract'
    ) = 'object'
      AND NEW."affordabilityResult" -> 'contract'
        IS DISTINCT FROM OLD."affordabilityResult" -> 'contract'
    THEN
      IF NOT COALESCE(
        JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
          AND NEW."affordabilityResult" ? 'contractHistory'
          AND NEW."affordabilityResult" -> 'contractHistory'
            IS NOT DISTINCT FROM (
              old_contract_history
              || JSONB_BUILD_ARRAY(
                OLD."affordabilityResult" -> 'contract'
              )
            ),
        FALSE
      )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE =
            'Archived contract evidence must exactly record the replaced contract';
      END IF;
    ELSIF old_contract_history_present THEN
      IF NOT COALESCE(
        JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
          AND NEW."affordabilityResult" ? 'contractHistory'
          AND NEW."affordabilityResult" -> 'contractHistory'
            IS NOT DISTINCT FROM old_contract_history,
        FALSE
      )
      THEN
        RAISE EXCEPTION USING
          ERRCODE = '23514',
          MESSAGE = 'Archived contract evidence is immutable';
      END IF;
    ELSIF COALESCE(
      JSONB_TYPEOF(NEW."affordabilityResult") = 'object'
        AND NEW."affordabilityResult" ? 'contractHistory',
      FALSE
    )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Archived contract evidence cannot be fabricated';
    END IF;
  END IF;

  IF JSONB_TYPEOF(OLD."affordabilityResult") = 'object'
    AND JSONB_TYPEOF(OLD."affordabilityResult" -> 'approval') = 'object'
    AND JSONB_TYPEOF(OLD."affordabilityResult" -> 'contract') = 'object'
    AND (
      NOT (OLD."affordabilityResult" ? 'approvalHistory')
      OR JSONB_TYPEOF(
        OLD."affordabilityResult" -> 'approvalHistory'
      ) = 'array'
    )
    AND (
      NOT (OLD."affordabilityResult" ? 'contractHistory')
      OR JSONB_TYPEOF(
        OLD."affordabilityResult" -> 'contractHistory'
      ) = 'array'
    )
  THEN
    expected_review_affordability :=
      (
        OLD."affordabilityResult"
          - 'approval'
          - 'contract'
          - 'approvalHistory'
          - 'contractHistory'
      )
      || JSONB_BUILD_OBJECT(
        'approvalHistory',
        COALESCE(
          OLD."affordabilityResult" -> 'approvalHistory',
          '[]'::JSONB
        ) || JSONB_BUILD_ARRAY(
          OLD."affordabilityResult" -> 'approval'
        ),
        'contractHistory',
        COALESCE(
          OLD."affordabilityResult" -> 'contractHistory',
          '[]'::JSONB
        ) || JSONB_BUILD_ARRAY(
          OLD."affordabilityResult" -> 'contract'
        )
      );
  END IF;

  explicit_return_to_review := COALESCE((
    OLD."debitMandateSignedAt" IS NOT NULL
    AND OLD."status"::TEXT = 'APPROVED'
    AND NEW."status"::TEXT = 'UNDER_REVIEW'
    AND NEW."tenantId" IS NOT DISTINCT FROM OLD."tenantId"
    AND NEW."clientId" IS NOT DISTINCT FROM OLD."clientId"
    AND NEW."productId" IS NOT DISTINCT FROM OLD."productId"
    AND NEW."branchId" IS NOT DISTINCT FROM OLD."branchId"
    AND NEW."appliedAmount" IS NOT DISTINCT FROM OLD."appliedAmount"
    AND NEW."appliedTermDays" IS NOT DISTINCT FROM OLD."appliedTermDays"
    AND NEW."purpose" IS NOT DISTINCT FROM OLD."purpose"
    AND NEW."agreementType" IS NOT DISTINCT FROM OLD."agreementType"
    AND NEW."initiationFeePayment"
      IS NOT DISTINCT FROM OLD."initiationFeePayment"
    AND NEW."assignedToId" IS NOT NULL
    AND LENGTH(BTRIM(NEW."assignedToId")) > 0
    AND NEW."approvedAt" IS NULL
    AND NEW."approvedById" IS NULL
    AND NEW."approvedAmount" IS NULL
    AND NEW."approvedTermDays" IS NULL
    AND NEW."approvedRate" IS NULL
    AND NEW."decisionReason" IS NULL
    AND expected_review_affordability IS NOT NULL
    AND NEW."affordabilityResult"
      IS NOT DISTINCT FROM expected_review_affordability
    AND NEW."bureauOverrideReason" IS NULL
    AND NEW."bureauOverrideById" IS NULL
    AND NEW."bureauOverrideAt" IS NULL
    AND NEW."bureauReviewGeneration" IS NOT NULL
    AND LENGTH(BTRIM(NEW."bureauReviewGeneration")) > 0
    AND NEW."bureauReviewGeneration"
      IS DISTINCT FROM OLD."bureauReviewGeneration"
    AND NEW."recklessLendingAssessed" = FALSE
    AND NEW."recklessLendingAssessedById" IS NULL
    AND NEW."recklessLendingAssessedAt" IS NULL
    AND NEW."pasqVersion" IS NULL
    AND NEW."pasqGeneratedAt" IS NULL
    AND NEW."pasqDocumentId" IS NULL
    AND NEW."pasqDocumentSha256" IS NULL
    AND NEW."pasqEvidence" IS NULL
    AND NEW."pasqEvidenceSha256" IS NULL
    AND NEW."pasqAcknowledgedAt" IS NULL
    AND NEW."pasqAcknowledgedBy" IS NULL
    AND NEW."pasqAcknowledgedSha256" IS NULL
    AND NEW."approvedPasqDocumentSha256" IS NULL
    AND NEW."clientAffordabilityDeclaredAt" IS NULL
    AND NEW."agreementGeneratedAt" IS NULL
    AND NEW."agreementDocumentId" IS NULL
    AND NEW."agreementDocumentSha256" IS NULL
    AND NEW."agreementSignedAt" IS NULL
    AND NEW."agreementSignedMethod" IS NULL
    AND NEW."agreementSignedByIp" IS NULL
    AND NEW."agreementSignedByUserId" IS NULL
    AND NEW."agreementSignatureData" IS NULL
    AND NEW."agreementCountersignedAt" IS NULL
    AND NEW."agreementCountersignedById" IS NULL
    AND NEW."agreementCountersignedByName" IS NULL
    AND NEW."agreementCountersignedByEmail" IS NULL
    AND NEW."agreementCountersignatureData" IS NULL
    AND NEW."agreementCountersignatureSha256" IS NULL
    AND NEW."agreementCountersignatureEnvelopeSha256" IS NULL
    AND NEW."agreementCountersignedDocumentSha256" IS NULL
    AND NEW."debitMandatePreparedAt" IS NULL
    AND NEW."debitMandateReference" IS NULL
    AND NEW."debitMandateDraftSha256" IS NULL
    AND NEW."debitMandateEvidence" IS NULL
    AND NEW."debitMandateEvidenceSha256" IS NULL
    AND NEW."debitMandateSignedAt" IS NULL
    AND NEW."debitMandateSignedMethod" IS NULL
    AND NEW."debitMandateSignedByIp" IS NULL
    AND NEW."debitMandateSignatureData" IS NULL
    AND NEW."debitMandateSignatureSha256" IS NULL
    AND NEW."debitMandateDocumentId" IS NULL
    AND NEW."debitMandateDocumentSha256" IS NULL
  ), FALSE);

  IF OLD."debitMandateSignedAt" IS NOT NULL
    AND NOT explicit_return_to_review
    AND (
      NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
      OR NEW."productId" IS DISTINCT FROM OLD."productId"
      OR NEW."branchId" IS DISTINCT FROM OLD."branchId"
      OR NEW."appliedAmount" IS DISTINCT FROM OLD."appliedAmount"
      OR NEW."appliedTermDays" IS DISTINCT FROM OLD."appliedTermDays"
      OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
      OR NEW."agreementType" IS DISTINCT FROM OLD."agreementType"
      OR NEW."approvedAmount" IS DISTINCT FROM OLD."approvedAmount"
      OR NEW."approvedTermDays" IS DISTINCT FROM OLD."approvedTermDays"
      OR NEW."approvedRate" IS DISTINCT FROM OLD."approvedRate"
      OR NEW."approvedAt" IS DISTINCT FROM OLD."approvedAt"
      OR NEW."approvedById" IS DISTINCT FROM OLD."approvedById"
      OR NEW."decisionReason" IS DISTINCT FROM OLD."decisionReason"
      OR NEW."bureauOverrideReason"
        IS DISTINCT FROM OLD."bureauOverrideReason"
      OR NEW."bureauOverrideById"
        IS DISTINCT FROM OLD."bureauOverrideById"
      OR NEW."bureauOverrideAt" IS DISTINCT FROM OLD."bureauOverrideAt"
      OR NEW."bureauReviewGeneration"
        IS DISTINCT FROM OLD."bureauReviewGeneration"
      OR NEW."recklessLendingAssessed"
        IS DISTINCT FROM OLD."recklessLendingAssessed"
      OR NEW."recklessLendingAssessedById"
        IS DISTINCT FROM OLD."recklessLendingAssessedById"
      OR NEW."recklessLendingAssessedAt"
        IS DISTINCT FROM OLD."recklessLendingAssessedAt"
      OR NEW."clientAffordabilityDeclaredAt"
        IS DISTINCT FROM OLD."clientAffordabilityDeclaredAt"
      OR NEW."initiationFeePayment"
        IS DISTINCT FROM OLD."initiationFeePayment"
      OR NEW."affordabilityResult"
        IS DISTINCT FROM OLD."affordabilityResult"
      OR NEW."pasqVersion" IS DISTINCT FROM OLD."pasqVersion"
      OR NEW."pasqGeneratedAt" IS DISTINCT FROM OLD."pasqGeneratedAt"
      OR NEW."pasqDocumentId" IS DISTINCT FROM OLD."pasqDocumentId"
      OR NEW."pasqDocumentSha256"
        IS DISTINCT FROM OLD."pasqDocumentSha256"
      OR NEW."pasqEvidence" IS DISTINCT FROM OLD."pasqEvidence"
      OR NEW."pasqEvidenceSha256"
        IS DISTINCT FROM OLD."pasqEvidenceSha256"
      OR NEW."pasqAcknowledgedAt"
        IS DISTINCT FROM OLD."pasqAcknowledgedAt"
      OR NEW."pasqAcknowledgedBy"
        IS DISTINCT FROM OLD."pasqAcknowledgedBy"
      OR NEW."pasqAcknowledgedSha256"
        IS DISTINCT FROM OLD."pasqAcknowledgedSha256"
      OR NEW."approvedPasqDocumentSha256"
        IS DISTINCT FROM OLD."approvedPasqDocumentSha256"
      OR NEW."agreementGeneratedAt"
        IS DISTINCT FROM OLD."agreementGeneratedAt"
      OR NEW."agreementDocumentId"
        IS DISTINCT FROM OLD."agreementDocumentId"
      OR NEW."agreementDocumentSha256"
        IS DISTINCT FROM OLD."agreementDocumentSha256"
      OR NEW."agreementSignedAt" IS DISTINCT FROM OLD."agreementSignedAt"
      OR NEW."agreementSignedMethod"
        IS DISTINCT FROM OLD."agreementSignedMethod"
      OR NEW."agreementSignedByIp"
        IS DISTINCT FROM OLD."agreementSignedByIp"
      OR NEW."agreementSignedByUserId"
        IS DISTINCT FROM OLD."agreementSignedByUserId"
      OR NEW."agreementSignatureData"
        IS DISTINCT FROM OLD."agreementSignatureData"
      OR NEW."agreementCountersignedAt"
        IS DISTINCT FROM OLD."agreementCountersignedAt"
      OR NEW."agreementCountersignedById"
        IS DISTINCT FROM OLD."agreementCountersignedById"
      OR NEW."agreementCountersignedByName"
        IS DISTINCT FROM OLD."agreementCountersignedByName"
      OR NEW."agreementCountersignedByEmail"
        IS DISTINCT FROM OLD."agreementCountersignedByEmail"
      OR NEW."agreementCountersignatureData"
        IS DISTINCT FROM OLD."agreementCountersignatureData"
      OR NEW."agreementCountersignatureSha256"
        IS DISTINCT FROM OLD."agreementCountersignatureSha256"
      OR NEW."agreementCountersignatureEnvelopeSha256"
        IS DISTINCT FROM OLD."agreementCountersignatureEnvelopeSha256"
      OR NEW."agreementCountersignedDocumentSha256"
        IS DISTINCT FROM OLD."agreementCountersignedDocumentSha256"
      OR NEW."debitMandatePreparedAt"
        IS DISTINCT FROM OLD."debitMandatePreparedAt"
      OR NEW."debitMandateReference"
        IS DISTINCT FROM OLD."debitMandateReference"
      OR NEW."debitMandateDraftSha256"
        IS DISTINCT FROM OLD."debitMandateDraftSha256"
      OR NEW."debitMandateEvidence"
        IS DISTINCT FROM OLD."debitMandateEvidence"
      OR NEW."debitMandateEvidenceSha256"
        IS DISTINCT FROM OLD."debitMandateEvidenceSha256"
      OR NEW."debitMandateSignedAt"
        IS DISTINCT FROM OLD."debitMandateSignedAt"
      OR NEW."debitMandateSignedMethod"
        IS DISTINCT FROM OLD."debitMandateSignedMethod"
      OR NEW."debitMandateSignedByIp"
        IS DISTINCT FROM OLD."debitMandateSignedByIp"
      OR NEW."debitMandateSignatureData"
        IS DISTINCT FROM OLD."debitMandateSignatureData"
      OR NEW."debitMandateSignatureSha256"
        IS DISTINCT FROM OLD."debitMandateSignatureSha256"
      OR NEW."debitMandateDocumentId"
        IS DISTINCT FROM OLD."debitMandateDocumentId"
      OR NEW."debitMandateDocumentSha256"
        IS DISTINCT FROM OLD."debitMandateDocumentSha256"
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Signed debit-mandate authority is immutable outside an explicit return to review';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."lockBundledCreditLifeDependencies"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  dependent_loan_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'Loan' THEN
    PERFORM "lockBundledCreditLifeLoan"(OLD."id");
    IF TG_OP = 'UPDATE' AND NEW."id" IS DISTINCT FROM OLD."id" THEN
      PERFORM "lockBundledCreditLifeLoan"(NEW."id");
    END IF;
  ELSIF TG_TABLE_NAME = 'LoanApplication' THEN
    IF TG_OP = 'UPDATE' THEN
      FOR dependent_loan_id IN
        SELECT loan."id"
        FROM "Loan" AS loan
        WHERE loan."applicationId" IN (OLD."id", NEW."id")
        ORDER BY loan."id"
      LOOP
        PERFORM "lockBundledCreditLifeLoan"(dependent_loan_id);
      END LOOP;

      IF NEW."agreementSignedMethod" IS DISTINCT FROM OLD."agreementSignedMethod"
         OR NEW."agreementSignedByIp" IS DISTINCT FROM OLD."agreementSignedByIp"
         OR NEW."agreementSignedByUserId" IS DISTINCT FROM OLD."agreementSignedByUserId"
         OR NEW."agreementSignatureData" IS DISTINCT FROM OLD."agreementSignatureData" THEN
        IF EXISTS (
          SELECT 1
          FROM "Loan" AS loan
          JOIN "InsurancePolicy" AS policy
            ON policy."linkedLoanId" = loan."id"
           AND policy."tenantId" = loan."tenantId"
           AND policy."clientId" = loan."clientId"
          WHERE loan."applicationId" IN (OLD."id", NEW."id")
            AND policy."type" = 'CREDIT_LIFE'::"InsurancePolicyType"
            AND policy."policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource"
        ) THEN
          RAISE EXCEPTION USING
            ERRCODE = '23514',
            MESSAGE = 'Bundled credit-life signed agreement evidence is immutable';
        END IF;
      END IF;
    ELSE
      FOR dependent_loan_id IN
        SELECT loan."id"
        FROM "Loan" AS loan
        WHERE loan."applicationId" = OLD."id"
        ORDER BY loan."id"
      LOOP
        PERFORM "lockBundledCreditLifeLoan"(dependent_loan_id);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'ClientDocument' THEN
    IF TG_OP = 'UPDATE' THEN
      FOR dependent_loan_id IN
        SELECT DISTINCT loan."id"
        FROM "Loan" AS loan
        JOIN "LoanApplication" AS application
          ON application."id" = loan."applicationId"
        WHERE application."agreementDocumentId" IN (OLD."id", NEW."id")
           OR loan."agreementDocId" IN (OLD."id", NEW."id")
        ORDER BY loan."id"
      LOOP
        PERFORM "lockBundledCreditLifeLoan"(dependent_loan_id);
      END LOOP;
    ELSE
      FOR dependent_loan_id IN
        SELECT DISTINCT loan."id"
        FROM "Loan" AS loan
        JOIN "LoanApplication" AS application
          ON application."id" = loan."applicationId"
        WHERE application."agreementDocumentId" = OLD."id"
           OR loan."agreementDocId" = OLD."id"
        ORDER BY loan."id"
      LOOP
        PERFORM "lockBundledCreditLifeLoan"(dependent_loan_id);
      END LOOP;
    END IF;
  ELSIF TG_TABLE_NAME = 'ComplianceRecord' THEN
    -- The completed artifact is the durable record of what the customer saw
    -- and elected. It must become immutable at completion, before any policy
    -- exists, so neither a current nor rollback writer can rewrite the signed
    -- election between agreement completion and disbursement.
    IF TG_OP = 'DELETE'
       AND OLD."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType"
       AND OLD."status" = 'COMPLETED'::"ComplianceStatus"
       AND OLD."completedAt" IS NOT NULL
       AND OLD."data" ->> 'kind' = 'CREDIT_AGREEMENT_ARTIFACT'
       AND OLD."data" ->> 'lifecycle' = 'COMPLETED' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Completed credit-agreement artifacts are immutable';
    ELSIF TG_OP = 'UPDATE'
       AND OLD."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType"
       AND OLD."status" = 'COMPLETED'::"ComplianceStatus"
       AND OLD."completedAt" IS NOT NULL
       AND OLD."data" ->> 'kind' = 'CREDIT_AGREEMENT_ARTIFACT'
       AND OLD."data" ->> 'lifecycle' = 'COMPLETED' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Completed credit-agreement artifacts are immutable';
    END IF;

    IF TG_OP = 'INSERT' THEN
      IF NEW."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType" THEN
        FOR dependent_loan_id IN
          SELECT loan."id"
          FROM "Loan" AS loan
          WHERE loan."tenantId" = NEW."tenantId"
            AND loan."applicationId" = NEW."referenceId"
          ORDER BY loan."id"
        LOOP
          PERFORM "lockBundledCreditLifeLoan"(dependent_loan_id);
        END LOOP;
      END IF;
    ELSIF TG_OP = 'UPDATE' THEN
      FOR dependent_loan_id IN
        SELECT loan."id"
        FROM "Loan" AS loan
        WHERE (
          OLD."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType"
          AND loan."tenantId" = OLD."tenantId"
          AND loan."applicationId" = OLD."referenceId"
        ) OR (
          NEW."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType"
          AND loan."tenantId" = NEW."tenantId"
          AND loan."applicationId" = NEW."referenceId"
        )
        ORDER BY loan."id"
      LOOP
        PERFORM "lockBundledCreditLifeLoan"(dependent_loan_id);
      END LOOP;
    ELSIF OLD."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType" THEN
      FOR dependent_loan_id IN
        SELECT loan."id"
        FROM "Loan" AS loan
        WHERE loan."tenantId" = OLD."tenantId"
          AND loan."applicationId" = OLD."referenceId"
        ORDER BY loan."id"
      LOOP
        PERFORM "lockBundledCreditLifeLoan"(dependent_loan_id);
      END LOOP;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."lockBundledCreditLifeLoan"(loan_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF loan_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('bundled-credit-life:' || loan_id, 0)
    );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public."lockLoanApplicationPasqDocument"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  locked_document_id TEXT;
BEGIN
  IF NEW."status"::TEXT NOT IN ('APPROVED', 'DISBURSED') THEN
    RETURN NEW;
  END IF;

  -- Pre-ceremony: an APPROVED application legitimately carries no quotation
  -- until the ceremony starts, so there is no document to lock yet. Any claimed
  -- binding, any agreement artefact, and every DISBURSED row still must resolve
  -- to an intact bound PDF.
  IF NEW."status"::TEXT = 'APPROVED'
    AND NEW."agreementGeneratedAt" IS NULL
    AND NEW."agreementSignedAt" IS NULL
    AND NEW."agreementCountersignedAt" IS NULL
    AND NEW."pasqDocumentId" IS NULL
    AND NEW."pasqDocumentSha256" IS NULL
  THEN
    RETURN NEW;
  END IF;

  SELECT document."id"
  INTO locked_document_id
  FROM "ClientDocument" AS document
  WHERE document."id" = NEW."pasqDocumentId"
    AND document."tenantId" = NEW."tenantId"
    AND document."clientId" = NEW."clientId"
    AND document."docType"::TEXT = 'FORM_20_PRE_AGREEMENT'
    AND document."deletedAt" IS NULL
    AND document."storagePath" IS NOT NULL
    AND LENGTH(BTRIM(document."storagePath")) > 0
    AND document."mimeType" = 'application/pdf'
    AND document."fileSize" IS NOT NULL
    AND document."fileSize" > 0
    AND document."contentSha256" = NEW."pasqDocumentSha256"
  FOR SHARE;

  IF locked_document_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Approval requires an intact locked application-bound PASQ document';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."affordabilityDebtSha256"(p_debts jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  canonical TEXT;
BEGIN
  IF JSONB_TYPEOF(p_debts) <> 'array' THEN
    RETURN NULL;
  END IF;

  SELECT
    '[' || COALESCE(
      STRING_AGG(payload, ',' ORDER BY payload COLLATE "C"),
      ''
    ) || ']'
  INTO canonical
  FROM (
    SELECT "jsonArrayText"(JSONB_BUILD_ARRAY(
      debt.value -> 'sourceId',
      debt.value -> 'provider',
      debt.value -> 'type',
      debt.value -> 'balanceCents',
      debt.value -> 'monthlyInstalmentCents',
      debt.value -> 'notes'
    )) AS payload
    FROM JSONB_ARRAY_ELEMENTS(p_debts) AS debt(value)
    WHERE JSONB_TYPEOF(debt.value) = 'object'
  ) AS encoded;

  IF (
    SELECT COUNT(*)
    FROM JSONB_ARRAY_ELEMENTS(p_debts) AS debt(value)
    WHERE JSONB_TYPEOF(debt.value) <> 'object'
  ) > 0
  THEN
    RETURN NULL;
  END IF;

  RETURN ENCODE(SHA256(CONVERT_TO(canonical, 'UTF8')), 'hex');
END;
$function$;

CREATE OR REPLACE FUNCTION public."affordabilityExpenseSha256"(p_expenses jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
BEGIN
  IF JSONB_TYPEOF(p_expenses) <> 'object'
    OR JSONB_TYPEOF(p_expenses -> 'breakdown') <> 'object'
    OR JSONB_TYPEOF(p_expenses -> 'mle') <> 'object'
  THEN
    RETURN NULL;
  END IF;

  RETURN "jsonArraySha256"(JSONB_BUILD_ARRAY(
    p_expenses -> 'source',
    p_expenses -> 'sourceId',
    p_expenses -> 'sourceUpdatedAt',
    p_expenses -> 'grossMonthlyIncomeCents',
    p_expenses -> 'monthlyIncomeCents',
    p_expenses -> 'statedMonthlyExpensesCents',
    JSONB_BUILD_ARRAY(
      p_expenses #> '{breakdown,housing}',
      p_expenses #> '{breakdown,transport}',
      p_expenses #> '{breakdown,food}',
      p_expenses #> '{breakdown,education}',
      p_expenses #> '{breakdown,insurance}',
      p_expenses #> '{breakdown,clothing}',
      p_expenses #> '{breakdown,entertainment}',
      p_expenses #> '{breakdown,medical}',
      p_expenses #> '{breakdown,other}'
    ),
    p_expenses -> 'breakdownTotalCents',
    p_expenses #> '{mle,formulaVersion}',
    p_expenses #> '{mle,basisIncomeCents}',
    p_expenses #> '{mle,minimumExpenseCents}',
    p_expenses #> '{mle,belowMinimum}',
    p_expenses #> '{mle,justification}'
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public."affordabilityInputSha256"(p_inputs jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  canonical JSONB;
BEGIN
  IF JSONB_TYPEOF(p_inputs) <> 'object' THEN
    RETURN NULL;
  END IF;

  canonical := JSONB_BUILD_ARRAY(
    p_inputs -> 'monthlyIncomeCents',
    p_inputs -> 'monthlyExpensesCents',
    p_inputs -> 'applicationDebtCents',
    p_inputs -> 'clientDebtCents',
    p_inputs -> 'declaredDebtCents',
    p_inputs -> 'bureauObligationsCents',
    p_inputs -> 'proposedInstalmentCents',
    p_inputs -> 'principalCents',
    p_inputs -> 'termDays',
    p_inputs -> 'productId',
    p_inputs -> 'interestRatePm',
    p_inputs -> 'interestModel',
    p_inputs -> 'initiationFeePct',
    p_inputs -> 'initiationFeeMaxCents',
    p_inputs -> 'monthlyServiceFeeCents',
    p_inputs -> 'initiationFeePayment',
    p_inputs -> 'ndiBufferPct'
  );
  IF p_inputs ? 'creditLifePremiumCents' THEN
    canonical := canonical || JSONB_BUILD_ARRAY(
      p_inputs -> 'creditLifePremiumCents'
    );
  END IF;
  RETURN "jsonArraySha256"(canonical);
END;
$function$;

CREATE OR REPLACE FUNCTION public."approvalEvidenceIsIntact"(p_approval jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  input_sha TEXT;
  expense_sha TEXT;
  application_debt_sha TEXT;
  client_debt_sha TEXT;
  bureau_sha TEXT;
  pricing_sha TEXT;
  contract_sha TEXT;
  decision_sha TEXT;
BEGIN
  IF JSONB_TYPEOF(p_approval) <> 'object'
    OR JSONB_TYPEOF(p_approval -> 'inputs') <> 'object'
    OR JSONB_TYPEOF(p_approval -> 'expenses') <> 'object'
    OR JSONB_TYPEOF(p_approval -> 'debts') <> 'object'
    OR JSONB_TYPEOF(p_approval #> '{debts,application}') <> 'array'
    OR JSONB_TYPEOF(p_approval #> '{debts,client}') <> 'array'
    OR JSONB_TYPEOF(p_approval -> 'calculator') <> 'object'
    OR JSONB_TYPEOF(p_approval -> 'outcome') <> 'object'
    OR NOT (p_approval ? 'bureauEvidence')
  THEN
    RETURN FALSE;
  END IF;

  input_sha := "affordabilityInputSha256"(
    p_approval -> 'inputs'
  );
  expense_sha := "affordabilityExpenseSha256"(
    p_approval -> 'expenses'
  );
  application_debt_sha := "affordabilityDebtSha256"(
    p_approval #> '{debts,application}'
  );
  client_debt_sha := "affordabilityDebtSha256"(
    p_approval #> '{debts,client}'
  );
  bureau_sha := "bureauDecisionSha256"(
    p_approval -> 'bureauEvidence'
  );
  pricing_sha := "calculatorPricingSha256"(
    p_approval -> 'calculator'
  );
  contract_sha := "calculatorContractSha256"(
    p_approval -> 'calculator'
  );

  decision_sha := "jsonArraySha256"(JSONB_BUILD_ARRAY(
    p_approval -> 'stage',
    p_approval -> 'policyVersion',
    p_approval -> 'capturedAt',
    p_approval -> 'capturedById',
    TO_JSONB(input_sha),
    TO_JSONB(expense_sha),
    TO_JSONB(application_debt_sha),
    TO_JSONB(client_debt_sha),
    TO_JSONB(bureau_sha),
    TO_JSONB(pricing_sha),
    TO_JSONB(contract_sha),
    JSONB_BUILD_ARRAY(
      p_approval #> '{outcome,netDisposableIncomeCents}',
      p_approval #> '{outcome,ndiAfterLoanCents}',
      p_approval #> '{outcome,requiredNdiCents}',
      p_approval #> '{outcome,isAffordable}',
      p_approval #> '{outcome,reason}'
    )
  ));

  RETURN COALESCE(
    input_sha = p_approval ->> 'inputFingerprint'
    AND expense_sha = p_approval #>> '{expenses,fingerprint}'
    AND application_debt_sha
      = p_approval #>> '{debts,applicationFingerprint}'
    AND client_debt_sha
      = p_approval #>> '{debts,clientFingerprint}'
    AND pricing_sha
      = p_approval #>> '{calculator,pricingFingerprint}'
    AND contract_sha
      = p_approval #>> '{calculator,contractFingerprint}'
    AND decision_sha = p_approval ->> 'decisionFingerprint',
    FALSE
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public."approvalFinancialsAreConsistent"(p_approval jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  monthly_income NUMERIC;
  monthly_expenses NUMERIC;
  application_debt NUMERIC;
  client_debt NUMERIC;
  declared_debt NUMERIC;
  bureau_debt NUMERIC;
  proposed_instalment NUMERIC;
  credit_life_premium NUMERIC;
  ndi_buffer NUMERIC;
  effective_debt NUMERIC;
  discretionary_income NUMERIC;
  net_disposable NUMERIC;
  ndi_after_loan NUMERIC;
  required_ndi NUMERIC;
BEGIN
  IF JSONB_TYPEOF(p_approval -> 'inputs') <> 'object'
    OR JSONB_TYPEOF(p_approval -> 'outcome') <> 'object'
    OR JSONB_TYPEOF(p_approval #> '{inputs,monthlyIncomeCents}')
      <> 'number'
    OR JSONB_TYPEOF(p_approval #> '{inputs,monthlyExpensesCents}')
      <> 'number'
    OR JSONB_TYPEOF(p_approval #> '{inputs,applicationDebtCents}')
      <> 'number'
    OR JSONB_TYPEOF(p_approval #> '{inputs,clientDebtCents}')
      <> 'number'
    OR JSONB_TYPEOF(p_approval #> '{inputs,declaredDebtCents}')
      <> 'number'
    OR JSONB_TYPEOF(p_approval #> '{inputs,bureauObligationsCents}')
      <> 'number'
    OR JSONB_TYPEOF(p_approval #> '{inputs,proposedInstalmentCents}')
      <> 'number'
    OR JSONB_TYPEOF(p_approval #> '{inputs,ndiBufferPct}')
      <> 'number'
    OR JSONB_TYPEOF(
      p_approval #> '{calculator,recurringInstalmentCents}'
    ) <> 'number'
    OR JSONB_TYPEOF(
      p_approval #> '{outcome,netDisposableIncomeCents}'
    ) <> 'number'
    OR JSONB_TYPEOF(p_approval #> '{outcome,ndiAfterLoanCents}')
      <> 'number'
    OR JSONB_TYPEOF(p_approval #> '{outcome,requiredNdiCents}')
      <> 'number'
    OR JSONB_TYPEOF(p_approval #> '{outcome,isAffordable}')
      <> 'boolean'
    OR (
      p_approval -> 'inputs' ? 'creditLifePremiumCents'
      AND JSONB_TYPEOF(
        p_approval #> '{inputs,creditLifePremiumCents}'
      ) <> 'number'
    )
  THEN
    RETURN FALSE;
  END IF;

  monthly_income :=
    (p_approval #>> '{inputs,monthlyIncomeCents}')::NUMERIC;
  monthly_expenses :=
    (p_approval #>> '{inputs,monthlyExpensesCents}')::NUMERIC;
  application_debt :=
    (p_approval #>> '{inputs,applicationDebtCents}')::NUMERIC;
  client_debt :=
    (p_approval #>> '{inputs,clientDebtCents}')::NUMERIC;
  declared_debt :=
    (p_approval #>> '{inputs,declaredDebtCents}')::NUMERIC;
  bureau_debt :=
    (p_approval #>> '{inputs,bureauObligationsCents}')::NUMERIC;
  proposed_instalment :=
    (p_approval #>> '{inputs,proposedInstalmentCents}')::NUMERIC;
  ndi_buffer := (p_approval #>> '{inputs,ndiBufferPct}')::NUMERIC;
  credit_life_premium := CASE
    WHEN p_approval -> 'inputs' ? 'creditLifePremiumCents'
      THEN (
        p_approval #>> '{inputs,creditLifePremiumCents}'
      )::NUMERIC
    ELSE 0
  END;

  IF monthly_income < 0
    OR monthly_expenses < 0
    OR application_debt < 0
    OR client_debt < 0
    OR declared_debt < 0
    OR bureau_debt < 0
    OR proposed_instalment < 0
    OR credit_life_premium < 0
    OR ndi_buffer < 0
    OR declared_debt <> GREATEST(application_debt, client_debt)
    OR proposed_instalment <> (
      p_approval #>> '{calculator,recurringInstalmentCents}'
    )::NUMERIC + credit_life_premium
  THEN
    RETURN FALSE;
  END IF;

  effective_debt := GREATEST(declared_debt, bureau_debt);
  discretionary_income := monthly_income - monthly_expenses;
  net_disposable := discretionary_income - effective_debt;
  ndi_after_loan := net_disposable - proposed_instalment;
  required_ndi := CEIL(proposed_instalment * (ndi_buffer / 100));

  RETURN COALESCE(
    (p_approval #>> '{outcome,netDisposableIncomeCents}')::NUMERIC
      = net_disposable
    AND (p_approval #>> '{outcome,ndiAfterLoanCents}')::NUMERIC
      = ndi_after_loan
    AND (p_approval #>> '{outcome,requiredNdiCents}')::NUMERIC
      = required_ndi
    AND p_approval #>> '{outcome,isAffordable}' = 'true'
    AND net_disposable >= required_ndi
    AND proposed_instalment / GREATEST(1, discretionary_income)
      <= 0.7
    AND p_approval #> '{outcome,reason}' = 'null'::JSONB,
    FALSE
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public."bureauDecisionSha256"(p_evidence jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  check_payload JSONB;
  override_payload JSONB;
  canonical JSONB;
BEGIN
  IF p_evidence = 'null'::JSONB THEN
    RETURN ENCODE(SHA256(CONVERT_TO('null', 'UTF8')), 'hex');
  END IF;
  IF JSONB_TYPEOF(p_evidence) <> 'object'
    OR JSONB_TYPEOF(p_evidence -> 'policy') <> 'object'
  THEN
    RETURN NULL;
  END IF;

  check_payload := CASE
    WHEN p_evidence -> 'check' = 'null'::JSONB THEN 'null'::JSONB
    WHEN JSONB_TYPEOF(p_evidence -> 'check') = 'object'
      THEN JSONB_BUILD_ARRAY(
        p_evidence #> '{check,id}',
        p_evidence #> '{check,clientId}',
        p_evidence #> '{check,subjectFingerprint}',
        p_evidence #> '{check,provider}',
        p_evidence #> '{check,createdAt}',
        p_evidence #> '{check,score}',
        p_evidence #> '{check,riskGrade}',
        p_evidence #> '{check,unscoreable}',
        p_evidence #> '{check,hasAdverse}',
        p_evidence #> '{check,deceased}',
        p_evidence #> '{check,underDebtReview}',
        p_evidence #> '{check,hasJudgement}',
        p_evidence #> '{check,hasNotice}',
        p_evidence #> '{check,obligationsCents}'
      )
    ELSE NULL
  END;
  override_payload := CASE
    WHEN p_evidence -> 'override' = 'null'::JSONB THEN 'null'::JSONB
    WHEN JSONB_TYPEOF(p_evidence -> 'override') = 'object'
      THEN JSONB_BUILD_ARRAY(
        p_evidence #> '{override,reason}',
        p_evidence #> '{override,reasonSha256}',
        p_evidence #> '{override,byId}',
        p_evidence #> '{override,at}'
      )
    ELSE NULL
  END;
  IF check_payload IS NULL OR override_payload IS NULL THEN
    RETURN NULL;
  END IF;

  canonical := JSONB_BUILD_ARRAY(
    p_evidence -> 'mode',
    check_payload,
    JSONB_BUILD_ARRAY(
      p_evidence #> '{policy,minimumScore}',
      p_evidence #> '{policy,blockAdverse}'
    ),
    override_payload
  );
  RETURN "jsonArraySha256"(canonical);
END;
$function$;

CREATE OR REPLACE FUNCTION public."calculatorContractSha256"(p_calculator jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  dates JSONB;
  pricing_payload JSONB;
BEGIN
  pricing_payload := "calculatorPricingPayload"(p_calculator);
  IF pricing_payload IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT JSONB_AGG(
    JSONB_BUILD_ARRAY(
      item.value -> 'installmentNo',
      item.value -> 'dueDate'
    )
    ORDER BY item.ordinal
  )
  INTO dates
  FROM JSONB_ARRAY_ELEMENTS(p_calculator -> 'schedule')
    WITH ORDINALITY AS item(value, ordinal);

  RETURN "jsonArraySha256"(JSONB_BUILD_ARRAY(
    pricing_payload,
    p_calculator -> 'startDate',
    dates
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public."calculatorPricingPayload"(p_calculator jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  schedule_payload JSONB;
BEGIN
  IF JSONB_TYPEOF(p_calculator) <> 'object'
    OR JSONB_TYPEOF(p_calculator -> 'schedule') <> 'array'
  THEN
    RETURN NULL;
  END IF;

  SELECT JSONB_AGG(
    JSONB_BUILD_ARRAY(
      item.value -> 'installmentNo',
      item.value -> 'principalDueCents',
      item.value -> 'interestDueCents',
      item.value -> 'feesDueCents',
      item.value -> 'totalDueCents',
      item.value -> 'openingBalanceCents',
      item.value -> 'closingBalanceCents'
    )
    ORDER BY item.ordinal
  )
  INTO schedule_payload
  FROM JSONB_ARRAY_ELEMENTS(p_calculator -> 'schedule')
    WITH ORDINALITY AS item(value, ordinal)
  WHERE JSONB_TYPEOF(item.value) = 'object';

  IF schedule_payload IS NULL
    OR JSONB_ARRAY_LENGTH(schedule_payload)
      <> JSONB_ARRAY_LENGTH(p_calculator -> 'schedule')
  THEN
    RETURN NULL;
  END IF;

  RETURN JSONB_BUILD_ARRAY(
    p_calculator -> 'version',
    p_calculator -> 'principalCents',
    p_calculator -> 'totalInterestCents',
    p_calculator -> 'initiationFeeCents',
    p_calculator -> 'serviceFeesCents',
    p_calculator -> 'totalRepayableCents',
    p_calculator -> 'disbursementAmountCents',
    p_calculator -> 'recurringInstalmentCents',
    schedule_payload
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public."calculatorPricingSha256"(p_calculator jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
  SELECT "jsonArraySha256"(
    "calculatorPricingPayload"(p_calculator)
  );
$function$;

CREATE OR REPLACE FUNCTION public."canonicalAccountType"(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN compact IN (
      'cheque',
      'check',
      'checking',
      'current',
      'transactional',
      'transaction',
      'transactionaccount',
      'chequeaccount',
      'checkaccount',
      'checkingaccount',
      'currentaccount',
      'transactionalaccount',
      'chequecurrent',
      'chequecurrentaccount',
      'currentcheque',
      'currentchequeaccount'
    ) THEN 'CHEQUE'
    -- Bank product names, the only prefix matches here. Long enough to name one
    -- product rather than a brand: 'prestigeacc' matches the statement value
    -- PRESTIGEACC and "Prestige Account", but must never shorten to 'prestige',
    -- which would also swallow a hypothetical "Prestige Savings".
    WHEN compact LIKE 'easyaccount%'
      OR compact LIKE 'prestigeacc%'
      THEN 'CHEQUE'
    WHEN compact IN (
      'saving',
      'savings',
      'savingaccount',
      'savingsaccount'
    ) THEN 'SAVINGS'
    ELSE ''
  END
  FROM (
    SELECT lower(
      regexp_replace(COALESCE(p_value, ''), '[^a-zA-Z]', '', 'g')
    ) AS compact
  ) AS normalized;
$function$;

CREATE OR REPLACE FUNCTION public."canonicalBankName"(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT CASE
    WHEN compact = 'fnb'
      OR compact LIKE '%firstnationalbank%'
      OR compact LIKE '%firstrand%' THEN 'fnb'
    WHEN compact LIKE '%standardbank%' THEN 'standardbank'
    WHEN compact LIKE '%absa%' THEN 'absa'
    WHEN compact LIKE '%nedbank%' THEN 'nedbank'
    WHEN compact LIKE '%capitec%' THEN 'capitec'
    WHEN compact LIKE '%africanbank%' THEN 'africanbank'
    WHEN compact LIKE '%discoverybank%' THEN 'discoverybank'
    WHEN compact LIKE '%tymebank%' THEN 'tymebank'
    WHEN compact LIKE '%bidvestbank%' THEN 'bidvestbank'
    WHEN compact LIKE '%investec%' THEN 'investec'
    ELSE compact
  END
  FROM (
    SELECT lower(regexp_replace(COALESCE(p_value, ''), '[^a-zA-Z0-9]', '', 'g')) AS compact
  ) AS normalized;
$function$;

CREATE OR REPLACE FUNCTION public."canonicalJsonb"(p_value jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
AS $function$
DECLARE
  result TEXT;
BEGIN
  CASE jsonb_typeof(p_value)
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        string_agg(
          to_jsonb(entry.key)::TEXT
            || ':'
            || "canonicalJsonb"(entry.value),
          ',' ORDER BY entry.key
        ),
        ''
      ) || '}'
      INTO result
      FROM jsonb_each(p_value) AS entry;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(
        string_agg(
          "canonicalJsonb"(entry.value),
          ',' ORDER BY entry.ordinality
        ),
        ''
      ) || ']'
      INTO result
      FROM jsonb_array_elements(p_value)
        WITH ORDINALITY AS entry(value, ordinality);
    ELSE
      result := p_value::TEXT;
  END CASE;
  RETURN result;
END;
$function$;

CREATE OR REPLACE FUNCTION public."contractEvidenceSha256"(p_contract jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
BEGIN
  IF JSONB_TYPEOF(p_contract) <> 'object'
    OR p_contract ->> 'version' <> 'affordability-contract-v2'
  THEN
    RETURN NULL;
  END IF;

  RETURN "jsonArraySha256"(JSONB_BUILD_ARRAY(
    p_contract -> 'version',
    p_contract -> 'establishedAt',
    p_contract -> 'acceptedPasqDocumentSha256',
    p_contract -> 'acceptedPasqContractFingerprint',
    p_contract -> 'quotePresentedAt',
    p_contract -> 'quoteValidUntilDate',
    p_contract -> 'approvalDecisionFingerprint',
    p_contract #> '{calculator,contractFingerprint}'
  ));
END;
$function$;

CREATE OR REPLACE FUNCTION public."creditLifeDisclosureSha256"(p_version text, p_election text, p_principal_cents integer, p_term_days integer, p_monthly_premium_cents integer, p_product_id text, p_product_name text, p_insurer_id text, p_insurer_name text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
  SELECT encode(
    sha256(
      convert_to(
        '{"version":' || TO_JSONB(p_version)::TEXT
        || ',"election":' || TO_JSONB(p_election)::TEXT
        || ',"principalCents":' || p_principal_cents::TEXT
        || ',"termDays":' || p_term_days::TEXT
        || ',"monthlyPremiumCents":' || p_monthly_premium_cents::TEXT
        || ',"productId":' || TO_JSONB(p_product_id)::TEXT
        || ',"productName":' || TO_JSONB(p_product_name)::TEXT
        || ',"insurerId":' || TO_JSONB(p_insurer_id)::TEXT
        || ',"insurerName":' || TO_JSONB(p_insurer_name)::TEXT
        || '}',
        'UTF8'
      )
    ),
    'hex'
  );
$function$;

CREATE OR REPLACE FUNCTION public."creditLifeNoOfferDisclosureSha256"(p_version text, p_election text, p_principal_cents integer, p_term_days integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
  SELECT encode(
    sha256(
      convert_to(
        '{"version":' || TO_JSONB(p_version)::TEXT
        || ',"election":' || TO_JSONB(p_election)::TEXT
        || ',"principalCents":' || p_principal_cents::TEXT
        || ',"termDays":' || p_term_days::TEXT
        || '}',
        'UTF8'
      )
    ),
    'hex'
  );
$function$;

CREATE OR REPLACE FUNCTION public."gregorianEasterSunday"(p_year integer)
 RETURNS date
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
AS $function$
DECLARE
  a INTEGER := p_year % 19;
  b INTEGER := p_year / 100;
  c INTEGER := p_year % 100;
  d INTEGER := b / 4;
  e INTEGER := b % 4;
  f INTEGER := (b + 8) / 25;
  g INTEGER := (b - f + 1) / 3;
  h INTEGER := (19 * a + b - d - g + 15) % 30;
  i INTEGER := c / 4;
  k INTEGER := c % 4;
  l INTEGER := (32 + 2 * e + 2 * i - h - k) % 7;
  m INTEGER := (a + 11 * h + 22 * l) / 451;
  month_number INTEGER := (h + l - 7 * m + 114) / 31;
  day_number INTEGER := ((h + l - 7 * m + 114) % 31) + 1;
BEGIN
  RETURN MAKE_DATE(p_year, month_number, day_number);
END;
$function$;

CREATE OR REPLACE FUNCTION public."isSaBasePublicHoliday"(p_date date)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
AS $function$
DECLARE
  easter DATE := "gregorianEasterSunday"(
    EXTRACT(YEAR FROM p_date)::INTEGER
  );
  month_day TEXT := TO_CHAR(p_date, 'MM-DD');
BEGIN
  RETURN month_day IN (
    '01-01',
    '03-21',
    '04-27',
    '05-01',
    '06-16',
    '08-09',
    '09-24',
    '12-16',
    '12-25',
    '12-26'
  )
  OR p_date = easter - 2
  OR p_date = easter + 1;
END;
$function$;

CREATE OR REPLACE FUNCTION public."isSaBusinessDate"(p_date date)
 RETURNS boolean
 LANGUAGE sql
 STABLE PARALLEL RESTRICTED
AS $function$
  SELECT
    EXTRACT(ISODOW FROM p_date)::INTEGER NOT IN (6, 7)
    AND NOT "isSaBasePublicHoliday"(p_date)
    AND NOT EXISTS (
      SELECT 1
      FROM "SaProclaimedPublicHoliday" AS proclaimed
      WHERE proclaimed."date" = p_date
    )
    AND NOT (
      EXTRACT(ISODOW FROM p_date)::INTEGER = 1
      AND EXTRACT(ISODOW FROM p_date - 1)::INTEGER = 7
      AND (
        "isSaBasePublicHoliday"(p_date - 1)
        OR EXISTS (
          SELECT 1
          FROM "SaProclaimedPublicHoliday" AS proclaimed
          WHERE proclaimed."date" = p_date - 1
        )
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public."jsonArraySha256"(p_value jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
  SELECT CASE
    WHEN JSONB_TYPEOF(p_value) = 'array'
      THEN ENCODE(
        SHA256(CONVERT_TO("jsonArrayText"(p_value), 'UTF8')),
        'hex'
      )
    ELSE NULL
  END;
$function$;

CREATE OR REPLACE FUNCTION public."jsonArrayText"(p_value jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  encoded TEXT;
BEGIN
  CASE JSONB_TYPEOF(p_value)
    WHEN 'array' THEN
      SELECT
        '[' || COALESCE(
          STRING_AGG(
            "jsonArrayText"(item.value),
            ','
            ORDER BY item.ordinal
          ),
          ''
        ) || ']'
      INTO encoded
      FROM JSONB_ARRAY_ELEMENTS(p_value)
        WITH ORDINALITY AS item(value, ordinal);
      RETURN encoded;
    WHEN 'string' THEN
      RETURN TO_JSONB(p_value #>> '{}')::TEXT;
    WHEN 'number' THEN
      RETURN p_value::TEXT;
    WHEN 'boolean' THEN
      RETURN p_value::TEXT;
    WHEN 'null' THEN
      RETURN 'null';
    ELSE
      RETURN NULL;
  END CASE;
END;
$function$;

CREATE OR REPLACE FUNCTION public."pasqCreditLifeMatchesApplication"(p_evidence jsonb, p_election text, p_credit_life_product_id text, p_credit_life_product_name text, p_credit_life_insurer_id text, p_credit_life_insurer_name text, p_monthly_premium_cents integer, p_disclosure_version text, p_disclosure_sha256 text, p_disclosure_acknowledged_at timestamp without time zone, p_disclosure_acknowledged_by text, p_client_id text, p_principal_cents integer, p_term_days integer, p_pasq_generated_at timestamp without time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE
AS $function$
DECLARE
  expected_periods INTEGER;
  expected_total_premium BIGINT;
  scheduled_total_premium BIGINT := 0;
  schedule_item JSONB;
  is_no_offer BOOLEAN;
BEGIN
  -- Arguments required by BOTH branches. The function is no longer STRICT, so
  -- these must be rejected explicitly instead of returning NULL.
  IF
    p_evidence IS NULL
    OR p_election IS NULL
    OR p_monthly_premium_cents IS NULL
    OR p_disclosure_version IS NULL
    OR p_disclosure_sha256 IS NULL
    OR p_disclosure_acknowledged_at IS NULL
    OR p_disclosure_acknowledged_by IS NULL
    OR p_client_id IS NULL
    OR p_principal_cents IS NULL
    OR p_term_days IS NULL
    OR p_pasq_generated_at IS NULL
  THEN
    RETURN FALSE;
  END IF;

  is_no_offer := p_disclosure_version = 'credit-life-no-offer-v1';

  IF
    p_election NOT IN ('ACCEPTED', 'DECLINED')
    OR p_disclosure_version NOT IN (
      'credit-life-election-v1',
      'credit-life-no-offer-v1'
    )
    OR p_disclosure_acknowledged_by <> p_client_id
    OR p_disclosure_acknowledged_at > p_pasq_generated_at
    OR JSONB_TYPEOF(p_evidence) <> 'object'
    OR JSONB_TYPEOF(p_evidence -> 'creditLife') <> 'object'
    OR JSONB_TYPEOF(p_evidence #> '{calculator,schedule}') <> 'array'
    OR JSONB_ARRAY_LENGTH(p_evidence #> '{calculator,schedule}') = 0
    OR JSONB_TYPEOF(p_evidence #> '{billing,schedule}') <> 'array'
    OR JSONB_ARRAY_LENGTH(p_evidence #> '{billing,schedule}') = 0
    OR p_evidence ->> 'termDays' <> p_term_days::TEXT
    OR p_evidence #>> '{calculator,principalCents}'
      <> p_principal_cents::TEXT
    OR p_evidence #>> '{creditLife,election}' <> p_election
    OR p_evidence #>> '{creditLife,monthlyPremiumCents}'
      <> p_monthly_premium_cents::TEXT
    OR p_evidence #>> '{creditLife,disclosureVersion}'
      <> p_disclosure_version
    OR p_evidence #>> '{creditLife,disclosureSha256}'
      <> p_disclosure_sha256
  THEN
    RETURN FALSE;
  END IF;

  IF is_no_offer THEN
    -- No cover was offered: no identity anywhere, no premium, decline only.
    IF
      p_election <> 'DECLINED'
      OR p_monthly_premium_cents <> 0
      OR p_credit_life_product_id IS NOT NULL
      OR p_credit_life_product_name IS NOT NULL
      OR p_credit_life_insurer_id IS NOT NULL
      OR p_credit_life_insurer_name IS NOT NULL
      OR p_evidence #>> '{creditLife,productId}' IS NOT NULL
      OR p_evidence #>> '{creditLife,productName}' IS NOT NULL
      OR p_evidence #>> '{creditLife,insurerId}' IS NOT NULL
      OR p_evidence #>> '{creditLife,insurerName}' IS NOT NULL
      OR "creditLifeNoOfferDisclosureSha256"(
        p_disclosure_version,
        p_election,
        p_principal_cents,
        p_term_days
      ) <> p_disclosure_sha256
    THEN
      RETURN FALSE;
    END IF;
  ELSE
    IF
      p_credit_life_product_id IS NULL
      OR p_credit_life_product_name IS NULL
      OR p_credit_life_insurer_id IS NULL
      OR p_credit_life_insurer_name IS NULL
      OR p_monthly_premium_cents
        <> ROUND(p_principal_cents::NUMERIC * 0.0045)::INTEGER
      OR p_evidence #>> '{creditLife,productId}'
        <> p_credit_life_product_id
      OR p_evidence #>> '{creditLife,productName}'
        <> p_credit_life_product_name
      OR p_evidence #>> '{creditLife,insurerId}'
        <> p_credit_life_insurer_id
      OR p_evidence #>> '{creditLife,insurerName}'
        <> p_credit_life_insurer_name
      OR "creditLifeDisclosureSha256"(
        p_disclosure_version,
        p_election,
        p_principal_cents,
        p_term_days,
        p_monthly_premium_cents,
        p_credit_life_product_id,
        p_credit_life_product_name,
        p_credit_life_insurer_id,
        p_credit_life_insurer_name
      ) <> p_disclosure_sha256
    THEN
      RETURN FALSE;
    END IF;
  END IF;

  expected_periods := GREATEST(
    1,
    CEIL(p_term_days::NUMERIC / 30)::INTEGER,
    JSONB_ARRAY_LENGTH(p_evidence #> '{calculator,schedule}')
  );
  expected_total_premium := CASE
    WHEN p_election = 'ACCEPTED'
      THEN p_monthly_premium_cents::BIGINT * expected_periods
    ELSE 0
  END;

  IF
    p_evidence #>> '{creditLife,premiumPeriods}'
      <> expected_periods::TEXT
    OR p_evidence #>> '{creditLife,totalPremiumCents}'
      <> expected_total_premium::TEXT
  THEN
    RETURN FALSE;
  END IF;

  FOR schedule_item IN
    SELECT value
    FROM JSONB_ARRAY_ELEMENTS(p_evidence #> '{billing,schedule}')
  LOOP
    IF
      schedule_item ->> 'creditLifePremiumDueCents' IS NULL
      OR (schedule_item ->> 'creditLifePremiumDueCents')::BIGINT < 0
    THEN
      RETURN FALSE;
    END IF;
    scheduled_total_premium := scheduled_total_premium
      + (schedule_item ->> 'creditLifePremiumDueCents')::BIGINT;
  END LOOP;

  RETURN scheduled_total_premium = expected_total_premium;
EXCEPTION
  WHEN OTHERS THEN
    RETURN FALSE;
END;
$function$;

CREATE OR REPLACE FUNCTION public."pasqEvidenceSha256"(p_evidence jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  fields TEXT[];
  required_values TEXT[];
  required_value TEXT;
  schedule_item JSONB;
BEGIN
  IF
    JSONB_TYPEOF(p_evidence) <> 'object'
    OR JSONB_TYPEOF(p_evidence -> 'calculator') <> 'object'
    OR JSONB_TYPEOF(p_evidence #> '{calculator,schedule}') <> 'array'
    OR JSONB_ARRAY_LENGTH(p_evidence #> '{calculator,schedule}') = 0
    OR JSONB_TYPEOF(p_evidence -> 'creditLife') <> 'object'
  THEN
    RETURN NULL;
  END IF;

  required_values := ARRAY[
    p_evidence ->> 'version',
    p_evidence ->> 'tenantId',
    p_evidence ->> 'applicationId',
    p_evidence ->> 'clientId',
    p_evidence ->> 'productId',
    p_evidence ->> 'termDays',
    p_evidence ->> 'generatedAt',
    p_evidence #>> '{calculator,version}',
    p_evidence #>> '{calculator,startDate}',
    p_evidence #>> '{calculator,principalCents}',
    p_evidence #>> '{calculator,totalInterestCents}',
    p_evidence #>> '{calculator,initiationFeeCents}',
    p_evidence #>> '{calculator,serviceFeesCents}',
    p_evidence #>> '{calculator,totalRepayableCents}',
    p_evidence #>> '{calculator,disbursementAmountCents}',
    p_evidence #>> '{calculator,recurringInstalmentCents}',
    p_evidence #>> '{calculator,pricingFingerprint}',
    p_evidence #>> '{calculator,contractFingerprint}',
    p_evidence #>> '{creditLife,election}',
    p_evidence #>> '{creditLife,productId}',
    p_evidence #>> '{creditLife,productName}',
    p_evidence #>> '{creditLife,insurerId}',
    p_evidence #>> '{creditLife,insurerName}',
    p_evidence #>> '{creditLife,monthlyPremiumCents}',
    p_evidence #>> '{creditLife,premiumPeriods}',
    p_evidence #>> '{creditLife,totalPremiumCents}',
    p_evidence #>> '{creditLife,disclosureVersion}',
    p_evidence #>> '{creditLife,disclosureSha256}',
    p_evidence ->> 'totalCostOfCreditCents'
  ];
  FOREACH required_value IN ARRAY required_values LOOP
    IF required_value IS NULL OR LENGTH(required_value) = 0 THEN
      RETURN NULL;
    END IF;
  END LOOP;

  fields := ARRAY[
    'pasq-evidence-envelope-v2',
    "utf8Hex"(p_evidence ->> 'version'),
    "utf8Hex"(p_evidence ->> 'tenantId'),
    "utf8Hex"(p_evidence ->> 'applicationId'),
    "utf8Hex"(p_evidence ->> 'clientId'),
    "utf8Hex"(p_evidence ->> 'productId'),
    "utf8Hex"(p_evidence ->> 'termDays'),
    "utf8Hex"(p_evidence ->> 'generatedAt'),
    "utf8Hex"(p_evidence #>> '{calculator,version}'),
    "utf8Hex"(p_evidence #>> '{calculator,startDate}'),
    "utf8Hex"(p_evidence #>> '{calculator,principalCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,totalInterestCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,initiationFeeCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,serviceFeesCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,totalRepayableCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,disbursementAmountCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,recurringInstalmentCents}'),
    "utf8Hex"(
      JSONB_ARRAY_LENGTH(p_evidence #> '{calculator,schedule}')::TEXT
    )
  ];

  FOR schedule_item IN
    SELECT value
    FROM JSONB_ARRAY_ELEMENTS(p_evidence #> '{calculator,schedule}')
  LOOP
    required_values := ARRAY[
      schedule_item ->> 'installmentNo',
      schedule_item ->> 'dueDate',
      schedule_item ->> 'principalDueCents',
      schedule_item ->> 'interestDueCents',
      schedule_item ->> 'feesDueCents',
      schedule_item ->> 'totalDueCents',
      schedule_item ->> 'openingBalanceCents',
      schedule_item ->> 'closingBalanceCents'
    ];
    FOREACH required_value IN ARRAY required_values LOOP
      IF required_value IS NULL OR LENGTH(required_value) = 0 THEN
        RETURN NULL;
      END IF;
      fields := ARRAY_APPEND(fields, "utf8Hex"(required_value));
    END LOOP;
  END LOOP;

  fields := fields || ARRAY[
    "utf8Hex"(p_evidence #>> '{calculator,pricingFingerprint}'),
    "utf8Hex"(p_evidence #>> '{calculator,contractFingerprint}'),
    "utf8Hex"(p_evidence #>> '{creditLife,election}'),
    "utf8Hex"(p_evidence #>> '{creditLife,productId}'),
    "utf8Hex"(p_evidence #>> '{creditLife,productName}'),
    "utf8Hex"(p_evidence #>> '{creditLife,insurerId}'),
    "utf8Hex"(p_evidence #>> '{creditLife,insurerName}'),
    "utf8Hex"(p_evidence #>> '{creditLife,monthlyPremiumCents}'),
    "utf8Hex"(p_evidence #>> '{creditLife,premiumPeriods}'),
    "utf8Hex"(p_evidence #>> '{creditLife,totalPremiumCents}'),
    "utf8Hex"(p_evidence #>> '{creditLife,disclosureVersion}'),
    "utf8Hex"(p_evidence #>> '{creditLife,disclosureSha256}'),
    "utf8Hex"(p_evidence ->> 'totalCostOfCreditCents')
  ];

  RETURN encode(
    sha256(convert_to(ARRAY_TO_STRING(fields, ':'), 'UTF8')),
    'hex'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public."pasqEvidenceSha256V3"(p_evidence jsonb)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
DECLARE
  fields TEXT[];
  required_values TEXT[];
  required_value TEXT;
  schedule_item JSONB;
  is_no_offer BOOLEAN;
BEGIN
  IF
    JSONB_TYPEOF(p_evidence) <> 'object'
    OR JSONB_TYPEOF(p_evidence -> 'calculator') <> 'object'
    OR JSONB_TYPEOF(p_evidence #> '{calculator,schedule}') <> 'array'
    OR JSONB_ARRAY_LENGTH(p_evidence #> '{calculator,schedule}') = 0
    OR JSONB_TYPEOF(p_evidence -> 'creditLife') <> 'object'
    OR JSONB_TYPEOF(p_evidence -> 'billing') <> 'object'
    OR JSONB_TYPEOF(p_evidence #> '{billing,schedule}') <> 'array'
    OR JSONB_ARRAY_LENGTH(p_evidence #> '{billing,schedule}') = 0
  THEN
    RETURN NULL;
  END IF;

  is_no_offer := COALESCE(
    p_evidence #>> '{creditLife,disclosureVersion}' = 'credit-life-no-offer-v1',
    FALSE
  );

  -- A no-offer disclosure that also carries an identity is a corrupted record,
  -- not a no-offer one. Fail closed rather than hash a contradiction.
  IF is_no_offer AND (
    p_evidence #>> '{creditLife,productId}' IS NOT NULL
    OR p_evidence #>> '{creditLife,productName}' IS NOT NULL
    OR p_evidence #>> '{creditLife,insurerId}' IS NOT NULL
    OR p_evidence #>> '{creditLife,insurerName}' IS NOT NULL
    OR p_evidence #>> '{creditLife,election}' <> 'DECLINED'
    OR p_evidence #>> '{creditLife,monthlyPremiumCents}' <> '0'
    OR p_evidence #>> '{creditLife,totalPremiumCents}' <> '0'
  ) THEN
    RETURN NULL;
  END IF;

  required_values := ARRAY[
    p_evidence ->> 'version',
    p_evidence ->> 'tenantId',
    p_evidence ->> 'applicationId',
    p_evidence ->> 'clientId',
    p_evidence ->> 'productId',
    p_evidence ->> 'termDays',
    p_evidence ->> 'generatedAt',
    p_evidence #>> '{calculator,version}',
    p_evidence #>> '{calculator,startDate}',
    p_evidence #>> '{calculator,principalCents}',
    p_evidence #>> '{calculator,totalInterestCents}',
    p_evidence #>> '{calculator,initiationFeeCents}',
    p_evidence #>> '{calculator,serviceFeesCents}',
    p_evidence #>> '{calculator,totalRepayableCents}',
    p_evidence #>> '{calculator,disbursementAmountCents}',
    p_evidence #>> '{calculator,recurringInstalmentCents}',
    p_evidence #>> '{calculator,pricingFingerprint}',
    p_evidence #>> '{calculator,contractFingerprint}',
    p_evidence #>> '{creditLife,election}'
  ];
  IF NOT is_no_offer THEN
    required_values := required_values || ARRAY[
      p_evidence #>> '{creditLife,productId}',
      p_evidence #>> '{creditLife,productName}',
      p_evidence #>> '{creditLife,insurerId}',
      p_evidence #>> '{creditLife,insurerName}'
    ];
  END IF;
  required_values := required_values || ARRAY[
    p_evidence #>> '{creditLife,monthlyPremiumCents}',
    p_evidence #>> '{creditLife,premiumPeriods}',
    p_evidence #>> '{creditLife,totalPremiumCents}',
    p_evidence #>> '{creditLife,disclosureVersion}',
    p_evidence #>> '{creditLife,disclosureSha256}',
    p_evidence #>> '{billing,version}',
    p_evidence #>> '{billing,collectionMethod}',
    p_evidence #>> '{billing,recurringPaymentCents}',
    p_evidence #>> '{billing,totalRepayableCents}',
    p_evidence ->> 'totalCostOfCreditCents'
  ];
  FOREACH required_value IN ARRAY required_values LOOP
    IF required_value IS NULL OR LENGTH(required_value) = 0 THEN
      RETURN NULL;
    END IF;
  END LOOP;

  fields := ARRAY[
    'pasq-evidence-envelope-v3',
    "utf8Hex"(p_evidence ->> 'version'),
    "utf8Hex"(p_evidence ->> 'tenantId'),
    "utf8Hex"(p_evidence ->> 'applicationId'),
    "utf8Hex"(p_evidence ->> 'clientId'),
    "utf8Hex"(p_evidence ->> 'productId'),
    "utf8Hex"(p_evidence ->> 'termDays'),
    "utf8Hex"(p_evidence ->> 'generatedAt'),
    "utf8Hex"(p_evidence #>> '{calculator,version}'),
    "utf8Hex"(p_evidence #>> '{calculator,startDate}'),
    "utf8Hex"(p_evidence #>> '{calculator,principalCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,totalInterestCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,initiationFeeCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,serviceFeesCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,totalRepayableCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,disbursementAmountCents}'),
    "utf8Hex"(p_evidence #>> '{calculator,recurringInstalmentCents}'),
    "utf8Hex"(
      JSONB_ARRAY_LENGTH(p_evidence #> '{calculator,schedule}')::TEXT
    )
  ];

  FOR schedule_item IN
    SELECT value
    FROM JSONB_ARRAY_ELEMENTS(p_evidence #> '{calculator,schedule}')
  LOOP
    required_values := ARRAY[
      schedule_item ->> 'installmentNo',
      schedule_item ->> 'dueDate',
      schedule_item ->> 'principalDueCents',
      schedule_item ->> 'interestDueCents',
      schedule_item ->> 'feesDueCents',
      schedule_item ->> 'totalDueCents',
      schedule_item ->> 'openingBalanceCents',
      schedule_item ->> 'closingBalanceCents'
    ];
    FOREACH required_value IN ARRAY required_values LOOP
      IF required_value IS NULL OR LENGTH(required_value) = 0 THEN
        RETURN NULL;
      END IF;
      fields := ARRAY_APPEND(fields, "utf8Hex"(required_value));
    END LOOP;
  END LOOP;

  fields := fields || ARRAY[
    "utf8Hex"(p_evidence #>> '{calculator,pricingFingerprint}'),
    "utf8Hex"(p_evidence #>> '{calculator,contractFingerprint}'),
    "utf8Hex"(p_evidence #>> '{creditLife,election}')
  ];
  IF NOT is_no_offer THEN
    fields := fields || ARRAY[
      "utf8Hex"(p_evidence #>> '{creditLife,productId}'),
      "utf8Hex"(p_evidence #>> '{creditLife,productName}'),
      "utf8Hex"(p_evidence #>> '{creditLife,insurerId}'),
      "utf8Hex"(p_evidence #>> '{creditLife,insurerName}')
    ];
  END IF;
  fields := fields || ARRAY[
    "utf8Hex"(p_evidence #>> '{creditLife,monthlyPremiumCents}'),
    "utf8Hex"(p_evidence #>> '{creditLife,premiumPeriods}'),
    "utf8Hex"(p_evidence #>> '{creditLife,totalPremiumCents}'),
    "utf8Hex"(p_evidence #>> '{creditLife,disclosureVersion}'),
    "utf8Hex"(p_evidence #>> '{creditLife,disclosureSha256}'),
    "utf8Hex"(p_evidence #>> '{billing,version}'),
    "utf8Hex"(p_evidence #>> '{billing,collectionMethod}'),
    "utf8Hex"(p_evidence #>> '{billing,recurringPaymentCents}'),
    "utf8Hex"(p_evidence #>> '{billing,totalRepayableCents}'),
    "utf8Hex"(
      JSONB_ARRAY_LENGTH(p_evidence #> '{billing,schedule}')::TEXT
    )
  ];

  FOR schedule_item IN
    SELECT value
    FROM JSONB_ARRAY_ELEMENTS(p_evidence #> '{billing,schedule}')
  LOOP
    required_values := ARRAY[
      schedule_item ->> 'installmentNo',
      schedule_item ->> 'dueDate',
      schedule_item ->> 'principalDueCents',
      schedule_item ->> 'interestDueCents',
      schedule_item ->> 'baseFeesDueCents',
      schedule_item ->> 'creditLifePremiumDueCents',
      schedule_item ->> 'feesDueCents',
      schedule_item ->> 'totalDueCents',
      schedule_item ->> 'openingBalanceCents',
      schedule_item ->> 'closingBalanceCents'
    ];
    FOREACH required_value IN ARRAY required_values LOOP
      IF required_value IS NULL OR LENGTH(required_value) = 0 THEN
        RETURN NULL;
      END IF;
      fields := ARRAY_APPEND(fields, "utf8Hex"(required_value));
    END LOOP;
  END LOOP;

  fields := ARRAY_APPEND(
    fields,
    "utf8Hex"(p_evidence ->> 'totalCostOfCreditCents')
  );

  RETURN encode(
    sha256(convert_to(ARRAY_TO_STRING(fields, ':'), 'UTF8')),
    'hex'
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public."providerCountersignEnvelopeSha256"(p_application_id text, p_client_id text, p_document_sha256 text, p_consumer_signed_at timestamp without time zone, p_consumer_signed_method text, p_consumer_signer_id text, p_consumer_signature_sha256 text, p_provider_countersigned_at timestamp without time zone, p_provider_signer_id text, p_provider_signer_name text, p_provider_signer_email text, p_provider_signature_sha256 text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT encode(
    sha256(
      convert_to(
        array_to_string(ARRAY[
          'provider-countersign-envelope-v2',
          encode(convert_to(COALESCE(p_application_id, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_client_id, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_document_sha256, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(
            to_char(p_consumer_signed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            ''
          ), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_consumer_signed_method, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_consumer_signer_id, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_consumer_signature_sha256, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(
            to_char(p_provider_countersigned_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            ''
          ), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_provider_signer_id, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_provider_signer_name, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_provider_signer_email, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_provider_signature_sha256, ''), 'UTF8'), 'hex')
        ], ':'),
        'UTF8'
      )
    ),
    'hex'
  );
$function$;

CREATE OR REPLACE FUNCTION public."providerCountersignEnvelopeSha256"(p_tenant_id text, p_application_id text, p_client_id text, p_document_sha256 text, p_consumer_signed_at timestamp without time zone, p_consumer_signed_method text, p_consumer_signer_id text, p_consumer_signature_sha256 text, p_provider_countersigned_at timestamp without time zone, p_provider_signer_id text, p_provider_signer_name text, p_provider_signer_email text, p_provider_signature_sha256 text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT encode(
    sha256(
      convert_to(
        array_to_string(ARRAY[
          'provider-countersign-envelope-v3',
          encode(convert_to(COALESCE(p_tenant_id, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_application_id, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_client_id, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_document_sha256, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(
            to_char(p_consumer_signed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            ''
          ), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_consumer_signed_method, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_consumer_signer_id, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_consumer_signature_sha256, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(
            to_char(p_provider_countersigned_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            ''
          ), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_provider_signer_id, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_provider_signer_name, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_provider_signer_email, ''), 'UTF8'), 'hex'),
          encode(convert_to(COALESCE(p_provider_signature_sha256, ''), 'UTF8'), 'hex')
        ], ':'),
        'UTF8'
      )
    ),
    'hex'
  );
$function$;

CREATE OR REPLACE FUNCTION public."quoteValidUntilDate"(p_presented_at timestamp with time zone, p_business_days integer DEFAULT 5)
 RETURNS date
 LANGUAGE plpgsql
 STABLE PARALLEL RESTRICTED
AS $function$
DECLARE
  result_date DATE :=
    (p_presented_at AT TIME ZONE 'Africa/Johannesburg')::DATE;
  remaining INTEGER := p_business_days;
BEGIN
  IF p_business_days < 0 THEN
    RAISE EXCEPTION 'Business-day count must not be negative';
  END IF;
  WHILE remaining > 0 LOOP
    result_date := result_date + 1;
    IF "isSaBusinessDate"(result_date) THEN
      remaining := remaining - 1;
    END IF;
  END LOOP;
  RETURN result_date;
END;
$function$;

CREATE OR REPLACE FUNCTION public."utf8Hex"(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
  SELECT encode(convert_to(p_value, 'UTF8'), 'hex');
$function$;

CREATE OR REPLACE FUNCTION public."validOutageDisbursementException"(application_tenant_id text, application_id text, application_reference text, application_disbursed_at timestamp without time zone, exception_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT (
    -- The per-application payout dates form an allow-list that is
    -- intentionally EMPTY in this product. The comparison is against NULL, so
    -- it is NULL and `IS TRUE` below returns false: no application has a
    -- declared payout date, so every application fails closed.
    application_disbursed_at = NULL::TIMESTAMP
    AND "validOutageDisbursementExceptionRecord"(
      application_tenant_id,
      application_id,
      application_reference,
      exception_id
    )
  ) IS TRUE;
$function$;

CREATE OR REPLACE FUNCTION public."validOutageDisbursementExceptionRecord"(application_tenant_id text, application_id text, application_reference text, exception_id text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM "ComplianceRecord" AS exception
    WHERE exception."id" = exception_id
      AND exception."tenantId" = application_tenant_id
      AND exception."referenceId" = application_id
      AND exception."data" ->> 'applicationReference'
        = application_reference
      AND EXISTS (
        SELECT 1
        FROM "User" AS reconciler
        WHERE reconciler."id" = exception."data" ->> 'reconciledById'
          AND reconciler."tenantId" = exception."tenantId"
          AND reconciler."active" = TRUE
          AND reconciler."role" = 'SUPER_ADMIN'::"UserRole"
          AND LOWER(reconciler."email")
            = exception."data" ->> 'reconciledByEmail'
      )
      AND "validOutageDisbursementExceptionValues"(
        exception."tenantId",
        exception."id",
        exception."type",
        exception."referenceId",
        exception."idempotencyKey",
        exception."status",
        exception."completedAt",
        exception."data"
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public."validOutageDisbursementExceptionValues"(record_tenant_id text, record_id text, record_type "ComplianceType", record_reference_id text, record_idempotency_key text, record_status "ComplianceStatus", record_completed_at timestamp without time zone, record_data jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT (
    record_tenant_id IS NOT NULL
    AND LENGTH(BTRIM(record_tenant_id)) > 0
    AND record_id IS NOT NULL
    AND LENGTH(BTRIM(record_id)) > 0
    AND record_type = 'DISBURSEMENT_EXCEPTION'::"ComplianceType"
    AND record_status = 'COMPLETED'::"ComplianceStatus"
    AND record_completed_at IS NOT NULL
    AND JSONB_TYPEOF(record_data) = 'object'
    AND (
      SELECT COUNT(*)
      FROM JSONB_OBJECT_KEYS(record_data)
    ) = 14
    AND record_data ->> 'kind' = 'DISBURSEMENT_OUTAGE_EXCEPTION'
    AND record_data ->> 'version' = 'disbursement-outage-exception-v1'
    AND record_data ->> 'timestampPrecision' = 'DATE'
    AND LENGTH(
      REGEXP_REPLACE(
        BTRIM(record_data ->> 'managementApprovalNote'),
        '\s+',
        ' ',
        'g'
      )
    ) >= 20
    AND LENGTH(BTRIM(record_data ->> 'reconciledById')) > 0
    AND LENGTH(BTRIM(record_data ->> 'reconciledByEmail')) > 0
    AND record_data ->> 'reconciledByEmail'
      = LOWER(record_data ->> 'reconciledByEmail')
    AND CASE
      WHEN record_data ->> 'reconciledAt'
        ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      THEN
        (
          (record_data ->> 'reconciledAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
        ) = record_completed_at
      ELSE FALSE
    END
    AND record_data -> 'duplicatePayoutSuppressed' = 'true'::JSONB
    AND record_reference_id = record_data ->> 'applicationId'
    AND record_idempotency_key =
      'outage-disbursement:' || (record_data ->> 'applicationId')
    -- incidentId, actualPayoutDate, managementApprovedBy and
    -- waivedPreconditions are pinned PER APPLICATION by an allow-list that is
    -- intentionally EMPTY in this product: no evidence record matches.
    AND FALSE
  ) IS TRUE;
$function$;

CREATE OR REPLACE FUNCTION public."validateOutageDisbursementLoan"(target_loan_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  booked RECORD;
  calculator JSONB;
  expected_schedule_count INTEGER;
  actual_schedule_count INTEGER;
  actual_total_due BIGINT;
  actual_total_interest BIGINT;
  actual_schedule_paid BIGINT;
  allocated_receipts BIGINT;
  realised_principal BIGINT;
  expected_maturity TIMESTAMP(3);
  expected_next_payment TIMESTAMP(3);
  expected_total_interest INTEGER;
  expected_total_repayable INTEGER;
  serviced BOOLEAN;
BEGIN
  SELECT
    loan.*,
    application."tenantId" AS application_tenant_id,
    application."reference" AS application_reference,
    application."clientId" AS application_client_id,
    application."productId" AS application_product_id,
    application."appliedAmount",
    application."appliedTermDays",
    application."approvedAmount",
    application."approvedTermDays",
    application."approvedRate",
    application."affordabilityResult",
    application."repaymentMethod",
    application."creditLifeElection",
    application."creditLifeProductId",
    application."creditLifeInsurerId",
    application."creditLifeMonthlyPremiumCents",
    application."status" AS application_status,
    application."disbursedAt" AS application_disbursed_at,
    application."disbursementExceptionId"
  INTO booked
  FROM "Loan" AS loan
  JOIN "LoanApplication" AS application
    ON application."id" = loan."applicationId"
  WHERE loan."id" = target_loan_id;

  IF NOT FOUND OR NOT "validOutageDisbursementException"(
    booked.application_tenant_id,
    booked."applicationId",
    booked.application_reference,
    booked.application_disbursed_at,
    booked."disbursementExceptionId"
  ) THEN
    RETURN;
  END IF;

  -- The per-application binding calculator (CONTRACT or APPROVAL, matching
  -- calculatorSource on the TS policy) comes from an allow-list that is
  -- intentionally EMPTY in this product, so no application has one. Unreachable
  -- in practice: validOutageDisbursementException above is false for every
  -- application, so this function has already returned.
  calculator := NULL;

  IF JSONB_TYPEOF(calculator) <> 'object'
     OR calculator ->> 'version' <> 'loan-calculator-v3'
     OR JSONB_TYPEOF(calculator -> 'schedule') <> 'array'
     OR JSONB_ARRAY_LENGTH(calculator -> 'schedule') = 0
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Outage reconciliation requires the intact reviewed calculator';
  END IF;

  SELECT
    (
      (expected ->> 'dueDate')::TIMESTAMPTZ
      AT TIME ZONE 'UTC'
    )
  INTO expected_next_payment
  FROM JSONB_ARRAY_ELEMENTS(calculator -> 'schedule') AS expected
  ORDER BY (expected ->> 'installmentNo')::INTEGER
  LIMIT 1;

  SELECT
    (
      (expected ->> 'dueDate')::TIMESTAMPTZ
      AT TIME ZONE 'UTC'
    )
  INTO expected_maturity
  FROM JSONB_ARRAY_ELEMENTS(calculator -> 'schedule') AS expected
  ORDER BY (expected ->> 'installmentNo')::INTEGER DESC
  LIMIT 1;

  expected_schedule_count := JSONB_ARRAY_LENGTH(calculator -> 'schedule');
  expected_total_interest := (calculator ->> 'totalInterestCents')::INTEGER;
  expected_total_repayable := (calculator ->> 'totalRepayableCents')::INTEGER;

  SELECT
    COUNT(*)::INTEGER,
    COALESCE(SUM(schedule."totalDue"), 0),
    COALESCE(SUM(schedule."interestDue"), 0),
    COALESCE(SUM(schedule."totalPaid"), 0),
    -- The principal portion a receipt actually realises: whatever is left of a
    -- row's payment after its fees and interest, capped at the row's principal.
    -- Mirrors recomputeLoanBalances exactly (NCA s.126 order).
    COALESCE(SUM(
      LEAST(
        schedule."principalDue",
        GREATEST(
          0,
          schedule."totalPaid" - schedule."interestDue" - schedule."feesDue"
        )
      )
    ), 0)
  INTO
    actual_schedule_count,
    actual_total_due,
    actual_total_interest,
    actual_schedule_paid,
    realised_principal
  FROM "RepaymentSchedule" AS schedule
  WHERE schedule."loanId" = booked."id";

  -- Live money only: a reversed receipt is retired, and the refund-due half of
  -- an over-payment was never collected. Both are excluded from totalPaid by
  -- every writer in the codebase (lib/loan/apply-payment.ts,
  -- app/api/payments/[id]/reverse/route.ts, lib/bank-sync/apply.ts).
  SELECT COALESCE(SUM(
    receipt."amount"
    - receipt."defaultInterestAllocated"
    - receipt."chargeFeesAllocated"
  ), 0)
  INTO allocated_receipts
  FROM "Payment" AS receipt
  WHERE receipt."loanId" = booked."id"
    AND receipt."reversed" = FALSE
    AND receipt."allocationStatus" = 'ALLOCATED'::"PaymentAllocationStatus";

  -- A receipt is the point the loan leaves the reconciliation window. The
  -- pasq_v3 triggers are DEFERRABLE INITIALLY DEFERRED, so they run at COMMIT
  -- (or SET CONSTRAINTS ALL IMMEDIATE) with the Payment row already inserted
  -- by the same transaction that moved the balances.
  serviced := EXISTS (
    SELECT 1 FROM "Payment" AS receipt WHERE receipt."loanId" = booked."id"
  );

  -- Band 1 + 2. The contract, and the arithmetic that ties the balances to the
  -- receipts and the schedule. Enforced for the life of the loan.
  IF
    booked.application_status <> 'DISBURSED'::"AppStatus"
    OR booked."tenantId" <> booked.application_tenant_id
    OR booked."clientId" <> booked.application_client_id
    OR booked."productId" <> booked.application_product_id
    OR booked."principal" <> booked."approvedAmount"
    OR booked."principal" <> (calculator ->> 'principalCents')::INTEGER
    OR booked."initiationFee"
      <> (calculator ->> 'initiationFeeCents')::INTEGER
    OR booked."creditLifePremiums" <> 0
    OR booked."startDate" <> booked.application_disbursed_at
    OR booked."maturityDate" <> expected_maturity
    OR booked."interestRatePm" <> booked."approvedRate"
    OR booked."interestModel" <> 'DAILY_ACCRUAL'::"InterestModel"
    OR booked."repaymentMethod" <> 'EFT'::"LoanRepaymentMethod"
    OR booked."creditLifeElection" <> 'DECLINED'::"CreditLifeElection"
    OR booked."creditLifeProductId" IS NOT NULL
    OR booked."creditLifeInsurerId" IS NOT NULL
    OR booked."creditLifeMonthlyPremiumCents" <> 0
    OR actual_schedule_count <> expected_schedule_count
    -- Nullable columns, checked explicitly: a comparison against NULL is NULL,
    -- not TRUE, so an OR chain that raises on TRUE lets a NULL through.
    OR booked."contractualTotalInterest" IS NULL
    OR booked."contractualTotalRepayable" IS NULL
    OR booked."totalPaid" <> allocated_receipts
    OR booked."totalPaid" <> actual_schedule_paid
    OR booked."totalInterest" <> actual_total_interest
    OR booked."totalRepayable" <> actual_total_due
    OR booked."outstandingPrincipal"
      <> GREATEST(0, booked."principal" - realised_principal)
    OR booked."nextPaymentDate" IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM "RepaymentSchedule" AS actual
         WHERE actual."loanId" = booked."id"
           AND actual."dueDate" = booked."nextPaymentDate"
       )
    OR EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(calculator -> 'schedule') AS expected
      LEFT JOIN "RepaymentSchedule" AS actual
        ON actual."loanId" = booked."id"
        AND actual."installmentNo"
          = (expected ->> 'installmentNo')::INTEGER
      WHERE actual."id" IS NULL
        OR actual."tenantId" <> booked."tenantId"
        OR actual."dueDate" <> (
          (expected ->> 'dueDate')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
        )
        OR actual."principalDue"
          <> (expected ->> 'principalDueCents')::INTEGER
        OR actual."creditLifePremiumDue" <> 0
        OR actual."feesDue" <> (expected ->> 'feesDueCents')::INTEGER
        OR actual."totalDue" <> actual."principalDue" + actual."interestDue"
          + actual."creditLifePremiumDue" + actual."feesDue"
        OR actual."totalPaid" < 0
        OR actual."totalPaid" > actual."totalDue"
    )
    OR EXISTS (
      SELECT 1
      FROM "RepaymentSchedule" AS actual
      WHERE actual."loanId" = booked."id"
        AND NOT EXISTS (
          SELECT 1
          FROM JSONB_ARRAY_ELEMENTS(calculator -> 'schedule') AS expected
          WHERE (expected ->> 'installmentNo')::INTEGER
            = actual."installmentNo"
        )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Outage loan and schedule must match the intact reviewed calculator';
  END IF;

  IF NOT serviced THEN
    -- Band 3, as booked: before a cent has been collected, exact.
    IF
      booked."totalInterest" <> expected_total_interest
      OR booked."totalRepayable" <> expected_total_repayable
      OR booked."contractualTotalInterest" <> expected_total_interest
      OR booked."contractualTotalRepayable" <> expected_total_repayable
      OR booked."outstandingPrincipal" <> booked."principal"
      OR booked."totalPaid" <> 0
      OR booked."nextPaymentDate" <> expected_next_payment
      OR EXISTS (
        SELECT 1
        FROM JSONB_ARRAY_ELEMENTS(calculator -> 'schedule') AS expected
        JOIN "RepaymentSchedule" AS actual
          ON actual."loanId" = booked."id"
          AND actual."installmentNo"
            = (expected ->> 'installmentNo')::INTEGER
        WHERE actual."interestDue"
            <> (expected ->> 'interestDueCents')::INTEGER
          OR actual."totalDue" <> (expected ->> 'totalDueCents')::INTEGER
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Outage loan and schedule must match the intact reviewed calculator';
    END IF;

    RETURN;
  END IF;

  -- Band 3, serviced: interest may be rebated down to what was earned, and
  -- nothing may enlarge what an outage-booked loan charges. Band 2 already
  -- ties every other figure to the receipts and the schedule.
  IF
    booked."totalInterest" < 0
    OR booked."totalInterest" > expected_total_interest
    OR booked."totalRepayable" < 0
    OR booked."totalRepayable" > expected_total_repayable
    OR booked."contractualTotalInterest" < 0
    OR booked."contractualTotalInterest" > expected_total_interest
    OR booked."contractualTotalRepayable" < 0
    OR booked."contractualTotalRepayable" > expected_total_repayable
    OR EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(calculator -> 'schedule') AS expected
      JOIN "RepaymentSchedule" AS actual
        ON actual."loanId" = booked."id"
        AND actual."installmentNo"
          = (expected ->> 'installmentNo')::INTEGER
      WHERE actual."interestDue" < 0
        OR actual."interestDue" > (expected ->> 'interestDueCents')::INTEGER
        OR actual."totalDue" < 0
        OR actual."totalDue" > (expected ->> 'totalDueCents')::INTEGER
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Outage loan servicing may not exceed the intact reviewed calculator';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assert_payment_allocation_reconciles()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  mismatch RECORD;
BEGIN
  SELECT
    loan."id" AS loan_id,
    loan."tenantId" AS tenant_id,
    loan."totalPaid" AS loan_total_paid,
    COALESCE(
      SUM(
        payment."amount"
        - payment."defaultInterestAllocated"
        - payment."chargeFeesAllocated"
      ) FILTER (
        WHERE payment."reversed" = false
          AND payment."allocationStatus" = 'ALLOCATED'
      ),
      0
    )::BIGINT AS allocated_total
  INTO mismatch
  FROM "Loan" AS loan
  LEFT JOIN "Payment" AS payment
    ON payment."loanId" = loan."id"
   AND payment."tenantId" = loan."tenantId"
  GROUP BY loan."id", loan."tenantId", loan."totalPaid"
  HAVING COALESCE(
    SUM(
      payment."amount"
      - payment."defaultInterestAllocated"
      - payment."chargeFeesAllocated"
    ) FILTER (
      WHERE payment."reversed" = false
        AND payment."allocationStatus" = 'ALLOCATED'
    ),
    0
  )::BIGINT <> loan."totalPaid"::BIGINT
  ORDER BY loan."id"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Payment allocation backfill is ambiguous for loan %s (tenant %s): Loan.totalPaid=%s, evidenced allocated receipts=%s',
        mismatch.loan_id,
        mismatch.tenant_id,
        mismatch.loan_total_paid,
        mismatch.allocated_total
      ),
      HINT = 'Reconcile the historical payment ledger and its audit evidence before retrying migrate deploy.';
  END IF;

  SELECT
    payment."id" AS payment_id,
    payment."tenantId" AS payment_tenant_id,
    loan."tenantId" AS loan_tenant_id
  INTO mismatch
  FROM "Payment" AS payment
  JOIN "Loan" AS loan ON loan."id" = payment."loanId"
  WHERE payment."tenantId" <> loan."tenantId"
  ORDER BY payment."id"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format(
        'Payment %s tenant %s does not match its loan tenant %s',
        mismatch.payment_id,
        mismatch.payment_tenant_id,
        mismatch.loan_tenant_id
      ),
      HINT = 'Repair the cross-tenant payment ownership before retrying migrate deploy.';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.assign_biometric_attempt_sequence()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  next_sequence INTEGER;
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."docType" = 'SELFIE'
    AND (
      NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
      OR NEW."docType" IS DISTINCT FROM OLD."docType"
      OR NEW."biometricAttemptSequence" IS DISTINCT FROM OLD."biometricAttemptSequence"
    )
  THEN
    RAISE EXCEPTION 'Biometric attempt identity and sequence are immutable';
  END IF;

  IF NEW."docType" = 'SELFIE'
    AND (
      TG_OP = 'INSERT'
      OR OLD."docType" IS DISTINCT FROM 'SELFIE'
    )
  THEN
    PERFORM pg_advisory_xact_lock(
      hashtext(
        'affordability-client:' || NEW."tenantId" || ':' || NEW."clientId"
      )
    );
    SELECT COALESCE(MAX(document."biometricAttemptSequence"), 0) + 1
    INTO next_sequence
    FROM "ClientDocument" AS document
    WHERE document."tenantId" = NEW."tenantId"
      AND document."clientId" = NEW."clientId"
      AND document."docType" = 'SELFIE';
    NEW."biometricAttemptSequence" := next_sequence;
  ELSIF NEW."docType" <> 'SELFIE' THEN
    NEW."biometricAttemptSequence" := NULL;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.biometric_subject_fingerprint(p_client_id text, p_id_number text, p_first_name text, p_last_name text, p_date_of_birth timestamp without time zone)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT encode(
    sha256(
      convert_to(
        array_to_string(ARRAY[
          'biometric-subject-v2',
          encode(convert_to(coalesce(p_client_id, ''), 'UTF8'), 'hex'),
          encode(convert_to(coalesce(p_id_number, ''), 'UTF8'), 'hex'),
          encode(convert_to(coalesce(p_first_name, ''), 'UTF8'), 'hex'),
          encode(convert_to(coalesce(p_last_name, ''), 'UTF8'), 'hex'),
          coalesce(to_char(p_date_of_birth, 'YYYY-MM-DD'), '')
        ], ':'),
        'UTF8'
      )
    ),
    'hex'
  );
$function$;

CREATE OR REPLACE FUNCTION public.client_has_composite_kyc(p_tenant_id text, p_client_id text)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT coalesce(
    (
      SELECT "subject_has_composite_kyc"(
        subject."tenantId",
        subject."id",
        subject."idNumber",
        subject."firstName",
        subject."lastName",
        subject."dateOfBirth"
      )
      FROM "Client" AS subject
      WHERE subject."tenantId" = p_tenant_id
        AND subject."id" = p_client_id
    ),
    false
  );
$function$;

CREATE OR REPLACE FUNCTION public.enforce_composite_kyc_projection()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- A verified biometric result is bound to these exact subject fields. During
  -- a rolling deployment, an older writer cannot preserve the cached VERIFIED
  -- projection while changing the subject behind the stored fingerprint.
  IF TG_OP = 'UPDATE'
    AND OLD."kycStatus" = 'VERIFIED'
    AND NEW."kycStatus" = 'VERIFIED'
    AND (
      NEW."idNumber" IS DISTINCT FROM OLD."idNumber"
      OR NEW."firstName" IS DISTINCT FROM OLD."firstName"
      OR NEW."lastName" IS DISTINCT FROM OLD."lastName"
      OR NEW."dateOfBirth" IS DISTINCT FROM OLD."dateOfBirth"
    )
  THEN
    RAISE EXCEPTION
      'Verified biometric subject fields cannot change without revoking KYC';
  END IF;

  -- Manual rejection is a durable human hold, distinct from evidence-derived
  -- FAILED. Ordinary document/provider writers may update evidence while the
  -- hold is active, but cannot make the Client projection pass or erase the
  -- hold. Only the explicit resolution mutation supplies all resolution
  -- provenance and can clear it.
  IF TG_OP = 'UPDATE'
    AND OLD."kycManualRejectionActive"
    AND NEW."kycManualRejectionActive"
    AND NEW."kycStatus" = 'VERIFIED'
  THEN
    RAISE EXCEPTION
      'Client KYC cannot be approved while a manual rejection is active';
  END IF;

  IF NEW."kycManualRejectionActive" THEN
    IF NEW."kycManualRejectionAt" IS NULL
      OR nullif(trim(NEW."kycManualRejectionById"), '') IS NULL
      OR nullif(trim(NEW."kycManualRejectionReason"), '') IS NULL
    THEN
      RAISE EXCEPTION
        'Active manual KYC rejection requires timestamp, actor, and reason';
    END IF;

    NEW."kycStatus" := 'FAILED';
    NEW."kycVerifiedAt" := NULL;
    NEW."kycVerifiedById" := NULL;
    NEW."kycVerificationMethod" := NULL;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."kycManualRejectionActive"
    AND NOT NEW."kycManualRejectionActive"
    AND (
      NEW."kycManualRejectionResolvedAt" IS NULL
      OR nullif(trim(NEW."kycManualRejectionResolvedById"), '') IS NULL
      OR nullif(trim(NEW."kycManualRejectionResolutionReason"), '') IS NULL
      OR NEW."kycManualRejectionResolvedAt" < OLD."kycManualRejectionAt"
    )
  THEN
    RAISE EXCEPTION
      'Manual KYC rejection resolution requires timestamp, actor, and reason';
  END IF;

  IF NEW."kycStatus" = 'VERIFIED'
    AND NOT "subject_has_composite_kyc"(
      NEW."tenantId",
      NEW."id",
      NEW."idNumber",
      NEW."firstName",
      NEW."lastName",
      NEW."dateOfBirth"
    )
  THEN
    RAISE EXCEPTION
      'Client KYC cannot be VERIFIED without current composite evidence';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_completed_kyc_exception_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."type" = 'KYC_EXCEPTION'
    AND OLD."status" = 'COMPLETED'
    AND OLD."completedAt" IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE =
        'Completed KYC exception evidence is immutable; create a superseding record instead';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_legacy_message_placeholder()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  attempted_provider_message_id TEXT;
  attempted_sent_at TIMESTAMPTZ;
  attempted_dispatch_state TEXT;
BEGIN
  IF NEW."direction" = 'OUTBOUND'
    AND NEW."status" = 'SENT'
    AND NEW."dispatchState" IS DISTINCT FROM 'RECONCILED_SENT'
    AND NEW."dispatchProviderMessageId" IS NULL
    AND NEW."dispatchProviderAcceptedAt" IS NULL
    AND NULLIF(btrim(NEW."dispatchEvidenceReference"), '') IS NULL
    AND (
      (
        NEW."provider" = 'BULKSMS'
        AND NEW."channel" = 'SMS'
        AND lower(btrim(NEW."providerMessageId")) = 'sent'
      )
      OR (
        NEW."provider" = 'WA_UNOFFICIAL'
        AND NEW."channel" = 'WHATSAPP'
        AND lower(btrim(NEW."providerMessageId")) = 'unknown'
      )
    )
  THEN
    attempted_provider_message_id := NEW."providerMessageId";
    attempted_sent_at := NEW."sentAt";
    attempted_dispatch_state := NEW."dispatchState"::text;

    NEW."status" := 'QUEUED';
    NEW."sentAt" := NULL;
    NEW."providerMessageId" := NULL;
    NEW."nextRetryAt" := NULL;
    NEW."lastErrorAt" := CURRENT_TIMESTAMP;
    NEW."errorClass" := 'RETRY_LEGACY_PLACEHOLDER_MANUAL_RECONCILIATION';
    NEW."errorMessage" := 'Legacy provider placeholder does not prove delivery';
    NEW."dispatchState" := 'AMBIGUOUS';
    NEW."dispatchCompletedAt" := CURRENT_TIMESTAMP;
    NEW."dispatchLeaseExpiresAt" := NULL;
    NEW."dispatchProviderMessageId" := NULL;
    NEW."dispatchProviderAcceptedAt" := NULL;
    NEW."dispatchEvidenceReference" := NULL;
    NEW."simulationReceiptId" := NULL;

    INSERT INTO "AuditLog" (
      "id", "tenantId", "userEmail", "action", "entity", "entityId",
      "oldValue", "newValue", "createdAt"
    ) VALUES (
      'message-legacy-placeholder-guard-' || NEW."id",
      NEW."tenantId",
      'database@message-evidence-guard',
      'MESSAGE_DELIVERY_EVIDENCE_RECONCILIATION_REQUIRED',
      'Message',
      NEW."id",
      jsonb_build_object(
        'status', 'SENT',
        'sentAt', attempted_sent_at,
        'providerMessageId', attempted_provider_message_id,
        'dispatchState', attempted_dispatch_state
      ),
      jsonb_build_object(
        'status', 'QUEUED',
        'dispatchState', 'AMBIGUOUS',
        'providerMessageId', NULL,
        'providerAcceptedAt', NULL,
        'providerEvidenceReference', NULL,
        'compatibilityCorrection', 'legacy_provider_placeholder_guard',
        'reason', 'legacy_provider_placeholder_has_no_dispatch_evidence'
      ),
      CURRENT_TIMESTAMP
    ) ON CONFLICT ("id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_legacy_placeholder_audit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."entity" = 'Message'
    AND NEW."entityId" IS NOT NULL
    AND NEW."action" = 'MESSAGE_SENT'
    AND EXISTS (
      SELECT 1
      FROM "Message" AS message
      WHERE message."id" = NEW."entityId"
        AND message."tenantId" IS NOT DISTINCT FROM NEW."tenantId"
        AND message."status" = 'QUEUED'
        AND message."dispatchState" = 'AMBIGUOUS'
        AND message."errorClass" = 'RETRY_LEGACY_PLACEHOLDER_MANUAL_RECONCILIATION'
    )
  THEN
    NEW."action" := 'MESSAGE_DELIVERY_EVIDENCE_RECONCILIATION_REQUIRED';
    NEW."newValue" :=
      (COALESCE(NEW."newValue", '{}'::jsonb)
        - 'sentAt'
        - 'providerMessageId'
        - 'dispatchProviderMessageId'
        - 'providerAcceptedAt'
        - 'providerEvidenceReference')
      || jsonb_build_object(
        'status', 'QUEUED',
        'sentAt', NULL,
        'dispatchState', 'AMBIGUOUS',
        'providerMessageId', NULL,
        'providerAcceptedAt', NULL,
        'providerEvidenceReference', NULL,
        'compatibilityCorrection', 'legacy_provider_placeholder_writer',
        'reason', 'legacy_provider_placeholder_has_no_dispatch_evidence'
      );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_note_mutability()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."isInternal" IS NOT TRUE OR OLD."direction" IS DISTINCT FROM 'INTERNAL_NOTE' THEN
    IF NEW."bodyText" IS DISTINCT FROM OLD."bodyText" THEN
      RAISE EXCEPTION
        'Message % is not an internal note; bodyText is immutable', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."editedAt" IS DISTINCT FROM OLD."editedAt"
       OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN
      RAISE EXCEPTION
        'Message % is not an internal note; edit/delete markers do not apply', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."direction" IS DISTINCT FROM OLD."direction"
     OR NEW."isInternal" IS DISTINCT FROM OLD."isInternal"
     OR NEW."conversationId" IS DISTINCT FROM OLD."conversationId"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" THEN
    RAISE EXCEPTION
      'Internal note % cannot change author, thread or kind', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS NULL THEN
    RAISE EXCEPTION
      'Internal note % is deleted; deletion is terminal', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_unlinked_notification_delivery()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."messageId" IS NULL
    AND lower(NEW."channel") IN ('email', 'sms', 'whatsapp')
    AND lower(NEW."status") = 'sent'
  THEN
    INSERT INTO "AuditLog" (
      "id", "tenantId", "userEmail", "action", "entity", "entityId",
      "oldValue", "newValue", "createdAt"
    ) VALUES (
      'notification-unlinked-delivery-guard-' || NEW."id",
      NEW."tenantId",
      'database@notification-evidence-guard',
      'NOTIFICATION_UNLINKED_DELIVERY_CLAIM_BLOCKED',
      'NotificationLog',
      NEW."id",
      jsonb_build_object('status', NEW."status", 'messageId', NEW."messageId"),
      jsonb_build_object(
        'status', 'review_required',
        'messageId', NULL,
        'reason', 'external_delivery_claim_requires_exact_message_linkage'
      ),
      CURRENT_TIMESTAMP
    ) ON CONFLICT ("id") DO NOTHING;

    NEW."status" := 'review_required';
    NEW."error" := concat_ws(
      '; ',
      NULLIF(NEW."error", ''),
      'Delivery claim has no exact Message/provider evidence linkage'
    );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_client_composite_kyc(evidence_tenant_id text, evidence_client_id text, evidence_document_id text, evidence_doc_type text, evidence_scope text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  previous_kyc jsonb;
BEGIN
  IF evidence_doc_type NOT IN (
    'ID_COPY', 'PROOF_OF_ADDRESS', 'PAYSLIP', 'BANK_STATEMENT', 'SELFIE'
  ) OR "client_has_composite_kyc"(evidence_tenant_id, evidence_client_id)
  THEN
    RETURN;
  END IF;

  SELECT jsonb_build_object(
    'kycStatus', client."kycStatus"::text,
    'kycVerifiedAt', client."kycVerifiedAt",
    'kycVerifiedById', client."kycVerifiedById",
    'kycVerificationMethod', client."kycVerificationMethod"::text
  )
  INTO previous_kyc
  FROM "Client" AS client
  WHERE client."id" = evidence_client_id
    AND client."tenantId" = evidence_tenant_id
    AND client."kycStatus" = 'VERIFIED'
  FOR UPDATE;

  IF previous_kyc IS NULL THEN
    RETURN;
  END IF;

  UPDATE "Client"
  SET
    "kycStatus" = 'PENDING',
    "kycVerifiedAt" = NULL,
    "kycVerifiedById" = NULL,
    "kycVerificationMethod" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = evidence_client_id AND "tenantId" = evidence_tenant_id;

  INSERT INTO "AuditLog" (
    "id", "tenantId", "userEmail", "action", "entity", "entityId",
    "oldValue", "newValue", "createdAt"
  ) VALUES (
    'kyc-evidence-reset-' || md5(
      clock_timestamp()::text || random()::text || evidence_document_id
    ),
    evidence_tenant_id,
    'database@composite-kyc-guard',
    'KYC_STATUS_CHANGED',
    'Client',
    evidence_client_id,
    previous_kyc,
    jsonb_build_object(
      'kycStatus', 'PENDING',
      'kycVerifiedAt', NULL,
      'kycVerifiedById', NULL,
      'kycVerificationMethod', NULL,
      'reason', 'composite_kyc_evidence_changed',
      'documentId', evidence_document_id,
      'documentType', evidence_doc_type,
      'evidenceScope', evidence_scope,
      'databaseEnforced', true
    ),
    CURRENT_TIMESTAMP
  );

  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_kyc_exception_projection(evidence_tenant_id text, evidence_client_id text, evidence_record_id text, evidence_scope text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  previous_kyc jsonb;
BEGIN
  IF nullif(trim(evidence_tenant_id), '') IS NULL
    OR nullif(trim(evidence_client_id), '') IS NULL
  THEN
    RETURN;
  END IF;

  SELECT jsonb_build_object(
    'kycStatus', client."kycStatus"::text,
    'kycVerifiedAt', client."kycVerifiedAt",
    'kycVerifiedById', client."kycVerifiedById",
    'kycVerificationMethod', client."kycVerificationMethod"::text
  )
  INTO previous_kyc
  FROM "Client" AS client
  WHERE client."id" = evidence_client_id
    AND client."tenantId" = evidence_tenant_id
    AND client."kycStatus" = 'VERIFIED'
  FOR UPDATE;

  IF previous_kyc IS NULL
    OR "client_has_composite_kyc"(
      evidence_tenant_id,
      evidence_client_id
    )
  THEN
    RETURN;
  END IF;

  UPDATE "Client"
  SET
    "kycStatus" = 'PENDING',
    "kycVerifiedAt" = NULL,
    "kycVerifiedById" = NULL,
    "kycVerificationMethod" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "id" = evidence_client_id
    AND "tenantId" = evidence_tenant_id;

  INSERT INTO "AuditLog" (
    "id", "tenantId", "userEmail", "action", "entity", "entityId",
    "oldValue", "newValue", "createdAt"
  ) VALUES (
    'kyc-exception-reset-' || md5(
      clock_timestamp()::text || random()::text || evidence_record_id
    ),
    evidence_tenant_id,
    'database@composite-kyc-guard',
    'KYC_STATUS_CHANGED',
    'Client',
    evidence_client_id,
    previous_kyc,
    jsonb_build_object(
      'kycStatus', 'PENDING',
      'kycVerifiedAt', NULL,
      'kycVerifiedById', NULL,
      'kycVerificationMethod', NULL,
      'reason', 'manual_kyc_exception_changed',
      'exceptionRecordId', evidence_record_id,
      'evidenceScope', evidence_scope,
      'databaseEnforced', true
    ),
    CURRENT_TIMESTAMP
  );

  RETURN;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_stale_composite_kyc()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM "revoke_client_composite_kyc"(
      OLD."tenantId",
      OLD."clientId",
      OLD."id",
      OLD."docType"::text,
      'OLD'
    );
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    PERFORM "revoke_client_composite_kyc"(
      NEW."tenantId",
      NEW."clientId",
      NEW."id",
      NEW."docType"::text,
      'NEW'
    );
    RETURN NEW;
  END IF;

  -- An UPDATE can invalidate the row's previous owner/type, its new
  -- owner/type, or both. Checking both post-update scopes closes retype and
  -- reassignment escapes while avoiding duplicate audit rows because the
  -- first reset makes subsequent calls a no-op.
  PERFORM "revoke_client_composite_kyc"(
    OLD."tenantId",
    OLD."clientId",
    OLD."id",
    OLD."docType"::text,
    'OLD'
  );
  PERFORM "revoke_client_composite_kyc"(
    NEW."tenantId",
    NEW."clientId",
    NEW."id",
    NEW."docType"::text,
    'NEW'
  );

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.revoke_stale_kyc_exception()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."type" = 'KYC_EXCEPTION' THEN
      PERFORM "revoke_kyc_exception_projection"(
        OLD."tenantId",
        OLD."referenceId",
        OLD."id",
        'OLD'
      );
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."type" = 'KYC_EXCEPTION' THEN
      PERFORM "revoke_kyc_exception_projection"(
        NEW."tenantId",
        NEW."referenceId",
        NEW."id",
        'NEW'
      );
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."type" = 'KYC_EXCEPTION' THEN
    PERFORM "revoke_kyc_exception_projection"(
      OLD."tenantId",
      OLD."referenceId",
      OLD."id",
      'OLD'
    );
  END IF;
  IF NEW."type" = 'KYC_EXCEPTION' THEN
    PERFORM "revoke_kyc_exception_projection"(
      NEW."tenantId",
      NEW."referenceId",
      NEW."id",
      'NEW'
    );
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.stage_email_log_ambiguous_status()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."status" = 'AMBIGUOUS' THEN
    NEW."status" := 'FAILED';
    NEW."sentAt" := NULL;
    NEW."errorMessage" := concat_ws(
      '; ',
      NULLIF(NEW."errorMessage", ''),
      '[PROVIDER_OUTCOME_AMBIGUOUS] Compatibility hold until old EmailLog readers are drained'
    );
    INSERT INTO "AuditLog" (
      "id", "tenantId", "userEmail", "action", "entity", "entityId",
      "oldValue", "newValue", "createdAt"
    ) VALUES (
      'email-ambiguous-status-stage-' || NEW."id",
      NEW."tenantId",
      'database@email-status-compatibility',
      'EMAIL_AMBIGUOUS_STATUS_COMPATIBILITY_HELD',
      'EmailLog',
      NEW."id",
      jsonb_build_object('status', 'AMBIGUOUS'),
      jsonb_build_object(
        'status', 'FAILED',
        'providerOutcome', 'AMBIGUOUS',
        'reason', 'old_prisma_reader_compatibility'
      ),
      CURRENT_TIMESTAMP
    ) ON CONFLICT ("id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.subject_has_composite_kyc(p_tenant_id text, p_client_id text, p_id_number text, p_first_name text, p_last_name text, p_date_of_birth timestamp without time zone)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT
    (
      SELECT COUNT(DISTINCT document."docType") = 4
      FROM "ClientDocument" AS document
      WHERE document."tenantId" = p_tenant_id
        AND document."clientId" = p_client_id
        AND document."docType" IN (
          'ID_COPY', 'PROOF_OF_ADDRESS', 'PAYSLIP', 'BANK_STATEMENT'
        )
        AND document."deletedAt" IS NULL
        AND document."verified" = true
    )
    AND (
      EXISTS (
        SELECT 1
        FROM "ClientDocument" AS selfie
        WHERE selfie."id" = (
          SELECT latest."id"
          FROM "ClientDocument" AS latest
          WHERE latest."tenantId" = p_tenant_id
            AND latest."clientId" = p_client_id
            AND latest."docType" = 'SELFIE'
          ORDER BY
            latest."biometricAttemptSequence" DESC,
            latest."createdAt" DESC,
            latest."id" DESC
          LIMIT 1
        )
          AND selfie."deletedAt" IS NULL
          AND selfie."verified" = true
          AND selfie."extractionStatus" = 'done'
          AND selfie."validationMismatch" = false
          AND selfie."validationScore" >= 70
          AND selfie."biometricMatchScore" >= 70
          AND selfie."biometricLiveness" >= 70
          AND selfie."biometricVerifiedAt" IS NOT NULL
          AND jsonb_typeof(selfie."extractionResult") = 'object'
          AND (
            selfie."extractionResult" ->> 'vlmUnavailable' = 'true'
            OR (
              selfie."extractionResult" #>> '{faceDetected,value}' = 'true'
              AND selfie."extractionResult" #>> '{facesCount,value}' = '1'
              AND selfie."extractionResult" #>> '{isLive,value}' = 'true'
              AND lower(
                trim(selfie."extractionResult" #>> '{quality,value}')
              ) IN ('good', 'poor')
            )
          )
          AND jsonb_typeof(selfie."biometricResult") = 'object'
          AND selfie."biometricResult" ->> 'ok' = 'true'
          AND selfie."biometricResult" ->> 'verified' = 'true'
          AND coalesce(
            selfie."biometricResult" ->> 'simulated',
            'false'
          ) <> 'true'
          AND coalesce(
            selfie."biometricResult" ->> 'subjectFingerprint',
            ''
          ) ~ '^[a-f0-9]{64}$'
          AND selfie."biometricResult" ->> 'subjectFingerprint' =
            "biometric_subject_fingerprint"(
              p_client_id,
              p_id_number,
              p_first_name,
              p_last_name,
              p_date_of_birth
            )
          AND jsonb_typeof(
            selfie."biometricResult" -> 'matchScore'
          ) = 'number'
          AND jsonb_typeof(
            selfie."biometricResult" -> 'livenessScore'
          ) = 'number'
          AND (
            selfie."biometricResult" ->> 'matchScore'
          )::numeric >= 70
          AND (
            selfie."biometricResult" ->> 'livenessScore'
          )::numeric >= 70
      )
      OR "subject_has_manual_kyc_exception"(
        p_tenant_id,
        p_client_id,
        p_id_number,
        p_first_name,
        p_last_name,
        p_date_of_birth
      )
      OR "subject_has_in_person_kyc_verification"(
        p_tenant_id,
        p_client_id,
        p_id_number,
        p_first_name,
        p_last_name,
        p_date_of_birth
      )
    );
$function$;

CREATE OR REPLACE FUNCTION public.subject_has_in_person_kyc_verification(p_tenant_id text, p_client_id text, p_id_number text, p_first_name text, p_last_name text, p_date_of_birth timestamp without time zone)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM LATERAL (
      SELECT
        record."id",
        record."completedAt",
        record."data"
      FROM "ComplianceRecord" AS record
      WHERE record."tenantId" = p_tenant_id
        AND record."type" = 'KYC_EXCEPTION'
        AND record."referenceId" = p_client_id
        AND record."status" = 'COMPLETED'
        AND record."completedAt" IS NOT NULL
      ORDER BY
        record."completedAt" DESC,
        record."createdAt" DESC,
        record."id" DESC
      LIMIT 1
    ) AS attestation
    CROSS JOIN LATERAL (
      SELECT
        id_document."id",
        id_document."contentSha256"
      FROM "ClientDocument" AS id_document
      WHERE id_document."tenantId" = p_tenant_id
        AND id_document."clientId" = p_client_id
        AND id_document."docType" = 'ID_COPY'
        AND id_document."deletedAt" IS NULL
        AND id_document."verified" = true
      ORDER BY
        id_document."createdAt" DESC,
        id_document."id" DESC
      LIMIT 1
    ) AS id_document
    WHERE NOT EXISTS (
        -- Only a selfie that is a LIVE biometric candidate takes the human
        -- fallback out of scope: an attempt still processing, or one whose
        -- provider-verified evidence passed. A failed or soft-deleted attempt
        -- must NOT permanently close the in-person route (2026-07-28
        -- remediation, report S3 F) - the previous "any selfie row at all"
        -- rule stranded clients whose one failed attempt removed every path
        -- to payout-grade KYC.
        SELECT 1
        FROM "ClientDocument" AS selfie
        WHERE selfie."tenantId" = p_tenant_id
          AND selfie."clientId" = p_client_id
          AND selfie."docType" = 'SELFIE'
          AND selfie."deletedAt" IS NULL
          AND (
            selfie."extractionStatus" = 'processing'
            OR (
              selfie."verified" = true
              AND selfie."biometricVerifiedAt" IS NOT NULL
            )
          )
      )
      AND id_document."contentSha256" ~ '^[a-f0-9]{64}$'
      AND jsonb_typeof(attestation."data") = 'object'
      AND attestation."data" ->> 'kind' = 'KYC_IN_PERSON_VERIFICATION'
      AND attestation."data" ->> 'version' = 'kyc-in-person-verification-v1'
      AND "trim_manual_kyc_exception_text"(
        attestation."data" ->> 'clientId'
      ) = p_client_id
      AND "trim_manual_kyc_exception_text"(
        attestation."data" ->> 'idDocumentId'
      ) = id_document."id"
      AND "trim_manual_kyc_exception_text"(
        attestation."data" ->> 'idDocumentSha256'
      ) = id_document."contentSha256"
      AND "trim_manual_kyc_exception_text"(
        attestation."data" ->> 'subjectFingerprint'
      ) = "biometric_subject_fingerprint"(
        p_client_id,
        p_id_number,
        p_first_name,
        p_last_name,
        p_date_of_birth
      )
      AND attestation."data" ->> 'method' IN (
        'IN_PERSON_BRANCH',
        'KNOWN_EXISTING_CLIENT',
        'AGENT_VERIFIED'
      )
      AND length(
        "trim_manual_kyc_exception_text"(
          attestation."data" ->> 'note'
        )
      ) >= 20
      AND nullif(
        "trim_manual_kyc_exception_text"(
          attestation."data" ->> 'approvedById'
        ),
        ''
      ) IS NOT NULL
      AND nullif(
        "trim_manual_kyc_exception_text"(
          attestation."data" ->> 'approvedByEmail'
        ),
        ''
      ) IS NOT NULL
      AND "trim_manual_kyc_exception_text"(
        attestation."data" ->> 'approvedAt'
      ) = to_char(
        -- Prisma stores DateTime as TIMESTAMP(3) without time zone. Formatting
        -- that value directly is session-time-zone invariant; AT TIME ZONE
        -- would convert it to timestamptz and shift it in non-UTC sessions.
        attestation."completedAt",
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.subject_has_manual_kyc_exception(p_tenant_id text, p_client_id text, p_id_number text, p_first_name text, p_last_name text, p_date_of_birth timestamp without time zone)
 RETURNS boolean
 LANGUAGE sql
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM LATERAL (
      SELECT
        record."id",
        record."completedAt",
        record."data"
      FROM "ComplianceRecord" AS record
      WHERE record."tenantId" = p_tenant_id
        AND record."type" = 'KYC_EXCEPTION'
        AND record."referenceId" = p_client_id
        AND record."status" = 'COMPLETED'
        AND record."completedAt" IS NOT NULL
      ORDER BY
        record."completedAt" DESC,
        record."createdAt" DESC,
        record."id" DESC
      LIMIT 1
    ) AS exception
    CROSS JOIN LATERAL (
      SELECT
        selfie."id",
        selfie."contentSha256",
        selfie."deletedAt",
        selfie."extractionStatus",
        selfie."biometricResult"
      FROM "ClientDocument" AS selfie
      WHERE selfie."tenantId" = p_tenant_id
        AND selfie."clientId" = p_client_id
        AND selfie."docType" = 'SELFIE'
      ORDER BY
        selfie."biometricAttemptSequence" DESC,
        selfie."createdAt" DESC,
        selfie."id" DESC
      LIMIT 1
    ) AS selfie
    WHERE selfie."deletedAt" IS NULL
      AND selfie."contentSha256" ~ '^[a-f0-9]{64}$'
      AND selfie."extractionStatus" IN ('failed', 'skipped')
      AND jsonb_typeof(exception."data") = 'object'
      AND exception."data" ->> 'kind' = 'KYC_MANUAL_EXCEPTION'
      AND exception."data" ->> 'version' = 'manual-kyc-exception-v1'
      AND "trim_manual_kyc_exception_text"(
        exception."data" ->> 'clientId'
      ) = p_client_id
      AND "trim_manual_kyc_exception_text"(
        exception."data" ->> 'documentId'
      ) = selfie."id"
      AND "trim_manual_kyc_exception_text"(
        exception."data" ->> 'documentSha256'
      ) = selfie."contentSha256"
      AND "trim_manual_kyc_exception_text"(
        exception."data" ->> 'subjectFingerprint'
      ) = "biometric_subject_fingerprint"(
        p_client_id,
        p_id_number,
        p_first_name,
        p_last_name,
        p_date_of_birth
      )
      AND exception."data" ->> 'biometricFailureReason' = CASE
        WHEN selfie."biometricResult" ->> 'biometricFailureReason' IN (
          'extraction_incomplete',
          'biometric_evidence_missing',
          'document_deleted',
          'document_not_verified',
          'superseded_biometric_evidence',
          'subject_fingerprint_missing',
          'subject_identity_changed',
          'face_not_detected',
          'face_count_invalid',
          'vlm_liveness_failed',
          'image_unusable',
          'validation_mismatch',
          'match_score_below_threshold',
          'liveness_score_below_threshold',
          'provider_verification_missing',
          'simulated_provider_evidence',
          'provider_verification_failed'
        )
        THEN selfie."biometricResult" ->> 'biometricFailureReason'
        ELSE 'extraction_incomplete'
      END
      AND exception."data" ->> 'biometricFailureReason' IN (
        'face_not_detected',
        'face_count_invalid',
        'vlm_liveness_failed',
        'image_unusable',
        'validation_mismatch',
        'match_score_below_threshold',
        'liveness_score_below_threshold',
        'provider_verification_failed'
      )
      AND length(
        "trim_manual_kyc_exception_text"(
          exception."data" ->> 'reason'
        )
      ) >= 20
      AND length(
        "trim_manual_kyc_exception_text"(
          exception."data" ->> 'supportingEvidence'
        )
      ) >= 20
      AND nullif(
        "trim_manual_kyc_exception_text"(
          exception."data" ->> 'approvedById'
        ),
        ''
      ) IS NOT NULL
      AND nullif(
        "trim_manual_kyc_exception_text"(
          exception."data" ->> 'approvedByEmail'
        ),
        ''
      ) IS NOT NULL
      AND "trim_manual_kyc_exception_text"(
        exception."data" ->> 'approvedAt'
      ) = to_char(
        -- Prisma stores DateTime as TIMESTAMP(3) without time zone. Formatting
        -- that value directly is session-time-zone invariant; AT TIME ZONE
        -- would convert it to timestamptz and shift it in non-UTC sessions.
        exception."completedAt",
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.trim_manual_kyc_exception_text(p_value text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
AS $function$
  SELECT btrim(
    coalesce(p_value, ''),
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
  );
$function$;

CREATE OR REPLACE FUNCTION public.truthful_dry_run_audit()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  simulation_receipt_id TEXT;
  graph_reconciliation_required BOOLEAN := FALSE;
BEGIN
  IF NEW."entity" = 'Message' AND NEW."entityId" IS NOT NULL THEN
    SELECT message."simulationReceiptId"
    INTO simulation_receipt_id
    FROM "Message" AS message
    WHERE message."id" = NEW."entityId"
      AND message."tenantId" IS NOT DISTINCT FROM NEW."tenantId"
      AND message."status" = 'SIMULATED';
  END IF;

  IF NEW."entity" = 'Message' AND NEW."entityId" IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM "Message" AS message
      WHERE message."id" = NEW."entityId"
        AND message."tenantId" IS NOT DISTINCT FROM NEW."tenantId"
        AND message."channel" = 'EMAIL'
        AND message."provider" = 'MSGRAPH'
        AND message."status" = 'QUEUED'
        AND message."dispatchState" = 'AMBIGUOUS'
        AND message."errorClass" = 'RETRY_DISPATCH_CLAIMED_MANUAL_RECONCILIATION'
    ) INTO graph_reconciliation_required;
  END IF;

  IF NEW."entity" = 'Message'
    AND NEW."action" = 'MESSAGE_SENT'
    AND graph_reconciliation_required
  THEN
    NEW."action" := 'MESSAGE_DELIVERY_EVIDENCE_RECONCILIATION_REQUIRED';
    NEW."newValue" :=
      (COALESCE(NEW."newValue", '{}'::jsonb)
        - 'providerMessageId'
        - 'dispatchProviderMessageId'
        - 'providerAcceptedAt'
        - 'providerEvidenceReference')
      || jsonb_build_object(
        'status', 'QUEUED',
        'dispatchState', 'AMBIGUOUS',
        'providerMessageId', NULL,
        'providerAcceptedAt', NULL,
        'providerEvidenceReference', NULL,
        'compatibilityCorrection', 'legacy_graph_writer',
        'reason', 'graph_delivery_requires_request_scoped_provider_evidence'
      );
  END IF;

  IF NEW."entity" = 'Message'
    AND NEW."entityId" IS NOT NULL
    AND NEW."action" = 'MESSAGE_SENT'
    AND simulation_receipt_id IS NOT NULL
    AND (simulation_receipt_id = 'dry-run' OR simulation_receipt_id LIKE 'dry-run-%')
  THEN
    NEW."action" := 'MESSAGE_SIMULATED';
    NEW."newValue" := COALESCE(NEW."newValue", '{}'::jsonb) || jsonb_build_object(
      'status', 'SIMULATED',
      'simulated', true,
      'compatibilityCorrection', 'legacy_dry_run_writer'
    );
  END IF;

  IF NEW."entity" = 'Message'
    AND (
      NEW."action" LIKE 'MESSAGE_SIMULATED%'
      OR NEW."action" = 'MESSAGE_RECONCILED_SIMULATED'
    )
  THEN
    NEW."newValue" :=
      (COALESCE(NEW."newValue", '{}'::jsonb)
        - 'providerMessageId'
        - 'dispatchProviderMessageId'
        - 'providerAcceptedAt')
      || jsonb_build_object(
        'providerMessageId', NULL,
        'providerAcceptedAt', NULL,
        'simulationReceiptId', simulation_receipt_id,
        'simulationCompletedAt', COALESCE(
          NEW."newValue" -> 'simulationCompletedAt',
          NEW."newValue" -> 'completedAt',
          to_jsonb(COALESCE(NEW."createdAt", CURRENT_TIMESTAMP))
        )
      );
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.truthful_dry_run_message()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."direction" = 'OUTBOUND'
    AND NEW."channel" = 'EMAIL'
    AND NEW."provider" = 'MSGRAPH'
    AND NEW."status" = 'SENT'
    AND (
      NEW."providerMessageId" ~ '^graph-[0-9]{10,}$'
      OR NEW."dispatchProviderMessageId" ~ '^graph-[0-9]{10,}$'
      OR NEW."dispatchEvidenceReference" = 'MSGRAPH_HTTP_202'
      OR (
        NEW."dispatchState" IS DISTINCT FROM 'RECONCILED_SENT'
        AND NEW."providerMessageId" IS NULL
        AND NEW."dispatchProviderMessageId" IS NULL
        AND COALESCE(NEW."dispatchEvidenceReference", '') !~
          '^MSGRAPH_(REQUEST_ID:[^;[:space:]]+;CLIENT_REQUEST_ID:|CLIENT_REQUEST_ID:)[0-9a-fA-F-]{36}$'
      )
    )
  THEN
    NEW."status" := 'QUEUED';
    NEW."sentAt" := NULL;
    NEW."providerMessageId" := NULL;
    NEW."nextRetryAt" := NULL;
    NEW."lastErrorAt" := CURRENT_TIMESTAMP;
    NEW."errorClass" := 'RETRY_DISPATCH_CLAIMED_MANUAL_RECONCILIATION';
    NEW."errorMessage" := 'Microsoft Graph delivery claim lacks request-scoped provider evidence';
    NEW."dispatchState" := 'AMBIGUOUS';
    NEW."dispatchCompletedAt" := CURRENT_TIMESTAMP;
    NEW."dispatchLeaseExpiresAt" := NULL;
    NEW."dispatchProviderMessageId" := NULL;
    NEW."dispatchProviderAcceptedAt" := NULL;
    NEW."dispatchEvidenceReference" := NULL;
  END IF;

  IF NEW."direction" = 'OUTBOUND'
    AND NEW."status" = 'SENT'
    AND (
      (NEW."provider" = 'BULKSMS' AND NEW."channel" = 'SMS')
      OR (NEW."provider" = 'WA_UNOFFICIAL' AND NEW."channel" = 'WHATSAPP')
    )
    AND (
      NEW."providerMessageId" = 'dry-run'
      OR NEW."providerMessageId" LIKE 'dry-run-%'
    )
  THEN
    NEW."simulationReceiptId" := COALESCE(
      NEW."simulationReceiptId",
      NEW."dispatchProviderMessageId",
      NEW."providerMessageId"
    );
    NEW."status" := 'SIMULATED';
  END IF;

  IF NEW."status" = 'SIMULATED'
    OR NEW."dispatchState" IN ('SIMULATED', 'RECONCILED_SIMULATED')
  THEN
    NEW."simulationReceiptId" := COALESCE(
      NEW."simulationReceiptId",
      NEW."dispatchProviderMessageId",
      NEW."providerMessageId"
    );
    NEW."sentAt" := NULL;
    NEW."providerMessageId" := NULL;
    NEW."dispatchProviderMessageId" := NULL;
    NEW."dispatchProviderAcceptedAt" := NULL;
    NEW."dispatchEvidenceReference" := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.truthful_graph_email_log()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  old_message_id TEXT;
  old_evidence_reference TEXT;
BEGIN
  IF NEW."status" = 'SENT'
    AND (
      NEW."messageId" ~ '^graph-[0-9]{10,}$'
      OR NEW."providerEvidenceReference" = 'MSGRAPH_HTTP_202'
      OR (
        NEW."provider" = 'MSGRAPH'
        AND NEW."messageId" IS NULL
        AND COALESCE(NEW."providerEvidenceReference", '') !~
          '^MSGRAPH_(REQUEST_ID:[^;[:space:]]+;CLIENT_REQUEST_ID:|CLIENT_REQUEST_ID:)[0-9a-fA-F-]{36}$'
      )
    )
  THEN
    old_message_id := NEW."messageId";
    old_evidence_reference := NEW."providerEvidenceReference";
    NEW."status" := 'FAILED';
    NEW."provider" := 'MSGRAPH';
    NEW."messageId" := NULL;
    NEW."providerEvidenceReference" := NULL;
    NEW."sentAt" := NULL;
    NEW."errorMessage" := concat_ws(
      '; ',
      NULLIF(NEW."errorMessage", ''),
      '[PROVIDER_OUTCOME_AMBIGUOUS] Microsoft Graph delivery claim lacks request-scoped provider evidence'
    );

    INSERT INTO "AuditLog" (
      "id", "tenantId", "userEmail", "action", "entity", "entityId",
      "oldValue", "newValue", "createdAt"
    ) VALUES (
      'email-graph-evidence-guard-' || NEW."id",
      NEW."tenantId",
      'database@message-evidence-guard',
      'EMAIL_DELIVERY_EVIDENCE_RECONCILIATION_REQUIRED',
      'EmailLog',
      NEW."id",
      jsonb_build_object(
        'status', 'SENT',
        'messageId', old_message_id,
        'providerEvidenceReference', old_evidence_reference
      ),
      jsonb_build_object(
        'status', 'FAILED',
        'providerOutcome', 'AMBIGUOUS',
        'provider', 'MSGRAPH',
        'messageId', NULL,
        'providerEvidenceReference', NULL,
        'reason', 'graph_delivery_requires_request_scoped_provider_evidence'
      ),
      CURRENT_TIMESTAMP
    ) ON CONFLICT ("id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.truthful_last_outbound()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  SELECT MAX(message."sentAt")
  INTO NEW."lastOutboundAt"
  FROM "Message" AS message
  WHERE message."conversationId" = NEW."id"
    AND message."direction" = 'OUTBOUND'
    AND message."status" IN ('SENT', 'DELIVERED', 'READ');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."resolveCreditLifeElectionForLoan"(policy_tenant_id text, policy_client_id text, policy_loan_id text)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  application_id TEXT;
  loan_agreement_document_id TEXT;
  agreement_document_id TEXT;
  agreement_document_sha256 TEXT;
  agreement_signed_at TIMESTAMP(3);
  document_sha256 TEXT;
  document_doc_type "DocType";
  document_mime_type TEXT;
  document_storage_path TEXT;
  document_file_name TEXT;
  document_file_size INTEGER;
  document_verified BOOLEAN;
  document_verified_at TIMESTAMP(3);
  document_deleted_at TIMESTAMP(3);
  document_signature_state TEXT;
  document_signed_at TIMESTAMP(3);
  matching_artifact RECORD;
  matching_artifact_count BIGINT := 0;
  matching_artifact_election BOOLEAN;
  matching_artifact_election_is_boolean BOOLEAN := false;
BEGIN
  IF policy_loan_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bundled credit-life policy requires a tenant-bound loan and authorising agreement artifact';
  END IF;

  PERFORM "lockBundledCreditLifeLoan"(policy_loan_id);

  SELECT
    loan."applicationId",
    loan."agreementDocId",
    application."agreementDocumentId",
    application."agreementDocumentSha256",
    application."agreementSignedAt",
    document."contentSha256",
    document."docType",
    document."mimeType",
    document."storagePath",
    document."fileName",
    document."fileSize",
    document."verified",
    document."verifiedAt",
    document."deletedAt",
    document."signatureState",
    document."signedAt"
  INTO
    application_id,
    loan_agreement_document_id,
    agreement_document_id,
    agreement_document_sha256,
    agreement_signed_at,
    document_sha256,
    document_doc_type,
    document_mime_type,
    document_storage_path,
    document_file_name,
    document_file_size,
    document_verified,
    document_verified_at,
    document_deleted_at,
    document_signature_state,
    document_signed_at
  FROM "Loan" AS loan
  JOIN "LoanApplication" AS application
    ON application."id" = loan."applicationId"
   AND application."tenantId" = loan."tenantId"
   AND application."clientId" = loan."clientId"
  JOIN "ClientDocument" AS document
    ON document."id" = application."agreementDocumentId"
   AND document."tenantId" = application."tenantId"
   AND document."clientId" = application."clientId"
  WHERE loan."id" = policy_loan_id
    AND loan."tenantId" = policy_tenant_id
    AND loan."clientId" = policy_client_id
  FOR KEY SHARE OF loan, application, document;

  IF NOT FOUND
     OR agreement_document_id IS NULL
     OR agreement_document_sha256 IS NULL
     OR agreement_document_sha256 !~ '^[0-9a-f]{64}$'
     OR agreement_signed_at IS NULL
     OR loan_agreement_document_id IS DISTINCT FROM agreement_document_id
     OR document_sha256 IS DISTINCT FROM agreement_document_sha256
     OR document_doc_type IS DISTINCT FROM 'CREDIT_AGREEMENT'::"DocType"
     OR document_mime_type IS DISTINCT FROM 'application/pdf'
     OR document_storage_path IS NULL
     OR BTRIM(document_storage_path) = ''
     OR document_file_name IS DISTINCT FROM
       ('credit-agreement-' || application_id || '.pdf')
     OR document_file_size IS NULL
     OR document_file_size <= 0
     OR document_verified IS DISTINCT FROM true
     OR document_verified_at IS NULL
     OR document_verified_at IS DISTINCT FROM document_signed_at
     OR document_deleted_at IS NOT NULL
     OR document_signature_state IS DISTINCT FROM 'signed'
     OR document_signed_at IS NULL
     OR document_signed_at IS DISTINCT FROM agreement_signed_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Bundled credit-life policy requires the exact signed, verified, non-deleted agreement document and immutable integrity metadata';
  END IF;

  -- FOR SHARE is load-bearing under SERIALIZABLE: if this transaction fixed
  -- its snapshot before a concurrent authorization mutation committed,
  -- PostgreSQL raises a serialization failure instead of letting the trigger
  -- validate stale artifact bytes. The reverse trigger uses the same loan
  -- advisory lock, so an in-flight mutation either completes before this lock
  -- or waits until the policy transaction commits.
  FOR matching_artifact IN
    SELECT artifact."data"
    FROM "ComplianceRecord" AS artifact
    WHERE artifact."tenantId" = policy_tenant_id
      AND artifact."type" = 'AGREEMENT_ARTIFACT'::"ComplianceType"
      AND artifact."referenceId" = application_id
      AND artifact."status" = 'COMPLETED'::"ComplianceStatus"
      AND artifact."completedAt" IS NOT NULL
      AND artifact."data" ->> 'kind' = 'CREDIT_AGREEMENT_ARTIFACT'
      AND artifact."data" ->> 'lifecycle' = 'COMPLETED'
      AND artifact."data" ->> 'applicationId' = application_id
      AND artifact."data" ->> 'documentId' = agreement_document_id
      AND artifact."data" ->> 'documentSha256' = agreement_document_sha256
      AND artifact."data" ->> 'storagePath' = document_storage_path
      AND artifact."data" ->> 'fileName' = document_file_name
      AND artifact."data" ->> 'fileSize' ~ '^[0-9]+$'
      AND (artifact."data" ->> 'fileSize')::BIGINT = document_file_size
    ORDER BY artifact."id"
    FOR SHARE
  LOOP
    matching_artifact_count := matching_artifact_count + 1;
    matching_artifact_election_is_boolean :=
      JSONB_TYPEOF(matching_artifact."data" -> 'creditLifeAutoBundleEligible') = 'boolean';
    IF matching_artifact_election_is_boolean THEN
      matching_artifact_election :=
        (matching_artifact."data" ->> 'creditLifeAutoBundleEligible')::BOOLEAN;
    END IF;
  END LOOP;

  IF matching_artifact_count <> 1 OR NOT matching_artifact_election_is_boolean THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan disbursement requires exactly one completed agreement artifact with an explicit boolean credit-life election';
  END IF;

  RETURN matching_artifact_election;
END;
$function$;

CREATE OR REPLACE FUNCTION public."validateLoanPasqV3Billing"(p_loan_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  booked RECORD;
  expected_schedule_count INTEGER;
  evidence_total_interest INTEGER;
  evidence_total_repayable INTEGER;
  actual_schedule_count INTEGER;
  actual_total_due BIGINT;
  actual_premium_due BIGINT;
  allocated_payment_total BIGINT;
  early_daily_settlement BOOLEAN;
BEGIN
  SELECT
    loan."id",
    loan."tenantId",
    loan."applicationId",
    loan."clientId",
    loan."productId",
    loan."principal",
    loan."totalInterest",
    loan."initiationFee",
    loan."creditLifePremiums",
    loan."totalRepayable",
    loan."contractualTotalInterest",
    loan."contractualTotalRepayable",
    loan."totalPaid",
    loan."outstandingPrincipal",
    loan."status",
    loan."closedAt",
    loan."interestModel",
    application."pasqVersion",
    application."pasqEvidence"
  INTO booked
  FROM "Loan" AS loan
  JOIN "LoanApplication" AS application
    ON application."id" = loan."applicationId"
  WHERE loan."id" = p_loan_id;

  IF NOT FOUND OR booked."pasqVersion" IS DISTINCT FROM 'pasq-v3' THEN
    RETURN;
  END IF;

  IF
    JSONB_TYPEOF(booked."pasqEvidence") <> 'object'
    OR JSONB_TYPEOF(booked."pasqEvidence" #> '{billing,schedule}') <> 'array'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan monetary fields do not match the acknowledged PASQ v3 billing evidence';
  END IF;

  evidence_total_interest :=
    (booked."pasqEvidence" #>> '{calculator,totalInterestCents}')::INTEGER;
  evidence_total_repayable :=
    (booked."pasqEvidence" #>> '{billing,totalRepayableCents}')::INTEGER;
  expected_schedule_count :=
    JSONB_ARRAY_LENGTH(booked."pasqEvidence" #> '{billing,schedule}');

  IF
    booked."tenantId" <> booked."pasqEvidence" ->> 'tenantId'
    OR booked."applicationId" <> booked."pasqEvidence" ->> 'applicationId'
    OR booked."clientId" <> booked."pasqEvidence" ->> 'clientId'
    OR booked."productId" <> booked."pasqEvidence" ->> 'productId'
    OR booked."principal"
      <> (booked."pasqEvidence" #>> '{calculator,principalCents}')::INTEGER
    OR booked."initiationFee"
      <> (booked."pasqEvidence" #>> '{calculator,initiationFeeCents}')::INTEGER
    OR booked."creditLifePremiums"
      <> (booked."pasqEvidence" #>> '{creditLife,totalPremiumCents}')::INTEGER
    OR (
      booked."contractualTotalInterest" IS NOT NULL
      AND booked."contractualTotalInterest" <> evidence_total_interest
    )
    OR (
      booked."contractualTotalRepayable" IS NOT NULL
      AND booked."contractualTotalRepayable" <> evidence_total_repayable
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan monetary fields do not match the acknowledged PASQ v3 billing evidence';
  END IF;

  early_daily_settlement :=
    booked."status" = 'COMPLETED'::"LoanStatus"
    AND booked."interestModel" = 'DAILY_ACCRUAL'::"InterestModel"
    AND booked."contractualTotalInterest" = evidence_total_interest
    AND booked."contractualTotalRepayable" = evidence_total_repayable
    AND booked."totalInterest" < evidence_total_interest
    AND booked."totalRepayable" < evidence_total_repayable;

  SELECT
    COUNT(*)::INTEGER,
    COALESCE(SUM(schedule."totalDue"), 0),
    COALESCE(SUM(schedule."creditLifePremiumDue"), 0)
  INTO actual_schedule_count, actual_total_due, actual_premium_due
  FROM "RepaymentSchedule" AS schedule
  WHERE schedule."loanId" = booked."id";

  IF early_daily_settlement THEN
    SELECT COALESCE(SUM(payment."amount"), 0)
    INTO allocated_payment_total
    FROM "Payment" AS payment
    WHERE payment."loanId" = booked."id"
      AND payment."tenantId" = booked."tenantId"
      AND payment."reversed" = FALSE
      AND payment."allocationStatus" = 'ALLOCATED'::"PaymentAllocationStatus";

    IF
      expected_schedule_count <> 1
      OR actual_schedule_count <> 1
      OR booked."totalInterest" < 0
      OR booked."totalRepayable"
        <> evidence_total_repayable
          - evidence_total_interest
          + booked."totalInterest"
      OR booked."totalPaid" <> booked."totalRepayable"
      OR allocated_payment_total <> booked."totalPaid"
      OR booked."outstandingPrincipal" <> 0
      OR booked."closedAt" IS NULL
      OR actual_total_due <> booked."totalRepayable"
      OR actual_premium_due <> booked."creditLifePremiums"
      OR EXISTS (
        SELECT 1
        FROM JSONB_ARRAY_ELEMENTS(
          booked."pasqEvidence" #> '{billing,schedule}'
        ) AS expected
        LEFT JOIN "RepaymentSchedule" AS actual
          ON actual."loanId" = booked."id"
          AND actual."installmentNo"
            = (expected ->> 'installmentNo')::INTEGER
        WHERE
          actual."id" IS NULL
          OR actual."tenantId" <> booked."tenantId"
          OR actual."principalDue"
            <> (expected ->> 'principalDueCents')::INTEGER
          OR actual."interestDue" <> booked."totalInterest"
          OR actual."creditLifePremiumDue"
            <> (expected ->> 'creditLifePremiumDueCents')::INTEGER
          OR actual."feesDue"
            <> (expected ->> 'feesDueCents')::INTEGER
          OR actual."totalDue" <> booked."totalRepayable"
          OR actual."totalPaid" <> actual."totalDue"
          OR actual."status" <> 'PAID'::"ScheduleStatus"
      )
      OR NOT EXISTS (
        SELECT 1
        FROM "Payment" AS payment
        JOIN "AuditLog" AS audit
          ON audit."tenantId" = booked."tenantId"
          AND (
            audit."newValue" ->> 'paymentId' = payment."id"
            OR (
              audit."entity" = 'Payment'
              AND audit."entityId" = payment."id"
            )
          )
        WHERE payment."loanId" = booked."id"
          AND payment."tenantId" = booked."tenantId"
          AND payment."reversed" = FALSE
          AND payment."allocationStatus"
            = 'ALLOCATED'::"PaymentAllocationStatus"
          AND audit."newValue" ->> 'earlyDailySettlement' = 'true'
          AND CASE
            WHEN audit."newValue" ->> 'accruedInterest' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'accruedInterest')::BIGINT
          END = booked."totalInterest"
          AND CASE
            WHEN audit."newValue" ->> 'interestRebate' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'interestRebate')::BIGINT
          END = evidence_total_interest - booked."totalInterest"
          AND CASE
            WHEN audit."newValue" ->> 'resultingTotalInterest' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'resultingTotalInterest')::BIGINT
          END = booked."totalInterest"
          AND CASE
            WHEN audit."newValue" ->> 'resultingTotalRepayable' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'resultingTotalRepayable')::BIGINT
          END = booked."totalRepayable"
          AND CASE
            WHEN audit."newValue" ->> 'contractualTotalInterest' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'contractualTotalInterest')::BIGINT
          END = evidence_total_interest
          AND CASE
            WHEN audit."newValue" ->> 'contractualTotalRepayable' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'contractualTotalRepayable')::BIGINT
          END = evidence_total_repayable
          AND CASE
            WHEN audit."newValue" ->> 'settlementDue' ~ '^[0-9]+$'
            THEN (audit."newValue" ->> 'settlementDue')::BIGINT
          END = payment."amount"
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Early DAILY_ACCRUAL settlement does not preserve PASQ v3 contractual and ledger evidence';
    END IF;
    RETURN;
  END IF;

  IF
    booked."totalInterest" <> evidence_total_interest
    OR booked."totalRepayable" <> evidence_total_repayable
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Loan monetary fields do not match the acknowledged PASQ v3 billing evidence';
  END IF;

  IF
    actual_schedule_count <> expected_schedule_count
    OR actual_total_due <> booked."totalRepayable"
    OR actual_premium_due <> booked."creditLifePremiums"
    OR EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(
        booked."pasqEvidence" #> '{billing,schedule}'
      ) AS expected
      LEFT JOIN "RepaymentSchedule" AS actual
        ON actual."loanId" = booked."id"
        AND actual."installmentNo"
          = (expected ->> 'installmentNo')::INTEGER
      WHERE
        actual."id" IS NULL
        OR actual."tenantId" <> booked."tenantId"
        OR actual."principalDue"
          <> (expected ->> 'principalDueCents')::INTEGER
        OR actual."interestDue"
          <> (expected ->> 'interestDueCents')::INTEGER
        OR actual."creditLifePremiumDue"
          <> (expected ->> 'creditLifePremiumDueCents')::INTEGER
        OR actual."feesDue"
          <> (expected ->> 'feesDueCents')::INTEGER
        OR actual."totalDue"
          <> (expected ->> 'totalDueCents')::INTEGER
    )
    OR EXISTS (
      SELECT 1
      FROM "RepaymentSchedule" AS actual
      WHERE actual."loanId" = booked."id"
        AND NOT EXISTS (
          SELECT 1
          FROM JSONB_ARRAY_ELEMENTS(
            booked."pasqEvidence" #> '{billing,schedule}'
          ) AS expected
          WHERE (expected ->> 'installmentNo')::INTEGER
            = actual."installmentNo"
        )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Repayment schedule does not match the acknowledged PASQ v3 billing evidence';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public."validateLoanPasqV3ScheduleDates"(p_loan_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  booked RECORD;
  quote_start_utc TIMESTAMP(3);
  quote_start_tz TIMESTAMPTZ;
  agreement_start_utc TIMESTAMP(3);
  agreement_offset INTERVAL;
  payout_offset INTERVAL;
  total_offset INTERVAL;
  agreement_sast_date DATE;
  payout_sast_date DATE;
  expected_maturity_utc TIMESTAMP(3);
BEGIN
  SELECT
    loan."id",
    loan."tenantId",
    loan."startDate",
    loan."maturityDate",
    application."pasqVersion",
    application."pasqEvidence",
    application."agreementGeneratedAt",
    application."repaymentMethod"
  INTO booked
  FROM "Loan" AS loan
  JOIN "LoanApplication" AS application
    ON application."id" = loan."applicationId"
  WHERE loan."id" = p_loan_id;

  IF NOT FOUND OR booked."pasqVersion" IS DISTINCT FROM 'pasq-v3' THEN
    RETURN;
  END IF;

  IF
    JSONB_TYPEOF(booked."pasqEvidence") <> 'object'
    OR JSONB_TYPEOF(booked."pasqEvidence" #> '{billing,schedule}')
      <> 'array'
    OR booked."agreementGeneratedAt" IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'PASQ v3 schedule date evidence is missing or invalid';
  END IF;

  quote_start_tz :=
    (booked."pasqEvidence" #>> '{calculator,startDate}')::TIMESTAMPTZ;
  quote_start_utc := quote_start_tz AT TIME ZONE 'UTC';
  agreement_start_utc := booked."agreementGeneratedAt";
  agreement_offset := agreement_start_utc - quote_start_utc;

  agreement_sast_date := (
    booked."agreementGeneratedAt" AT TIME ZONE 'UTC'
      AT TIME ZONE 'Africa/Johannesburg'
  )::DATE;
  payout_sast_date := (
    booked."startDate" AT TIME ZONE 'UTC'
      AT TIME ZONE 'Africa/Johannesburg'
  )::DATE;

  -- Zero for a debit order or an unknown method, so their behaviour is
  -- byte-identical to before this migration.
  IF booked."repaymentMethod" = 'EFT' THEN
    payout_offset := (payout_sast_date - agreement_sast_date) * INTERVAL '1 day';
  ELSE
    payout_offset := INTERVAL '0 milliseconds';
  END IF;
  total_offset := agreement_offset + payout_offset;

  SELECT
    (
      (expected ->> 'dueDate')::TIMESTAMPTZ AT TIME ZONE 'UTC'
    ) + total_offset
  INTO expected_maturity_utc
  FROM JSONB_ARRAY_ELEMENTS(
    booked."pasqEvidence" #> '{billing,schedule}'
  ) AS expected
  ORDER BY (expected ->> 'installmentNo')::INTEGER DESC
  LIMIT 1;

  IF
    agreement_offset < INTERVAL '0 milliseconds'
    -- Payout may never precede the agreement, for any method.
    OR payout_offset < INTERVAL '0 milliseconds'
    OR agreement_sast_date > "quoteValidUntilDate"(quote_start_tz)
    -- s92(3) now bounds the PAYOUT too. Without this, relaxing the calendar-day
    -- equality below would leave an EFT contract disbursable indefinitely.
    OR payout_sast_date > "quoteValidUntilDate"(quote_start_tz)
    -- The same-day clamp, now only where a signed mandate fixes the dates.
    OR (
      booked."repaymentMethod" IS DISTINCT FROM 'EFT'
      AND payout_sast_date <> agreement_sast_date
    )
    OR expected_maturity_utc IS NULL
    OR booked."maturityDate" <> expected_maturity_utc
    OR EXISTS (
      SELECT 1
      FROM JSONB_ARRAY_ELEMENTS(
        booked."pasqEvidence" #> '{billing,schedule}'
      ) AS expected
      LEFT JOIN "RepaymentSchedule" AS actual
        ON actual."loanId" = booked."id"
        AND actual."installmentNo"
          = (expected ->> 'installmentNo')::INTEGER
      WHERE
        actual."id" IS NULL
        OR actual."dueDate" <> (
          (
            (expected ->> 'dueDate')::TIMESTAMPTZ AT TIME ZONE 'UTC'
          ) + total_offset
        )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Repayment schedule dates do not match the PASQ v3 quote window and signed agreement';
  END IF;
END;
$function$;

RESET check_function_bodies;

-- ── Column defaults ───────────────────────────────────────────────────────

-- ── Constraints ───────────────────────────────────────────────────────────
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_biometric_attempt_sequence_check" CHECK (((("docType" = 'SELFIE'::"DocType") AND ("biometricAttemptSequence" IS NOT NULL) AND ("biometricAttemptSequence" > 0)) OR (("docType" <> 'SELFIE'::"DocType") AND ("biometricAttemptSequence" IS NULL))));
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_contentSha256_format_check" CHECK ((("contentSha256" IS NULL) OR ("contentSha256" ~ '^[0-9a-f]{64}$'::text)));
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_standalone_fais_required" CHECK ((("policySource" <> 'STANDALONE'::"PolicySource") OR (("faisDisclosureAt" IS NOT NULL) AND ("faisDisclosurePdfUrl" IS NOT NULL))));
ALTER TABLE "InsuranceProduct" ADD CONSTRAINT "InsuranceProduct_tenantId_id_key" UNIQUE USING INDEX "InsuranceProduct_tenantId_id_key";
ALTER TABLE "Insurer" ADD CONSTRAINT "Insurer_tenantId_id_key" UNIQUE USING INDEX "Insurer_tenantId_id_key";
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_conversion_link_state_check" CHECK ((((status <> 'CONVERTED'::"LeadStatus") AND ("convertedToClientId" IS NULL) AND ("convertedToApplicationId" IS NULL) AND ("conversionRecoveryRequired" = false)) OR ((status = 'CONVERTED'::"LeadStatus") AND ("convertedToClientId" IS NOT NULL) AND ("convertedToApplicationId" IS NOT NULL) AND ("conversionRecoveryRequired" = false)) OR ((status = 'CONVERTED'::"LeadStatus") AND ("convertedToApplicationId" IS NULL) AND ("conversionRecoveryRequired" = true))));
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_submission_idempotency_complete" CHECK (((("submissionKey" IS NULL) AND ("submissionFingerprint" IS NULL) AND ("submissionReference" IS NULL)) OR (("submissionKey" IS NOT NULL) AND (("submissionKey")::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ("submissionFingerprint" IS NOT NULL) AND ("submissionFingerprint" ~ '^[0-9a-f]{64}$'::text) AND ("submissionReference" IS NOT NULL) AND (length(btrim(("submissionReference")::text)) > 0))));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_acknowledgement_requires_pasq_document" CHECK ((("pasqAcknowledgedAt" IS NULL) OR (("pasqDocumentId" IS NOT NULL) AND ("pasqDocumentSha256" IS NOT NULL)))) NOT VALID;
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_agreementDocumentSha256_format_check" CHECK ((("agreementDocumentSha256" IS NULL) OR ("agreementDocumentSha256" ~ '^[0-9a-f]{64}$'::text)));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_agreementDocument_binding_check" CHECK ((("agreementDocumentId" IS NULL) = ("agreementDocumentSha256" IS NULL)));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_agreement_chronology" CHECK (((("agreementSignedAt" IS NULL) OR ("agreementGeneratedAt" IS NOT NULL)) AND (("agreementCountersignedAt" IS NULL) OR ("agreementGeneratedAt" IS NOT NULL)))) NOT VALID;
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_approved_pasq_bound" CHECK ((("approvedPasqDocumentSha256" IS NULL) OR (("approvedPasqDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("approvedPasqDocumentSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqAcknowledgedSha256"))));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_approved_status_requires_pasq" CHECK ((((((status)::text <> ALL (ARRAY['APPROVED'::text, 'DISBURSED'::text])) OR (((status)::text = 'APPROVED'::text) AND ("agreementSignedAt" IS NULL) AND ("agreementCountersignedAt" IS NULL) AND ("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL) AND (length(btrim("approvedById")) > 0) AND ((("pasqVersion" IS NULL) AND ("pasqGeneratedAt" IS NULL) AND ("pasqDocumentId" IS NULL) AND ("pasqDocumentSha256" IS NULL) AND ("pasqEvidence" IS NULL) AND ("pasqEvidenceSha256" IS NULL) AND ("pasqAcknowledgedAt" IS NULL) AND ("pasqAcknowledgedBy" IS NULL) AND ("pasqAcknowledgedSha256" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) OR (("pasqVersion" = 'pasq-v3'::text) AND ("pasqGeneratedAt" IS NOT NULL) AND ("pasqDocumentId" IS NOT NULL) AND (length(btrim("pasqDocumentId")) > 0) AND ("pasqDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("pasqEvidence" IS NOT NULL) AND (jsonb_typeof("pasqEvidence") = 'object'::text) AND ("pasqEvidenceSha256" ~ '^[0-9a-f]{64}$'::text) AND (("pasqEvidence" ->> 'version'::text) = 'pasq-v3'::text) AND (("pasqEvidence" ->> 'tenantId'::text) = "tenantId") AND (("pasqEvidence" ->> 'applicationId'::text) = id) AND (("pasqEvidence" ->> 'clientId'::text) = "clientId") AND (("pasqEvidence" ->> 'productId'::text) = "productId") AND (("pasqEvidence" #>> '{billing,version}'::text[]) = 'credit-life-billing-v1'::text) AND (("pasqEvidence" #>> '{billing,collectionMethod}'::text[]) = 'INCLUDED_IN_LOAN_REPAYMENT'::text) AND (("pasqEvidence" ->> 'evidenceSha256'::text) = "pasqEvidenceSha256") AND ("pasqEvidenceSha256V3"("pasqEvidence") = "pasqEvidenceSha256") AND "pasqCreditLifeMatchesApplication"("pasqEvidence", ("creditLifeElection")::text, "creditLifeProductId", "creditLifeProductName", "creditLifeInsurerId", "creditLifeInsurerName", "creditLifeMonthlyPremiumCents", "creditLifeDisclosureVersion", "creditLifeDisclosureSha256", "creditLifeDisclosureAcknowledgedAt", "creditLifeDisclosureAcknowledgedBy", "clientId", "appliedAmount", "appliedTermDays", "pasqGeneratedAt") AND ((("pasqAcknowledgedAt" IS NULL) AND ("pasqAcknowledgedBy" IS NULL) AND ("pasqAcknowledgedSha256" IS NULL) AND ("approvedPasqDocumentSha256" IS NULL)) OR (("pasqAcknowledgedAt" IS NOT NULL) AND ("pasqAcknowledgedAt" >= "pasqGeneratedAt") AND ("pasqAcknowledgedBy" = "clientId") AND ("pasqAcknowledgedSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqAcknowledgedSha256")))))) OR (("approvedAt" IS NOT NULL) AND ("approvedById" IS NOT NULL) AND (length(btrim("approvedById")) > 0) AND ("pasqVersion" = 'pasq-v3'::text) AND ("pasqGeneratedAt" IS NOT NULL) AND ("pasqDocumentId" IS NOT NULL) AND (length(btrim("pasqDocumentId")) > 0) AND ("pasqDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("pasqEvidence" IS NOT NULL) AND (jsonb_typeof("pasqEvidence") = 'object'::text) AND ("pasqEvidenceSha256" ~ '^[0-9a-f]{64}$'::text) AND (("pasqEvidence" ->> 'version'::text) = 'pasq-v3'::text) AND (("pasqEvidence" ->> 'tenantId'::text) = "tenantId") AND (("pasqEvidence" ->> 'applicationId'::text) = id) AND (("pasqEvidence" ->> 'clientId'::text) = "clientId") AND (("pasqEvidence" ->> 'productId'::text) = "productId") AND (("pasqEvidence" #>> '{billing,version}'::text[]) = 'credit-life-billing-v1'::text) AND (("pasqEvidence" #>> '{billing,collectionMethod}'::text[]) = 'INCLUDED_IN_LOAN_REPAYMENT'::text) AND (("pasqEvidence" ->> 'evidenceSha256'::text) = "pasqEvidenceSha256") AND ("pasqEvidenceSha256V3"("pasqEvidence") = "pasqEvidenceSha256") AND ("pasqAcknowledgedAt" IS NOT NULL) AND ("pasqAcknowledgedAt" >= "pasqGeneratedAt") AND ("pasqAcknowledgedBy" = "clientId") AND ("pasqAcknowledgedSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqDocumentSha256") AND ("approvedPasqDocumentSha256" = "pasqAcknowledgedSha256") AND "pasqCreditLifeMatchesApplication"("pasqEvidence", ("creditLifeElection")::text, "creditLifeProductId", "creditLifeProductName", "creditLifeInsurerId", "creditLifeInsurerName", "creditLifeMonthlyPremiumCents", "creditLifeDisclosureVersion", "creditLifeDisclosureSha256", "creditLifeDisclosureAcknowledgedAt", "creditLifeDisclosureAcknowledgedBy", "clientId", "appliedAmount", "appliedTermDays", "pasqGeneratedAt"))) IS TRUE) OR "validOutageDisbursementException"("tenantId", id, reference, "disbursedAt", "disbursementExceptionId"))) NOT VALID;
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_countersign_complete_check" CHECK (((("agreementCountersignedAt" IS NULL) AND ("agreementCountersignedById" IS NULL) AND ("agreementCountersignedByName" IS NULL) AND ("agreementCountersignedByEmail" IS NULL) AND ("agreementCountersignatureData" IS NULL) AND ("agreementCountersignatureSha256" IS NULL) AND ("agreementCountersignedDocumentSha256" IS NULL)) OR (("agreementCountersignedAt" IS NOT NULL) AND ("agreementCountersignedById" IS NOT NULL) AND (length(btrim("agreementCountersignedById")) > 0) AND ("agreementCountersignedByName" IS NOT NULL) AND (length(btrim("agreementCountersignedByName")) > 0) AND ("agreementCountersignedByEmail" IS NOT NULL) AND (length(btrim("agreementCountersignedByEmail")) > 0) AND ("agreementCountersignatureData" IS NOT NULL) AND (length(btrim("agreementCountersignatureData")) > 0) AND ("agreementCountersignatureSha256" IS NOT NULL) AND ("agreementCountersignatureSha256" ~ '^[0-9a-f]{64}$'::text) AND ("agreementCountersignedDocumentSha256" IS NOT NULL) AND ("agreementCountersignedDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("agreementSignedAt" IS NOT NULL) AND ("agreementCountersignedAt" >= "agreementSignedAt") AND ("agreementCountersignedDocumentSha256" = "agreementDocumentSha256"))));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_countersign_envelope_digest" CHECK ((("agreementCountersignatureEnvelopeSha256" IS NULL) OR ("agreementCountersignatureEnvelopeSha256" ~ '^[0-9a-f]{64}$'::text)));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_credit_life_election_complete" CHECK ((((("creditLifeElection" IS NULL) AND ("creditLifeProductId" IS NULL) AND ("creditLifeProductName" IS NULL) AND ("creditLifeInsurerId" IS NULL) AND ("creditLifeInsurerName" IS NULL) AND ("creditLifeMonthlyPremiumCents" IS NULL) AND ("creditLifeDisclosureVersion" IS NULL) AND ("creditLifeDisclosureSha256" IS NULL) AND ("creditLifeDisclosureAcknowledgedAt" IS NULL) AND ("creditLifeDisclosureAcknowledgedBy" IS NULL)) OR (("creditLifeElection" IS NOT NULL) AND ("creditLifeProductId" IS NOT NULL) AND (length(btrim("creditLifeProductId")) > 0) AND ("creditLifeProductName" IS NOT NULL) AND (length(btrim("creditLifeProductName")) > 0) AND ("creditLifeInsurerId" IS NOT NULL) AND (length(btrim("creditLifeInsurerId")) > 0) AND ("creditLifeInsurerName" IS NOT NULL) AND (length(btrim("creditLifeInsurerName")) > 0) AND ("creditLifeMonthlyPremiumCents" IS NOT NULL) AND ("creditLifeMonthlyPremiumCents" > 0) AND ("creditLifeDisclosureVersion" IS NOT NULL) AND ("creditLifeDisclosureVersion" = 'credit-life-election-v1'::text) AND ("creditLifeDisclosureSha256" IS NOT NULL) AND ("creditLifeDisclosureSha256" ~ '^[0-9a-f]{64}$'::text) AND ("creditLifeDisclosureAcknowledgedAt" IS NOT NULL) AND ("creditLifeDisclosureAcknowledgedBy" IS NOT NULL) AND (length(btrim("creditLifeDisclosureAcknowledgedBy")) > 0)) OR (("creditLifeElection" IS NOT NULL) AND ("creditLifeElection" = 'DECLINED'::"CreditLifeElection") AND ("creditLifeProductId" IS NULL) AND ("creditLifeProductName" IS NULL) AND ("creditLifeInsurerId" IS NULL) AND ("creditLifeInsurerName" IS NULL) AND ("creditLifeMonthlyPremiumCents" IS NOT NULL) AND ("creditLifeMonthlyPremiumCents" = 0) AND ("creditLifeDisclosureVersion" IS NOT NULL) AND ("creditLifeDisclosureVersion" = 'credit-life-no-offer-v1'::text) AND ("creditLifeDisclosureSha256" IS NOT NULL) AND ("creditLifeDisclosureSha256" ~ '^[0-9a-f]{64}$'::text) AND ("creditLifeDisclosureAcknowledgedAt" IS NOT NULL) AND ("creditLifeDisclosureAcknowledgedBy" IS NOT NULL) AND (length(btrim("creditLifeDisclosureAcknowledgedBy")) > 0))) IS TRUE));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_debit_mandate_preparation_complete" CHECK (((("debitMandatePreparedAt" IS NULL) AND ("debitMandateReference" IS NULL) AND ("debitMandateDraftSha256" IS NULL) AND ("debitMandateEvidence" IS NULL) AND ("debitMandateEvidenceSha256" IS NULL)) OR (("debitMandatePreparedAt" IS NOT NULL) AND ("debitMandateReference" IS NOT NULL) AND (length(btrim("debitMandateReference")) > 0) AND ("debitMandateDraftSha256" IS NOT NULL) AND ("debitMandateDraftSha256" ~ '^[0-9a-f]{64}$'::text) AND ("debitMandateEvidence" IS NOT NULL) AND ("debitMandateEvidenceSha256" IS NOT NULL) AND ("debitMandateEvidenceSha256" ~ '^[0-9a-f]{64}$'::text))));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_debit_mandate_signature_complete" CHECK (((("debitMandateSignedAt" IS NULL) AND ("debitMandateSignedMethod" IS NULL) AND ("debitMandateSignedByIp" IS NULL) AND ("debitMandateSignatureData" IS NULL) AND ("debitMandateSignatureSha256" IS NULL) AND ("debitMandateDocumentId" IS NULL) AND ("debitMandateDocumentSha256" IS NULL)) OR (("debitMandateSignedAt" IS NOT NULL) AND ("debitMandateSignedMethod" = 'portal'::text) AND ("debitMandateSignatureData" IS NOT NULL) AND (length(btrim("debitMandateSignatureData")) > 0) AND ("debitMandateSignatureSha256" IS NOT NULL) AND ("debitMandateSignatureSha256" ~ '^[0-9a-f]{64}$'::text) AND ("debitMandateDocumentId" IS NOT NULL) AND (length(btrim("debitMandateDocumentId")) > 0) AND ("debitMandateDocumentSha256" IS NOT NULL) AND ("debitMandateDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("debitMandatePreparedAt" IS NOT NULL) AND ("agreementSignedAt" IS NOT NULL) AND ("debitMandateSignedAt" >= "debitMandatePreparedAt") AND ("debitMandateSignedAt" >= "agreementSignedAt"))));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_eft_has_no_signed_debit_authority" CHECK ((("repaymentMethod" IS DISTINCT FROM 'EFT'::"LoanRepaymentMethod") OR (("debitMandateSignedAt" IS NULL) AND ("debitMandateSignedMethod" IS NULL) AND ("debitMandateSignedByIp" IS NULL) AND ("debitMandateSignatureData" IS NULL) AND ("debitMandateSignatureSha256" IS NULL) AND ("debitMandateDocumentId" IS NULL) AND ("debitMandateDocumentSha256" IS NULL))));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_pasq_acknowledgement_bound" CHECK ((("pasqAcknowledgedSha256" IS NULL) OR (("pasqAcknowledgedAt" IS NOT NULL) AND ("pasqAcknowledgedBy" IS NOT NULL) AND (length(btrim("pasqAcknowledgedBy")) > 0) AND ("pasqAcknowledgedSha256" ~ '^[0-9a-f]{64}$'::text) AND ("pasqAcknowledgedSha256" = "pasqDocumentSha256") AND ("pasqAcknowledgedAt" >= "pasqGeneratedAt"))));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_pasq_document_complete" CHECK (((("pasqVersion" IS NULL) AND ("pasqGeneratedAt" IS NULL) AND ("pasqDocumentId" IS NULL) AND ("pasqDocumentSha256" IS NULL) AND ("pasqEvidence" IS NULL) AND ("pasqEvidenceSha256" IS NULL)) OR (("pasqVersion" = ANY (ARRAY['pasq-v1'::text, 'pasq-v2'::text, 'pasq-v3'::text])) AND ("pasqGeneratedAt" IS NOT NULL) AND ("pasqDocumentId" IS NOT NULL) AND (length(btrim("pasqDocumentId")) > 0) AND ("pasqDocumentSha256" IS NOT NULL) AND ("pasqDocumentSha256" ~ '^[0-9a-f]{64}$'::text) AND ("pasqEvidence" IS NOT NULL) AND ("pasqEvidenceSha256" IS NOT NULL) AND ("pasqEvidenceSha256" ~ '^[0-9a-f]{64}$'::text))));
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_repayment_method_lifecycle" CHECK ((((status = ANY (ARRAY['DRAFT'::"AppStatus", 'SUBMITTED'::"AppStatus", 'UNDER_REVIEW'::"AppStatus"])) AND ("repaymentMethod" IS NULL)) OR ((status = ANY (ARRAY['APPROVED'::"AppStatus", 'DISBURSED'::"AppStatus"])) AND ("repaymentMethod" IS NOT NULL)) OR (status = ANY (ARRAY['DECLINED'::"AppStatus", 'CANCELLED'::"AppStatus"]))));
ALTER TABLE "LoanProduct" ADD CONSTRAINT "LoanProduct_tenantId_id_key" UNIQUE USING INDEX "LoanProduct_tenantId_id_key";
ALTER TABLE "Message" ADD CONSTRAINT "message_recording_requires_disclosure" CHECK ((("recordingKey" IS NULL) OR ("disclosureDeliveredAt" IS NOT NULL)));
ALTER TABLE "PasqAcknowledgementToken" ADD CONSTRAINT "PasqAcknowledgementToken_channel_check" CHECK ((channel = ANY (ARRAY['SMS'::text, 'WHATSAPP'::text, 'EMAIL'::text])));
ALTER TABLE "PasqAcknowledgementToken" ADD CONSTRAINT "PasqAcknowledgementToken_documentSha256_format_check" CHECK (("documentSha256" ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE "PasqAcknowledgementToken" ADD CONSTRAINT "PasqAcknowledgementToken_tokenHash_format_check" CHECK (("tokenHash" ~ '^[0-9a-f]{64}$'::text));
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_id_key" UNIQUE USING INDEX "User_tenantId_id_key";

-- ── Indexes ───────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "BureauSubmissionRecord_live_once_only_status_key" ON "BureauSubmissionRecord" USING btree ("loanId", kind, "statusCode") WHERE ((mode = 'LIVE'::"BureauSubmissionMode") AND ("heldReason" IS NULL) AND ("statusCode" = ANY (ARRAY['C'::text, 'T'::text, 'W'::text, 'L'::text, 'Z'::text])));
CREATE UNIQUE INDEX "ClientDocument_biometric_attempt_sequence_key" ON "ClientDocument" USING btree ("tenantId", "clientId", "biometricAttemptSequence") WHERE ("docType" = 'SELFIE'::"DocType");
CREATE UNIQUE INDEX "ComplianceRecord_exact_completed_agreement_artifact_key" ON "ComplianceRecord" USING btree ("tenantId", "referenceId", ((data ->> 'documentId'::text)), ((data ->> 'documentSha256'::text))) WHERE ((type = 'AGREEMENT_ARTIFACT'::"ComplianceType") AND (status = 'COMPLETED'::"ComplianceStatus") AND ("completedAt" IS NOT NULL) AND ((data ->> 'kind'::text) = 'CREDIT_AGREEMENT_ARTIFACT'::text) AND ((data ->> 'lifecycle'::text) = 'COMPLETED'::text));
CREATE UNIQUE INDEX contact_consent_current_unique ON "ContactConsent" USING btree ("contactId", channel, purpose) WHERE ("effectiveTo" IS NULL);
CREATE UNIQUE INDEX "Conversation_one_open_per_contact" ON "Conversation" USING btree ("tenantId", "contactId") WHERE ("closedAt" IS NULL);
CREATE INDEX conversations_unassigned ON "Conversation" USING btree ("tenantId", "lastInboundAt") WHERE (("assigneeId" IS NULL) AND (status = 'OPEN'::"ConvStatus"));
CREATE UNIQUE INDEX "InsurancePolicy_one_bundled_credit_life_per_loan" ON "InsurancePolicy" USING btree ("linkedLoanId") WHERE ((type = 'CREDIT_LIFE'::"InsurancePolicyType") AND ("policySource" = 'BUNDLED_CREDIT_AGREEMENT'::"PolicySource") AND ("linkedLoanId" IS NOT NULL));
CREATE UNIQUE INDEX "LoanApplication_debitMandateReference_key" ON "LoanApplication" USING btree ("debitMandateReference") WHERE ("debitMandateReference" IS NOT NULL);
CREATE UNIQUE INDEX "LoanApplication_one_open_per_client_product_idx" ON "LoanApplication" USING btree ("tenantId", "clientId", "productId") WHERE (status = ANY (ARRAY['DRAFT'::"AppStatus", 'SUBMITTED'::"AppStatus", 'UNDER_REVIEW'::"AppStatus", 'APPROVED'::"AppStatus"]));
CREATE INDEX "Message_retry_pending_idx" ON "Message" USING btree ("nextRetryAt") WHERE (status = 'RETRYING'::"MsgStatus");
CREATE UNIQUE INDEX "PasqAcknowledgementToken_one_active_per_application" ON "PasqAcknowledgementToken" USING btree ("tenantId", "applicationId") WHERE (("usedAt" IS NULL) AND ("invalidatedAt" IS NULL));
CREATE UNIQUE INDEX "SelfieCaptureToken_one_active_per_application" ON "SelfieCaptureToken" USING btree ("tenantId", "applicationId") WHERE (("usedAt" IS NULL) AND ("invalidatedAt" IS NULL));

-- ── Triggers ──────────────────────────────────────────────────────────────
CREATE TRIGGER "AuditLog_legacy_placeholder_guard" BEFORE INSERT OR UPDATE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION guard_legacy_placeholder_audit();
CREATE TRIGGER "AuditLog_truthful_dry_run" BEFORE INSERT OR UPDATE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION truthful_dry_run_audit();
CREATE TRIGGER "Client_enforce_composite_kyc" BEFORE INSERT OR UPDATE ON "Client" FOR EACH ROW EXECUTE FUNCTION enforce_composite_kyc_projection();
CREATE TRIGGER "ClientDocument_biometric_attempt_sequence" BEFORE INSERT OR UPDATE OF "tenantId", "clientId", "docType", "biometricAttemptSequence" ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION assign_biometric_attempt_sequence();
CREATE TRIGGER "ClientDocument_guard_bound_agreement_delete" BEFORE DELETE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION "guardBoundAgreementDocument"();
CREATE TRIGGER "ClientDocument_guard_bound_agreement_update" BEFORE UPDATE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION "guardBoundAgreementDocument"();
CREATE TRIGGER "ClientDocument_guard_bound_debit_mandate" BEFORE DELETE OR UPDATE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION "guardBoundDebitMandateDocument"();
CREATE TRIGGER "ClientDocument_guard_bound_executed_agreement_delete" BEFORE DELETE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION "guardBoundExecutedAgreement"();
CREATE TRIGGER "ClientDocument_guard_bound_executed_agreement_update" BEFORE UPDATE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION "guardBoundExecutedAgreement"();
CREATE TRIGGER "ClientDocument_guard_bound_pasq_delete" BEFORE DELETE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION "guardBoundPasqDocument"();
CREATE TRIGGER "ClientDocument_guard_bound_pasq_update" BEFORE UPDATE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION "guardBoundPasqDocument"();
CREATE TRIGGER "ClientDocument_guard_signed_debit_mandate_artifact" BEFORE DELETE OR UPDATE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION "guardSignedDebitMandateArtifact"();
CREATE TRIGGER "ClientDocument_revoke_stale_composite_kyc" AFTER INSERT OR DELETE OR UPDATE ON "ClientDocument" FOR EACH ROW EXECUTE FUNCTION revoke_stale_composite_kyc();
CREATE TRIGGER "ComplianceRecord_guard_completed_kyc_exception_immutable" BEFORE DELETE OR UPDATE ON "ComplianceRecord" FOR EACH ROW EXECUTE FUNCTION guard_completed_kyc_exception_immutable();
CREATE TRIGGER "ComplianceRecord_guard_outage_disbursement_exception" BEFORE INSERT OR DELETE OR UPDATE ON "ComplianceRecord" FOR EACH ROW EXECUTE FUNCTION "guardOutageDisbursementExceptionRecord"();
CREATE TRIGGER "ComplianceRecord_lock_bundled_credit_life_dependencies" BEFORE INSERT OR DELETE OR UPDATE ON "ComplianceRecord" FOR EACH ROW EXECUTE FUNCTION "lockBundledCreditLifeDependencies"();
CREATE TRIGGER "ComplianceRecord_revoke_stale_kyc_exception" AFTER INSERT OR DELETE OR UPDATE ON "ComplianceRecord" FOR EACH ROW EXECUTE FUNCTION revoke_stale_kyc_exception();
CREATE TRIGGER "Conversation_truthful_last_outbound" BEFORE UPDATE OF "lastOutboundAt" ON "Conversation" FOR EACH ROW WHEN ((old."lastOutboundAt" IS DISTINCT FROM new."lastOutboundAt")) EXECUTE FUNCTION truthful_last_outbound();
CREATE TRIGGER "EmailLog_stage_ambiguous_status" BEFORE INSERT OR UPDATE OF status ON "EmailLog" FOR EACH ROW EXECUTE FUNCTION stage_email_log_ambiguous_status();
CREATE TRIGGER "EmailLog_truthful_graph_evidence" BEFORE INSERT OR UPDATE OF status, provider, "messageId", "providerEvidenceReference" ON "EmailLog" FOR EACH ROW EXECUTE FUNCTION truthful_graph_email_log();
CREATE TRIGGER "Lead_complete_legacy_website_conversion" BEFORE UPDATE ON "Lead" FOR EACH ROW EXECUTE FUNCTION complete_legacy_website_lead_conversion();
CREATE CONSTRAINT TRIGGER "Loan_guard_pasq_v3_billing" AFTER INSERT OR UPDATE ON "Loan" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "guardLoanPasqV3Billing"();
CREATE CONSTRAINT TRIGGER "Loan_guard_pasq_v3_schedule_dates" AFTER INSERT OR UPDATE ON "Loan" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "guardLoanPasqV3ScheduleDates"();
CREATE TRIGGER "LoanApplication_a_lock_pasq_document_on_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "lockLoanApplicationPasqDocument"();
CREATE TRIGGER "LoanApplication_a_lock_pasq_document_on_update" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW WHEN (((to_jsonb(new.*) - 'repaymentMethod'::text) IS DISTINCT FROM (to_jsonb(old.*) - 'repaymentMethod'::text))) EXECUTE FUNCTION "lockLoanApplicationPasqDocument"();
CREATE TRIGGER "LoanApplication_guard_branch_signer_tenant_update" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW WHEN (((to_jsonb(new.*) - 'repaymentMethod'::text) IS DISTINCT FROM (to_jsonb(old.*) - 'repaymentMethod'::text))) EXECUTE FUNCTION "guardLoanApplicationBranchSignerTenant"();
CREATE TRIGGER "LoanApplication_guard_debit_mandate_contract_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW WHEN ((new."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod")) EXECUTE FUNCTION "guardLoanApplicationDebitMandateContractTerms"();
CREATE TRIGGER "LoanApplication_guard_debit_mandate_contract_update" BEFORE UPDATE OF status, "repaymentMethod", "affordabilityResult", "pasqEvidence", "initiationFeePayment", "debitMandateEvidence", "debitMandateSignedAt" ON "LoanApplication" FOR EACH ROW WHEN (((old."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod") OR (new."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod"))) EXECUTE FUNCTION "guardLoanApplicationDebitMandateContractTerms"();
CREATE TRIGGER "LoanApplication_guard_debit_mandate_update" BEFORE UPDATE OF status, "repaymentMethod", "debitMandatePreparedAt", "debitMandateReference", "debitMandateDraftSha256", "debitMandateEvidence", "debitMandateEvidenceSha256", "debitMandateSignedAt", "debitMandateSignedMethod", "debitMandateSignedByIp", "debitMandateSignatureData", "debitMandateSignatureSha256", "debitMandateDocumentId", "debitMandateDocumentSha256" ON "LoanApplication" FOR EACH ROW WHEN (((old."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod") OR (new."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod"))) EXECUTE FUNCTION "guardLoanApplicationDebitMandate"();
CREATE TRIGGER "LoanApplication_guard_decision_history_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationDecisionHistoryInsert"();
CREATE TRIGGER "LoanApplication_guard_outage_exception_binding" BEFORE INSERT OR DELETE OR UPDATE ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationOutageExceptionBinding"();
CREATE TRIGGER "LoanApplication_guard_pasq_update" BEFORE UPDATE OF status, "approvedAt", "approvedById", "pasqVersion", "pasqGeneratedAt", "pasqDocumentId", "pasqDocumentSha256", "pasqEvidence", "pasqEvidenceSha256", "pasqAcknowledgedAt", "pasqAcknowledgedBy", "pasqAcknowledgedSha256", "approvedPasqDocumentSha256", "agreementGeneratedAt", "agreementSignedAt", "agreementCountersignedAt", "creditLifeElection", "creditLifeProductId", "creditLifeProductName", "creditLifeInsurerId", "creditLifeInsurerName", "creditLifeMonthlyPremiumCents", "creditLifeDisclosureVersion", "creditLifeDisclosureSha256", "creditLifeDisclosureAcknowledgedAt", "creditLifeDisclosureAcknowledgedBy" ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationPasqApproval"();
CREATE TRIGGER "LoanApplication_guard_provider_countersign_update" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW WHEN (((to_jsonb(new.*) - 'repaymentMethod'::text) IS DISTINCT FROM (to_jsonb(old.*) - 'repaymentMethod'::text))) EXECUTE FUNCTION "guardLoanApplicationProviderCountersign"();
CREATE TRIGGER "LoanApplication_guard_provider_signer_tenant_update" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW WHEN (((to_jsonb(new.*) - 'repaymentMethod'::text) IS DISTINCT FROM (to_jsonb(old.*) - 'repaymentMethod'::text))) EXECUTE FUNCTION "guardLoanApplicationProviderSignerTenant"();
CREATE TRIGGER "LoanApplication_guard_repayment_method" BEFORE UPDATE OF status, "repaymentMethod" ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationRepaymentMethod"();
CREATE TRIGGER "LoanApplication_guard_signed_debit_mandate_authority" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW WHEN (((to_jsonb(new.*) - 'repaymentMethod'::text) IS DISTINCT FROM (to_jsonb(old.*) - 'repaymentMethod'::text))) EXECUTE FUNCTION "guardSignedDebitMandateAuthority"();
CREATE TRIGGER "LoanApplication_guard_tenant_binding_update" BEFORE UPDATE OF "tenantId", "clientId", "productId", "pasqDocumentId" ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationTenantBinding"();
CREATE TRIGGER "LoanApplication_h_lock_credit_life_offer_on_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationCreditLifeOffer"();
CREATE TRIGGER "LoanApplication_h_lock_credit_life_offer_on_update" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationCreditLifeOffer"();
CREATE TRIGGER "LoanApplication_repair_debit_mandate_bank_tuple_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW WHEN ((new."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod")) EXECUTE FUNCTION "guardLoanApplicationDebitMandateBankTupleRepair"();
CREATE TRIGGER "LoanApplication_repair_debit_mandate_bank_tuple_update" BEFORE UPDATE OF status, "repaymentMethod", "tenantId", "clientId", "debitMandateEvidence" ON "LoanApplication" FOR EACH ROW WHEN (((old."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod") OR (new."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod"))) EXECUTE FUNCTION "guardLoanApplicationDebitMandateBankTupleRepair"();
CREATE TRIGGER "LoanApplication_require_branch_signer_tenant_on_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationBranchSignerTenant"();
CREATE TRIGGER "LoanApplication_require_debit_mandate_on_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW WHEN ((new."repaymentMethod" = 'DEBIT_ORDER'::"LoanRepaymentMethod")) EXECUTE FUNCTION "guardLoanApplicationDebitMandate"();
CREATE TRIGGER "LoanApplication_require_pasq_on_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationPasqApproval"();
CREATE TRIGGER "LoanApplication_require_provider_countersign_on_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationProviderCountersign"();
CREATE TRIGGER "LoanApplication_require_provider_signer_tenant_on_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationProviderSignerTenant"();
CREATE TRIGGER "LoanApplication_require_tenant_binding_on_insert" BEFORE INSERT ON "LoanApplication" FOR EACH ROW EXECUTE FUNCTION "guardLoanApplicationTenantBinding"();
CREATE TRIGGER "Message_internal_note_mutability_guard" BEFORE UPDATE ON "Message" FOR EACH ROW EXECUTE FUNCTION guard_note_mutability();
CREATE TRIGGER "Message_legacy_placeholder_guard" BEFORE INSERT OR UPDATE ON "Message" FOR EACH ROW EXECUTE FUNCTION guard_legacy_message_placeholder();
CREATE TRIGGER "Message_truthful_dry_run" BEFORE INSERT OR UPDATE ON "Message" FOR EACH ROW EXECUTE FUNCTION truthful_dry_run_message();
CREATE TRIGGER "NotificationLog_truthful_delivery_guard" BEFORE INSERT OR UPDATE OF status, "messageId", channel ON "NotificationLog" FOR EACH ROW EXECUTE FUNCTION guard_unlinked_notification_delivery();
CREATE CONSTRAINT TRIGGER "RepaymentSchedule_guard_pasq_v3_billing" AFTER INSERT OR DELETE OR UPDATE ON "RepaymentSchedule" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "guardRepaymentSchedulePasqV3Billing"();
CREATE CONSTRAINT TRIGGER "RepaymentSchedule_guard_pasq_v3_dates" AFTER INSERT OR DELETE OR UPDATE ON "RepaymentSchedule" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "guardRepaymentSchedulePasqV3Dates"();

-- ── Reference data ────────────────────────────────────────────────────────
-- A once-off proclaimed public holiday (Public Holidays Act s2A). Read by
-- "isSaBusinessDate"; it is national law, not any lender's data.
INSERT INTO "SaProclaimedPublicHoliday" ("date", "name", "sourceUrl") VALUES (
  DATE '2024-05-29',
  '2024 National and Provincial Government Elections',
  'https://www.gov.za/documents/notices/public-holidays-act-declaration-29-may-2024-public-holiday-23-feb-2024'
);
