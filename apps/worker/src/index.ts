import { randomUUID } from 'node:crypto';
import type { JobRecord } from '../../../packages/platform-contracts/src/index.js';
import type { PlatformRuntime } from '../../../packages/platform-runtime/src/index.js';
export interface WorkerQueue {
  claimJob(workerId: string, leaseMs?: number): Promise<JobRecord | undefined>;
  heartbeatJob(id: string, leaseToken: string): Promise<unknown>;
  completeJob(id: string, leaseToken: string, error?: string): Promise<unknown>;
  heartbeatWorker?(workerId: string): Promise<unknown>;
}
export async function runWorker(options: { runtime: Pick<PlatformRuntime, 'handleJob'>; queue: WorkerQueue; workerId?: string; signal?: AbortSignal; pollMs?: number; leaseMs?: number }): Promise<void> {
  const id = options.workerId ?? `worker-${randomUUID()}`, leaseMs = options.leaseMs ?? 120000;
  while (!options.signal?.aborted) {
    await options.queue.heartbeatWorker?.(id);
    const job = await options.queue.claimJob(id, leaseMs);
    if (!job) { await delay(options.pollMs ?? 500, options.signal); continue; }
    if (!job.leaseToken) throw new Error('Leased job has no lease token');
    let leaseFailed = false;
    let pendingHeartbeat: Promise<void> | undefined;
    const heartbeat = setInterval(() => {
      if (pendingHeartbeat) return;
      pendingHeartbeat = options.queue.heartbeatJob(job.id, job.leaseToken!)
        .then(() => {}, () => { leaseFailed = true; })
        .finally(() => { pendingHeartbeat = undefined; });
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    const stopHeartbeat = async () => { clearInterval(heartbeat); await pendingHeartbeat; };
    try {
      await options.runtime.handleJob(job);
      await stopHeartbeat();
      if (!leaseFailed) await options.queue.completeJob(job.id, job.leaseToken);
    } catch (error) {
      await stopHeartbeat();
      if (!leaseFailed) await options.queue.completeJob(job.id, job.leaseToken, error instanceof Error ? error.message : 'Worker job failed');
    } finally { await stopHeartbeat(); }
  }
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => { const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true }); if (signal?.aborted) finish(); });
}
