import type { IntentRecord, IntentStore } from "./types.js";

const keyOf = (tenantId: string, idempotencyKey: string): string => `${tenantId.length}:${tenantId}${idempotencyKey}`;
const copy = (record: IntentRecord): IntentRecord => structuredClone(record);

/** Test/development store. Production adapters must provide atomic persistence. */
export class InMemoryIntentStore implements IntentStore {
  private readonly records = new Map<string, IntentRecord>();

  async get(tenantId: string, idempotencyKey: string): Promise<IntentRecord | undefined> {
    const record = this.records.get(keyOf(tenantId, idempotencyKey));
    return record && copy(record);
  }

  async putIfAbsent(record: IntentRecord): Promise<IntentRecord> {
    const key = keyOf(record.intent.tenantId, record.intent.idempotencyKey);
    const existing = this.records.get(key);
    if (existing) return copy(existing);
    this.records.set(key, copy(record));
    return copy(record);
  }

  async compareAndSwap(record: IntentRecord, expectedVersion: number): Promise<boolean> {
    const key = keyOf(record.intent.tenantId, record.intent.idempotencyKey);
    const current = this.records.get(key);
    if (!current || current.version !== expectedVersion || record.version !== expectedVersion + 1) return false;
    this.records.set(key, copy(record));
    return true;
  }
}
