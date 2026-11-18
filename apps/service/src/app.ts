export { createApp, createServiceRuntime, createAuthenticatedConsultationMcp, ServiceStartupError, type CreateAppOptions, type ServiceDrainResult, type ServiceCleanup } from './factory.js';
import { createApp } from './factory.js';

export const app = createApp();
