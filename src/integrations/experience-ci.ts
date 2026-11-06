import { DomainError, type Project, type SourceRevision } from '../domain.js';
import type { RepositoryReadback, StructuredExperienceInput } from '../knowledge-contract.js';
import { ingestStructuredKnowledge } from '../knowledge.js';
import { knowledgeRequestSourceRefs } from '../knowledge-records.js';
import { parseStructuredKnowledge, structuredRepositoryRequest } from '../structured-knowledge.js';
import type { Store } from '../store.js';
import type { RepositoryKnowledgeReader } from './repository-knowledge.js';

export function parseStructuredExperience(source:SourceRevision,project:Project):StructuredExperienceInput|undefined {
 const parsed=parseStructuredKnowledge(source,project);return parsed?.kind==='experience'?parsed.input:undefined;
}
export async function readExperienceCi(reader:RepositoryKnowledgeReader,store:Store,project:Project,source:SourceRevision,input:StructuredExperienceInput,signal:AbortSignal):Promise<RepositoryReadback> {
 const request=structuredRepositoryRequest(store,source,project,{kind:'experience',input});
 if(!knowledgeRequestSourceRefs(store,source.id,project,request))throw new DomainError('Knowledge dependencies are unavailable.','stale_source',409);
 return reader.read(project,source,request,signal);
}
export async function ingestStructuredExperience(store:Store,reader:RepositoryKnowledgeReader|undefined,sourceId:string,signal:AbortSignal):Promise<boolean> {
 return await ingestStructuredKnowledge(store,reader,sourceId,signal)==='processed';
}
