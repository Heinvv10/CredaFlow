import type { TenantConfigData } from "@/lib/tenant"

type ThemeColours = Pick<TenantConfigData, "primaryColor" | "secondaryColor" | "darkColor">

const HEX = /^#[0-9a-f]{6}$/i

/**
 * Publishes a tenant's TenantConfig colours as the `--cf-tenant-*` variables
 * that app/globals.css derives the brand tokens from (light and dark mode).
 * Server-rendered, so the page never paints in the default palette first.
 * A value that is not `#rrggbb` is dropped and the default applies: the
 * colours are interpolated into a stylesheet, so nothing else may reach it.
 */
export function TenantThemeProvider({ config, children }: { config?: ThemeColours | null; children: React.ReactNode }) {
  const vars: Array<[string, string | undefined]> = [
    ["--cf-tenant-primary", config?.primaryColor],
    ["--cf-tenant-secondary", config?.secondaryColor],
    ["--cf-tenant-dark", config?.darkColor],
  ]
  const valid = vars.filter((v): v is [string, string] => typeof v[1] === "string" && HEX.test(v[1]))

  return (
    <>
      {valid.length > 0 && <style>{`:root{${valid.map(([k, v]) => `${k}:${v};`).join("")}}`}</style>}
      {children}
    </>
  )
}
