# Commercial sample render proof

Rendered 2026-10-17 with scripts/asset-finance/render-legal-wording-deal-samples.ts.
No consumer NCA document hash pins changed.

| Sample | SHA-256 |
|---|---|
| instalment-sale-agreement-cpa.pdf | 57399402d2840a61b3f26adcc9fa9f1c6cfe43f05c7d7588e2a4b1b5bd8935e7 |
| suretyship.pdf | 7539ba1d35950375d06c30929f14001d73f39c17f2717708eac4342d3691516d |
| suretyship-nca-principal.pdf | 0a078110cf21bd4b25ffa0d89147ce8710c9531fbd5868b27c67f758cef5f672 |

Text extraction with pdftotext confirms:

- The CPA variant prints "CPA NOTICE — READ BEFORE SIGNING" and "NOTICE UNDER SECTION 49".
- The suretyship prints "Physical address (domicilium)" and "3 Test Surety Road, Testville, 0003"; its domicilium clause repeats that address.
- Both suretyship variants retain the DRAFT watermark.
