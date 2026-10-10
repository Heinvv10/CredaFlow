import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { DeploymentConfigError, requireAppBaseUrl } from "@/lib/config/deployment-urls";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { isDemoMode } from "@/lib/config/demo-mode";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// metadataBase comes from the deployment's own URL; unset, it is omitted
// rather than invented (relative OG/canonical URLs then stay relative).
function deploymentOrigin(): URL | undefined {
  try {
    return new URL(requireAppBaseUrl());
  } catch (err) {
    if (err instanceof DeploymentConfigError) return undefined;
    throw err;
  }
}
const metadataBase = deploymentOrigin();

const metadata: Metadata = {
  ...(metadataBase ? { metadataBase } : {}),
  title: "Client and staff workspace",
  description: "Loan management workspace",
};

// Read per request: DEMO_MODE is runtime env, and the same image runs with and
// without it. Unset, this adds nothing to the metadata.
export function generateMetadata(): Metadata {
  return isDemoMode() ? { ...metadata, robots: { index: false, follow: false } } : metadata;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className="dark"
      data-theme="dark"
      {...(isDemoMode() ? { "data-demo-mode": "true" } : {})}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>
          <DemoBanner />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
