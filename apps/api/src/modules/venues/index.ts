import type { NexoraModule } from '../types';
import { venueRoutes } from './routes';

/** Venue administration & inventory (Epic E1): directory, settings, shifts, tables, menu, audit. */
export const venuesModule: NexoraModule = {
  name: 'venues',
  routes: venueRoutes,
};
