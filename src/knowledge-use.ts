import type { KnowledgeCard, Scope } from './domain.js';
import type { KnowledgeReferenceOptions, KnowledgeView } from './knowledge-contract.js';
import { experienceReference } from './experience.js';
import type { Store } from './store.js';

const cardFields=new Set(['id','projectId','domain','sourceId','sourceRevision','title','body','quote','locator','kind','verification','status','aliases','createdAt','expiresAt','experience','claim','pendingClaim']);
/** Strip copied view/authority fields; the host recomposes every displayed view. */
export function stripDerivedCardFields(card:object):void {for(const field of Object.keys(card))if(!cardFields.has(field))Reflect.deleteProperty(card,field);}

/** A derived view only: never persisted or used as extraction input. */
export function knowledgeReference(store:Store,card:KnowledgeCard,scope:Scope,options:KnowledgeReferenceOptions={}):KnowledgeView|undefined {return store.readSnapshot(()=>{const current=store.get('cards',card.id);return current?knowledgeReferenceBody(store,current,scope,options):undefined;});}
function knowledgeReferenceBody(store:Store,card:KnowledgeCard,scope:Scope,options:KnowledgeReferenceOptions):KnowledgeView|undefined {
 if(card.projectId!==scope.projectId||card.domain!==scope.domain)return undefined;
 const base={...card};stripDerivedCardFields(base);
 const source=store.get('sources',card.sourceId),active=card.status==='active'&&(!card.expiresAt||Date.parse(card.expiresAt)>Date.now())&&source?.status==='active'&&source.revision===card.sourceRevision&&source.projectId===scope.projectId&&source.domain===scope.domain;
 if(!active)return options.usage==='browse'&&card.status==='withdrawn'?base:undefined;
 const reportedStatement={text:card.body,status:card.verification==='inference'?'inference' as const:'reported' as const};
 if(card.kind!=='experience')return {...base,reportedStatement};
 const gate=experienceReference(store,card,scope,options.current);
 if(gate.eligible)return {...base,reportedStatement,experienceReference:gate.reference};
 return options.usage==='browse'?{...base,reportedStatement,experienceState:{state:gate.state,reason:gate.reason}}:undefined;
}
