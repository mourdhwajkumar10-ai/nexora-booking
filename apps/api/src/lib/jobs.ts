/** Minimal in-process interval scheduler for background workers (triage, no-show, dwell, outbox, webhooks). */
export interface Job {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
}

const jobs = new Map<string, Job>();
const timers: NodeJS.Timeout[] = [];

export function registerJob(job: Job): void {
  jobs.set(job.name, job);
}

/** Run a job once (used by tests and by the scheduler). */
export async function runJob(name: string): Promise<void> {
  const job = jobs.get(name);
  if (!job) throw new Error(`Unknown job ${name}`);
  await job.run();
}

export function listJobs(): string[] {
  return [...jobs.keys()];
}

export function startJobs(log: { info: (m: string) => void; error: (o: unknown, m: string) => void }): void {
  for (const job of jobs.values()) {
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await job.run();
      } catch (err) {
        log.error(err, `[job:${job.name}] failed`);
      } finally {
        running = false;
      }
    }, job.intervalMs);
    t.unref();
    timers.push(t);
    log.info(`[jobs] started ${job.name} every ${job.intervalMs}ms`);
  }
}

export function stopJobs(): void {
  timers.splice(0).forEach(clearInterval);
}
