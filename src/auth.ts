import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from './domain.js';

export function sameSecret(a:string,b:string):boolean {
  const left=createHmac('sha256','patrick-comparison').update(a).digest(),right=createHmac('sha256','patrick-comparison').update(b).digest();
  return timingSafeEqual(left,right);
}
export function sessionToken(config:AppConfig):string {
  const payload=Buffer.from(JSON.stringify({ownerId:config.ownerId,expiresAt:Date.now()+7*86400000})).toString('base64url');
  return `${payload}.${createHmac('sha256',config.sessionSecret).update(payload).digest('base64url')}`;
}
export function validSession(token:string|undefined,config:AppConfig):boolean {
  if(!token||!config.sessionSecret)return false;
  const [payload,signature]=token.split('.');if(!payload||!signature)return false;
  if(!sameSecret(signature,createHmac('sha256',config.sessionSecret).update(payload).digest('base64url')))return false;
  try{const data=JSON.parse(Buffer.from(payload,'base64url').toString());return data.ownerId===config.ownerId&&data.expiresAt>Date.now();}catch{return false;}
}
