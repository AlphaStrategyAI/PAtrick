import { z } from 'zod';
import { DomainError, digest, experienceDetailsSchema, pathAllowed, safeRelativePath, type Project, type SourceRevision } from './domain.js';
import type { ParsedStructuredKnowledge, RepositoryReadRequest } from './knowledge-contract.js';
import type { Store } from './store.js';

function invalid():never {throw new DomainError('Invalid structured knowledge envelope.','invalid_structured_knowledge',400);}
const text = z.string().min(1).refine(v=>Buffer.byteLength(v)<=10_000);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[1-9][0-9]*$/).max(32);
const path = text.refine(v=>{try{return Buffer.byteLength(v)<=1024&&safeRelativePath(v)===v;}catch{return false;}});
const reportPath = path.refine(v=>v.split('/').at(-1)==='patrick-test-observation-v1.json');
const check = z.object({runId:id,jobId:id,checkName:text}).strict();
const repositorySchema = z.object({schemaVersion:z.literal(1),kind:z.literal('repository-facts'),quote:text,repository:text,changeNumber:z.number().int().positive().safe().optional(),headSha:sha,checks:z.array(check).max(20),testReportPath:reportPath.optional()}).strict();
const experienceSchema = z.object({schemaVersion:z.literal(1),quote:text,details:experienceDetailsSchema,repository:text,headSha:sha,runId:id,jobId:id,checkIds:z.array(text).min(1).max(20),issueId:text.optional(),testReportPath:reportPath.optional()}).strict();
function bounded(value:unknown,depth=0):boolean {
  if(depth>20)return false;
  if(typeof value==='string')return Buffer.byteLength(value)<=10_000;
  if(Array.isArray(value))return value.length<=128&&value.every(v=>bounded(v,depth+1));
  return value===null||typeof value!=='object'||Object.entries(value).every(([k,v])=>Buffer.byteLength(k)<=10_000&&bounded(v,depth+1));
}
/** JSON syntax plus duplicate-key rejection; shared low-level decoder, not a second envelope parser. */
export function parseKnowledgeJson(content:string):unknown {
  const value:unknown=JSON.parse(content),stack:(Set<string>|null)[]=[];
  for(let i=0;i<content.length;i++){
    const c=content[i];if(c==='{')stack.push(new Set());else if(c==='[')stack.push(null);else if(c==='}'||c===']')stack.pop();
    else if(c==='"'){const start=i;for(i++;i<content.length;i++){if(content[i]==='\\'){i++;continue;}if(content[i]==='"')break;}
      let next=i+1;while(/\s/.test(content[next]??'')&&next<content.length)next++;
      const keys=stack.at(-1);if(content[next]===':'&&keys){const key=JSON.parse(content.slice(start,i+1)) as string;if(keys.has(key))invalid();keys.add(key);}
    }
  }
  return value;
}
export function parseStructuredKnowledge(source:SourceRevision,project:Project):ParsedStructuredKnowledge|undefined {
  let value:unknown;
  try{value=parseKnowledgeJson(source.content);}catch{if(/^\s*\{[\s\S]*"(?:schemaVersion|repository-facts|details)"/.test(source.content))invalid();return undefined;}
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  const v=value as Record<string,unknown>;
  if(!('schemaVersion' in v)&&v.kind!=='repository-facts'&&!('details' in v))return undefined;
  if(source.status!=='active'||source.projectId!==project.id||project.projectId!==project.id||source.domain!==project.domain||!bounded(value))invalid();
  const result=(v.kind==='repository-facts'?repositorySchema:experienceSchema).safeParse(value);
  if(!result.success)invalid();
  const input=result.data;
  if(input.repository!==project.repository||!source.content.includes(input.quote))invalid();
  const checks='checks' in input?input.checks:input.checkIds.map(checkName=>({runId:input.runId,jobId:input.jobId,checkName}));
  if(new Set(checks.map(c=>c.checkName)).size!==checks.length||checks.some(c=>!project.trustedChecks.includes(c.checkName)))invalid();
  if(input.testReportPath&&!pathAllowed(input.testReportPath,project.allowedPaths))invalid();
  if('details' in input&&input.details.files.some(p=>Buffer.byteLength(p)>1024||!pathAllowed(p,project.allowedPaths)))invalid();
  return 'details' in input?{kind:'experience',input}:{kind:'repository-facts',input};
}

/** Shared by request construction and the concrete reader; no I/O and no authority save. */
export function assertKnowledgeSource(store:Store,source:SourceRevision,project:Project):void {
  const current=store.get('sources',source.id),policy=store.get('projects',project.id);
  if(!current||current.status!=='active'||current.projectId!==project.id||current.domain!==project.domain||digest(current)!==digest(source))throw new DomainError('Knowledge source changed.','stale_source',409);
  if(!policy||project.projectId!==project.id||digest(policy)!==digest(project))throw new DomainError('Knowledge authorization changed.','scope',403);
  const visiting=new Set<string>(),validated=new Set<string>();
  const active=(s:SourceRevision):boolean=>{
    if(visiting.has(s.id))return false;if(validated.has(s.id))return true;visiting.add(s.id);
    const valid=(s.parentSources??[]).every(ref=>{const p=store.get('sources',ref.id);return !!p&&p.status==='active'&&p.revision===ref.revision&&p.projectId===project.id&&p.domain===project.domain&&active(p);});
    visiting.delete(s.id);if(valid)validated.add(s.id);return valid;
  };
  if(!active(current))throw new DomainError('Knowledge source lineage changed.','stale_source',409);
}
export function structuredRepositoryRequest(store:Store,source:SourceRevision,project:Project,parsed:ParsedStructuredKnowledge):RepositoryReadRequest {
  assertKnowledgeSource(store,source,project);
  const actual=parseStructuredKnowledge(source,project);
  if(!actual||digest(actual)!==digest(parsed))invalid();
  const input=actual.input;
  const request:RepositoryReadRequest={repository:project.repository,headSha:input.headSha,checks:actual.kind==='repository-facts'?actual.input.checks:actual.input.checkIds.map(checkName=>({runId:actual.input.runId,jobId:actual.input.jobId,checkName})),filePaths:actual.kind==='experience'?[...actual.input.details.files]:[]};
  if(actual.kind==='repository-facts'&&actual.input.changeNumber!==undefined)request.changeNumber=actual.input.changeNumber;
  if(input.testReportPath)request.testReportPath=input.testReportPath;
  if(actual.kind==='experience'&&actual.input.issueId){const issue=store.get('sources',actual.input.issueId);if(issue){try{assertKnowledgeSource(store,issue,project);request.issueSource={id:issue.id,revision:issue.revision};}catch{/* Relevance remains pending. */}}}
  return request;
}
