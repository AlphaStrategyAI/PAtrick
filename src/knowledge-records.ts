import { digest, stableId, type Scope } from './domain.js';
import type { Store } from './store.js';
import type { TestObservation } from './knowledge-contract.js';
import { knowledgePolicyHash } from './knowledge-identity.js';

export interface AcceptedLocalProvenance {
 attemptId:string;taskId:string;taskVersion:number;role:'execute'|'check';runner:string;provider:string;model:string;
 inputHash:string;outputHash:string;planHash:string;artifactHash:string;runId:string;sourceHash:string;policyHash:string;
}

/** Read retained accepted facts, independently of the task's later workflow. */
export function readTestObservation(store:Store,id:string,scope:Scope):TestObservation|undefined {
 const row=store.get('actions',id);
 if(!row||row.kind!=='experience.test-observation'||row.status!=='completed'||row.projectId!==scope.projectId||row.domain!==scope.domain)return undefined;
 const p=row.payload,o=p.observation as TestObservation|undefined,a=p.accepted as AcceptedLocalProvenance|undefined;
 if(p.schemaVersion!==1||!o||!a||o.schemaVersion!==1||o.id!==id||o.projectId!==scope.projectId||o.domain!==scope.domain||o.origin.kind!=='local'||p.digest!==digest(o)||p.acceptedDigest!==digest(a)||id!==stableId('local-test-observation',a.runId,digest(o.origin),digest({...o,id:''})))return undefined;
 const origin=o.origin;
 if(origin.attemptId!==a.attemptId||origin.taskId!==a.taskId||origin.taskVersion!==a.taskVersion||origin.inputHash!==a.inputHash||origin.planHash!==a.planHash||origin.artifactHash!==a.artifactHash||origin.runId!==a.runId||origin.role!==a.role)return undefined;
 const attempt=store.get('attempts',a.attemptId),source=store.get('sources',o.sourceId),project=store.get('projects',scope.projectId);
 if(!attempt||attempt.status!=='succeeded'||attempt.projectId!==scope.projectId||attempt.domain!==scope.domain||attempt.taskId!==a.taskId||attempt.taskVersion!==a.taskVersion||attempt.role!==a.role||attempt.runner!==a.runner||attempt.provider!==a.provider||attempt.model!==a.model||attempt.inputHash!==a.inputHash||!source||source.status!=='active'||source.revision!==o.sourceRevision||source.projectId!==scope.projectId||source.domain!==scope.domain||digest(source)!==a.sourceHash||!project||project.projectId!==scope.projectId||project.domain!==scope.domain||project.repository!==o.repository||knowledgePolicyHash(project)!==a.policyHash)return undefined;
 if(JSON.stringify(p.sourceRefs)!==JSON.stringify([{id:source.id,revision:source.revision}]))return undefined;
 return structuredClone(o);
}
