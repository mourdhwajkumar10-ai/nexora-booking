import { buildApp } from './app';
import { config } from './config';
import { initRealtime } from './lib/realtime';
import { startJobs } from './lib/jobs';

const app = await buildApp({ logger: true });
initRealtime(app);
await app.listen({ port: config.port, host: '0.0.0.0' });
if (config.workersEnabled) startJobs(app.log);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await app.close();
    process.exit(0);
  });
}
