import type { AppConfig } from './domain.js';
export function canExport(config:AppConfig,domain:string,channel:'research'|'feishu'):boolean {
  const policy=config.egressPolicies?.find(p=>p.domain===domain);
  return policy?policy[channel]===true:domain==='personal';
}
