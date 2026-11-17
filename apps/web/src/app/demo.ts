/** The demo is opt-in via Vite mode. Never fall back to it on a failed HTTP request. */
export const isDemo = import.meta.env.MODE === 'demo';

export const demoScope = { account_id: 'patrick-demo', data_domain: 'demo', permission_epoch: 0 };
export const demoDrafts = 'patrick-demo';
export const demoWork = { id: 'DEMO-017', title: 'demo.workTitle', state: 'demo.workState' } as const;
