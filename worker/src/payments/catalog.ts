// Server-side credit packs. Prices and credit counts live here and in
// wrangler vars; webhook metadata and clients are never trusted for them.
// Launch offer: $5 = 10 credits, $19 = 50 credits. A belief costs 2 credits,
// a shield 1 (BELIEF_CREDIT_COST / SHIELD_CREDIT_COST in the Worker).
export interface Pack { key: 'small' | 'large'; productId: string; credits: number; amountMinor: number }
export interface CatalogEnv { DODO_PRODUCT_ID?: string; DODO_PRODUCT_ID_LARGE?: string }

export const PACK_SMALL = { credits: 10, amountMinor: 500 } as const;
export const PACK_LARGE = { credits: 50, amountMinor: 1900 } as const;

export function packs(env: CatalogEnv): Pack[] {
  const out: Pack[] = [];
  if (env.DODO_PRODUCT_ID) out.push({ key: 'small', productId: env.DODO_PRODUCT_ID, ...PACK_SMALL });
  if (env.DODO_PRODUCT_ID_LARGE && env.DODO_PRODUCT_ID_LARGE !== env.DODO_PRODUCT_ID) out.push({ key: 'large', productId: env.DODO_PRODUCT_ID_LARGE, ...PACK_LARGE });
  return out;
}
export const packByProduct = (env: CatalogEnv, productId: string) => packs(env).find(p => p.productId === productId) ?? null;
export const packByKey = (env: CatalogEnv, key: unknown) => packs(env).find(p => p.key === (key === 'large' ? 'large' : 'small')) ?? null;
