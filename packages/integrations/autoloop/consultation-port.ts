import type { SqliteDatabase } from '@patrick/storage';
import type { ConsultationHubPort } from '../../domain/src/consultations.js';
import { publishHubEvent, type HubPublisher } from './client.js';

export function createConsultationHubPort(db: SqliteDatabase, hub: HubPublisher): ConsultationHubPort {
  return {
    publish(event, now) {
      return publishHubEvent(db, hub, event, now);
    },
  };
}
