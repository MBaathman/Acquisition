import { newId } from "./ids.js";

/**
 * Background job queue port. The engine never runs work inline from a user
 * request; it enqueues jobs (campaign ticks, action executions, retries,
 * follow-ups) that workers pick up. The in-memory queue drives tests/demos; a
 * durable queue (pg-boss, BullMQ, Temporal, SQS...) implements the same port.
 */
export interface Job {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  runAt: number; // epoch ms
  dedupeKey?: string;
}

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

export interface JobQueue {
  register(type: string, handler: JobHandler): void;
  enqueue(type: string, payload: Record<string, unknown>, opts?: { runAt?: Date; dedupeKey?: string }): Promise<void>;
}

export class InMemoryQueue implements JobQueue {
  private jobs: Job[] = [];
  private handlers = new Map<string, JobHandler>();
  readonly failures: { job: Job; error: unknown }[] = [];

  constructor(private readonly now: () => Date) {}

  register(type: string, handler: JobHandler) {
    this.handlers.set(type, handler);
  }

  async enqueue(type: string, payload: Record<string, unknown>, opts: { runAt?: Date; dedupeKey?: string } = {}) {
    if (opts.dedupeKey && this.jobs.some((j) => j.dedupeKey === opts.dedupeKey)) return;
    this.jobs.push({ id: newId("job"), type, payload, runAt: (opts.runAt ?? this.now()).getTime(), dedupeKey: opts.dedupeKey });
  }

  pending(): readonly Job[] {
    return this.jobs;
  }

  /** Run every job due at the current clock time, including jobs enqueued while running. */
  async runDue(maxJobs = 10_000): Promise<number> {
    let ran = 0;
    for (;;) {
      const now = this.now().getTime();
      this.jobs.sort((a, b) => a.runAt - b.runAt);
      const idx = this.jobs.findIndex((j) => j.runAt <= now);
      if (idx === -1) return ran;
      const [job] = this.jobs.splice(idx, 1);
      if (!job) return ran;
      const handler = this.handlers.get(job.type);
      if (!handler) throw new Error(`no handler registered for job type '${job.type}'`);
      try {
        await handler(job.payload);
      } catch (error) {
        this.failures.push({ job, error });
      }
      if (++ran >= maxJobs) throw new Error(`runDue exceeded ${maxJobs} jobs — possible loop`);
    }
  }
}
