import type { Locale } from "./locales"
import { en } from "./messages/en"
import { af } from "./messages/af"
import { zu } from "./messages/zu"
import { xh } from "./messages/xh"

/**
 * The English catalogue is the source of truth: its key set and its
 * `{placeholder}` names define every other language. A translation file typed
 * `Catalog[...]` fails to compile on a missing or an extra key;
 * catalog.test.ts checks the same at runtime, plus the placeholders and tags.
 */
export type Messages = typeof en
export type Namespace = keyof Messages
export type Catalog = { readonly [N in Namespace]: { readonly [K in keyof Messages[N]]: string } }

export const CATALOGS: Record<Locale, Catalog> = { en, af, zu, xh }
