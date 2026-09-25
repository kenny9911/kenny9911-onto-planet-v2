/** Local deterministic preview adapter. It never writes to an ERP or inventory store. */
export function createMockErpAdapter(initialStock = {}) {
  const stock = new Map(Object.entries(initialStock));
  for (const [sku, available] of stock) {
    if (!sku || !Number.isSafeInteger(available) || available < 0) {
      throw new TypeError('stock must map nonempty SKUs to nonnegative safe integers');
    }
  }

  function lookupStock({ sku }) {
    if (typeof sku !== 'string' || !sku) throw new TypeError('sku is required');
    return { sku, available: stock.get(sku) ?? 0 };
  }

  function previewReserve({ sku, quantity }, idempotencyKey) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new TypeError('quantity must be a positive integer');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey) throw new TypeError('idempotencyKey is required');
    const { available } = lookupStock({ sku });
    return {
      operation: 'reserve', sku, quantity, idempotencyKey,
      availableBefore: available,
      canApply: quantity <= available,
      availableAfterIfApplied: quantity <= available ? available - quantity : available,
      approval: 'required',
    };
  }

  return { lookupStock, previewReserve };
}
