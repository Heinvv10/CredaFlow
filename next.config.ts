import type { NextConfig } from "next";
// Relative, not the "@/" alias: this file is loaded by Next's own config
// loader before the tsconfig path aliases are in effect.
//
// This works because quickquote-config.ts has NO imports of its own. Adding
// one to that module — `server-only`, `@/lib/prisma`, anything via the alias —
// breaks config load, which takes out `next build`, `next start` and
// `next lint` together, with an error pointing here rather than at the edit
// that caused it. The module carries a matching warning.
import { quickQuoteFrameAncestors } from "./lib/insurance/quickquote-config";

// The selfie routes run the face comparison (lib/kyc/face-model/). The trace
// finds onnxruntime-node's binding but not the library it links at load
// (libonnxruntime.so.1), and it finds the model files only by accident of
// the loader's path. Both are listed so the standalone image cannot ship
// without them; the Dockerfile fetches the models before `next build`. The
// binding is traced for the build host's platform, so the library is too.
// face-models/ also holds the licence texts and NOTICE that ship with them.
const faceComparisonFiles = [
  `./node_modules/onnxruntime-node/bin/napi-v6/${process.platform}/${process.arch}/libonnxruntime.so.1`,
  "./face-models/*",
]

const nextConfig: NextConfig = {
  output: "standalone",
  // Next 16.4's `next dev` appends its own block to AGENTS.md when it detects
  // an AI agent. AGENTS.md is a generated mirror of CLAUDE.md, so that block
  // fails `npm run agents:check`.
  agentRules: false,
  outputFileTracingIncludes: {
    "/api/documents/selfie": faceComparisonFiles,
    "/api/selfie-link/**": faceComparisonFiles,
  },
  experimental: {
    serverActions: {
      // Next caps Server Action bodies at 1MB by default and aborts the
      // multipart stream BEFORE the action runs — so an oversized upload never
      // reaches our own size check and surfaces as an opaque framework error.
      // The bank-statement upload shares the 5MB ceiling its sibling worker
      // endpoint already enforces (lib/bank-sync/import.ts MAX_STATEMENT_BYTES);
      // a full-year ABSA CSV export can approach 1MB, so the default is a real
      // ceiling, not a theoretical one. Keep these two numbers equal.
      bodySizeLimit: "5mb",
    },
  },
  images: {
    // Serve modern WebP (smaller than PNG/JPEG). AVIF is intentionally omitted:
    // its cold-start encode is far slower and would hurt first-paint LCP on the
    // marketing heroes, which is the metric we're optimising for.
    formats: ["image/webp"],
    // Next.js 16 defaults images.qualities to [75] and coerces any other
    // `quality` prop to the nearest allowed value. Hero images behind a dark
    // overlay can be encoded at 55 — that value must be allow-listed here or
    // it silently snaps back to 75.
    qualities: [55, 75],
    // Optimised variants are immutable per source; cache them for a year so a
    // container restart / fresh crawler doesn't pay the transcode cost again.
    minimumCacheTTL: 31536000,
  },
  async headers() {
    return [
      {
        // The QuickQuote host is deliberately chrome-less and auto-sizes itself
        // to whatever frames it, which makes it a ready-made component for a
        // phishing page collecting SA ID numbers under the lender's own domain.
        // Restrict framing to our own marketing origins.
        //
        // Matches /quote AND any sub-route: the proxy admits /quote/* too, so
        // an exact-path rule would ship the first sub-route added with no
        // frame-ancestors at all.
        //
        // Built from the same module the insurance page gates on, so "where
        // the panel renders" and "who may frame it" stay aligned on host,
        // including the loopback origins added outside production.
        //
        // It spans prod and staging because one image serves both; that means
        // the staging marketing origin may frame the prod quote host. Both are
        // ours, and the page behind it holds no data of ours — but if that
        // stops being true, split this by environment.
        //
        // NOTE: a script-src/connect-src policy for this host is the control
        // that would actually bound a compromised FSP bundle. It is not set
        // here because FSP loads from several hosts (fspsolutions.com,
        // ajax.aspnetcdn.com, google-analytics.com) and their jQuery 1.9.1 +
        // knockout stack may need unsafe-eval — guessing wrong breaks the
        // widget silently. It needs verifying in a browser against live
        // credentials before it can be enforced.
        source: "/quote/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `frame-ancestors 'self' ${quickQuoteFrameAncestors().join(" ")}`,
          },
        ],
      },
    ]
  },
  async redirects() {
    return [
      { source: "/site/insurance", destination: "/site/products/insurance", permanent: true },
      // The "Cover" product was renamed to "Insurance" (2026-06-12). Preserve
      // inbound links, bookmarks and search equity from the old product URL.
      { source: "/site/products/cover", destination: "/site/products/insurance", permanent: true },
    ];
  },
};

export default nextConfig;
