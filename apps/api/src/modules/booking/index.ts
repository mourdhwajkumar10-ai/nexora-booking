import { registerJob } from '../../lib/jobs';
import type { NexoraModule } from '../types';
import { bookingRoutes } from './routes';
import { runGraceNoShow, runNotificationOutbox, runTriageEscalation } from './workers';

/** Booking engine (A2): availability, transactional allocation, reservation lifecycle, workers. */
export const bookingModule: NexoraModule = {
  name: 'booking',
  routes: bookingRoutes,
  init() {
    registerJob({ name: 'triage-escalation', intervalMs: 15_000, run: runTriageEscalation });
    registerJob({ name: 'grace-no-show', intervalMs: 30_000, run: runGraceNoShow });
    registerJob({ name: 'notification-outbox', intervalMs: 2_000, run: runNotificationOutbox });
  },
};
