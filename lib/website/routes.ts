/**
 * The public website's pages:
 * only those that serve a kept module. sitemap.ts, robots.ts and llms.txt
 * read this list, so the three cannot drift from each other or from the pages
 * (lib/website/routes.test.ts checks each route has a page).
 *
 * /site/products/insurance/quotes is left out on purpose: it renders only on
 * a deployment with the QuickQuote embed configured.
 */
export const PUBLIC_SITE_ROUTES = [
  "/",
  "/site/apply",
  "/site/qualify",
  "/site/calculators",
  "/site/contact",
  "/site/products/insurance",
  "/site/privacy",
  "/site/terms",
  "/site/regulatory-information",
] as const

/** Pages the inherited site had and this one deleted; nothing may serve or advertise them. */
export const DELETED_SITE_ROUTES = [
  "/site",
  "/site/about",
  "/site/how-it-works",
  "/site/pricing",
  "/site/faq",
  "/site/products",
  "/site/products/capital",
  "/site/products/invoice-discounting",
  "/site/products/purchase-order-funding",
  "/site/products/credit",
  "/site/products/personal-loans",
  "/site/products/short-term-loans",
  "/blog",
] as const
