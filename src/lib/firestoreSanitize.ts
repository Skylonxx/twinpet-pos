type TierPriceLike = {
  minQty?: number;
  price?: number;
  tier?: string;
  id?: string;
};

/** Normalize tierPrices to a plain map — never undefined. Supports legacy array payloads. */
export function normalizeTierPricesField(value: unknown): Record<string, number> {
  if (value == null) return {};

  if (Array.isArray(value)) {
    const out: Record<string, number> = {};
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as TierPriceLike;
      const price = row.price ?? 0;
      if (!Number.isFinite(price) || price <= 0) continue;
      const key =
        typeof row.id === 'string' && row.id.trim()
          ? row.id.trim()
          : typeof row.tier === 'string' && row.tier.trim()
            ? row.tier.trim()
            : `qty_${row.minQty ?? 0}`;
      out[key] = price;
    }
    return out;
  }

  if (typeof value === 'object') {
    const out: Record<string, number> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const k = key.trim();
      const price = typeof val === 'number' ? val : Number(val);
      if (k && Number.isFinite(price) && price > 0) out[k] = price;
    }
    return out;
  }

  return {};
}

function isFirestoreSpecialValue(value: unknown): boolean {
  if (value == null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return true;
  if (typeof (value as { toDate?: unknown }).toDate === 'function') return true;
  if (typeof (value as { _methodName?: unknown })._methodName === 'string') return true;
  return false;
}

/** Remove undefined recursively; preserve null, Dates, Timestamps, and FieldValue sentinels. */
export function stripUndefinedDeep<T>(input: T): T {
  if (input === undefined) return undefined as T;
  if (input === null) return input;
  if (typeof input !== 'object') return input;
  if (isFirestoreSpecialValue(input)) return input;

  if (Array.isArray(input)) {
    return input
      .map((item) => stripUndefinedDeep(item))
      .filter((item) => item !== undefined) as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    if (val === undefined) continue;
    const cleaned = stripUndefinedDeep(val);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out as T;
}

/** Aggressive product-document sanitizer — call immediately before setDoc/updateDoc. */
export function sanitizeProductDocForFirestore(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const tierPrices = normalizeTierPricesField(data.tierPrices);

  const uomConversions = Array.isArray(data.uomConversions)
    ? data.uomConversions.map((row) => {
        const conv = row as Record<string, unknown>;
        const next: Record<string, unknown> = {
          unit: conv.unit ?? '',
          factor: conv.factor ?? 1,
        };
        if (conv.barcode != null && conv.barcode !== '') {
          next.barcode = conv.barcode;
        }
        const uomTierPrices = normalizeTierPricesField(conv.tierPrices);
        if (Object.keys(uomTierPrices).length > 0) {
          next.tierPrices = uomTierPrices;
        }
        return next;
      })
    : [];

  const doc: Record<string, unknown> = {
    ...data,
    uomConversions,
    prices: Array.isArray(data.prices) ? data.prices : [],
    tierPrices,
    barcode: data.barcode ?? null,
    sku: typeof data.sku === 'string' ? data.sku.trim() : '',
    imageUrl: data.imageUrl ?? null,
    deletedAt: data.deletedAt ?? null,
    description: data.description ?? '',
    reorderPoint: data.reorderPoint ?? 0,
    allowNegativeStock: data.allowNegativeStock ?? false,
    isActive: data.isActive ?? true,
  };

  return stripUndefinedDeep(doc) as Record<string, unknown>;
}
