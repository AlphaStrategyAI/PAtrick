import { digest, stableId, roleSchemas, type WorkerInput, type WorkerResult } from './domain.js';
import type { Store } from './store.js';
import type { TestObservation } from './knowledge-contract.js';
import { takeHostTestRun } from './integrations/workers.js';
import { assertPlanBinding, assertArtifactBinding, assertReviewBinding } from './execution-contract.js';
import { knowledgePolicyHash } from './knowledge-identity.js';
import type { AcceptedLocalProvenance } from './knowledge-records.js';

/** Only a consumed, cleanup-confirmed adapter identity can reach canonical storage. */
export function recordLocalTests(store:Store,attemptId:string,input:WorkerInput,originalResult:WorkerResult,acceptedOutput:unknown):string|undefined {
 const run=takeHostTestRun(originalResult);
 if(!run)return undefined;
 return store.transaction(()=>{
  const task=store.get('tasks',input.task.id),source=store.get('sources',input.source.id),project=store.get('projects',input.project.id),attempt=store.get('attempts',attemptId);
  if(input.role!=='execute'&&input.role!=='check'||!task||!source||!project||!attempt)return undefined;
  const role=input.role,plan=input.plan??input.task.plan,latest=store.list('attempts').filter(a=>a.taskId===task.id&&a.taskVersion===task.version&&a.role===role).at(-1);
  if(task.version!==input.task.version||task.stage!==input.task.stage||task.stage!==role||['cancelled','delivered','archived'].includes(task.status)||task.billingStop||task.sourceId!==source.id||task.sourceRevision!==source.revision||source.status!=='active'||source.revision!==input.source.revision||digest(source)!==digest(input.source)||digest(project)!==digest(input.project)||project.id!==task.projectId||project.projectId!==task.projectId||project.domain!==task.domain||source.projectId!==task.projectId||source.domain!==task.domain||input.task.projectId!==task.projectId||input.task.domain!==task.domain||!plan||input.baselineSha!==undefined&&input.baselineSha!==plan.baselineSha||!task.plan||digest(task.plan)!==digest(plan)||attempt.status!=='succeeded'||latest?.id!==attemptId||attempt.taskId!==task.id||attempt.taskVersion!==task.version||attempt.role!==role||attempt.runner!==run.runner||attempt.projectId!==task.projectId||attempt.domain!==task.domain||attempt.provider!==originalResult.provider||attempt.model!==originalResult.model||attempt.inputHash!==digest(input)||run.inputHash!==attempt.inputHash)return undefined;
  let output:unknown,artifact:unknown;
  try{
   output=roleSchemas[role].parse(acceptedOutput);
   if(digest(output as object)!==run.outputHash||digest(roleSchemas[role].parse(originalResult.output))!==run.outputHash)return undefined;
   const context={...task,plan};assertPlanBinding(context,project);
   if(role==='execute')artifact=assertArtifactBinding(context,project,output);
   else{artifact=assertArtifactBinding(context,project,input.artifact??input.task.artifact);if(!task.artifact||digest(task.artifact)!==digest(artifact as object))return undefined;assertReviewBinding({...context,artifact:artifact as NonNullable<WorkerInput['artifact']>},output);}
  }catch{return undefined;}
  if(run.snapshot.revision!==plan.baselineSha||run.checks.length!==plan.tests.length||run.checks.some((check,i)=>check.command!==plan.tests[i]||check.id!==stableId('local-check',plan.tests[i])))return undefined;
  const origin:Extract<TestObservation['origin'],{kind:'local'}>={kind:'local',taskId:task.id,taskVersion:task.version,attemptId,inputHash:attempt.inputHash,planHash:digest(plan),artifactHash:digest(artifact as object),role,runId:run.runId};
  const observation:TestObservation={schemaVersion:1,id:'',projectId:task.projectId,domain:task.domain,sourceId:source.id,sourceRevision:source.revision,repository:project.repository,observedAt:run.observedAt,snapshot:run.snapshot,checks:run.checks,environment:run.environment,...(run.comparable?{comparable:run.comparable}:{}),origin};
  observation.id=stableId('local-test-observation',run.runId,digest(origin),digest(observation));
  const accepted:AcceptedLocalProvenance={attemptId,taskId:task.id,taskVersion:task.version,role,runner:attempt.runner,provider:attempt.provider,model:attempt.model,inputHash:attempt.inputHash,outputHash:run.outputHash,planHash:origin.planHash,artifactHash:origin.artifactHash,runId:run.runId,sourceHash:digest(source),policyHash:knowledgePolicyHash(project)};
  const prior=store.get('actions',observation.id),hash=digest(observation);
  if(prior)return prior.kind==='experience.test-observation'&&prior.payload.digest===hash?prior.id:undefined;
  if(store.list('actions').some(a=>a.kind==='experience.test-observation'&&(a.payload.observation as TestObservation|undefined)?.origin.kind==='local'&&((a.payload.observation as TestObservation).origin as typeof origin).runId===run.runId))return undefined;
  store.save('actions',{id:observation.id,projectId:task.projectId,domain:task.domain,taskId:task.id,kind:'experience.test-observation',status:'completed',payload:{schemaVersion:1,observation,digest:hash,accepted,acceptedDigest:digest(accepted),sourceRefs:[{id:source.id,revision:source.revision}]},updatedAt:run.observedAt});
  return observation.id;
 });
}
