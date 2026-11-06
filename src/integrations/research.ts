import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { z } from 'zod';
import { DomainError, now, type AppConfig, type Project, type ResearchAdapter, type ResearchRecord, type ResearchSource } from '../domain.js';
import { canExport } from '../permissions.js';

function privateAddress(host:string):boolean {
  const h=host.toLowerCase().replace(/^\[|\]$/g,'');
  return h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||h.endsWith('.internal')||h==='::'||h==='::1'||h.startsWith('fe80:')||h.startsWith('fc')&&isIP(h)===6||h.startsWith('fd')&&isIP(h)===6||h.startsWith('::ffff:')||/^(0|10|127)\./.test(h)||/^169\.254\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h)||/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)||/^(22[4-9]|23\d|24\d|25[0-5])\./.test(h);
}
export function safeResearchUrl(value:string):URL {
  let url:URL;try{url=new URL(value);}catch{throw new DomainError('Invalid research URL.','research_url');}
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||privateAddress(url.hostname))throw new DomainError('Research originals must use a public HTTPS URL.','research_url',403);
  return url;
}
export function validateResearch(record:ResearchRecord):void {
  if (!['zh','en'].every(language=>record.queries.some(q=>q.language===language&&q.query.trim()&&q.searchedAt))) throw new DomainError('Both Chinese and English searches must run before asking.','evidence_missing',409);
  const sources=record.queries.flatMap(q=>q.sources).filter(s=>s.primary&&s.excerpt.trim()&&s.accessedAt);
  const originals=new Set(sources.map(s=>safeResearchUrl(s.canonicalUrl).href.replace(/\/$/,'')));
  if(originals.size<2)throw new DomainError('Two independent original sources are still needed.','evidence_missing',409);
}
const resultSchema=z.object({results:z.array(z.object({url:z.string().url(),title:z.string().min(1),publishedAt:z.string().min(1),primary:z.boolean(),canonicalUrl:z.string().url(),conditions:z.string() })).max(10),summary:z.string().optional()});

export function pinnedOriginal(url:URL,addresses:LookupAddress[]):Promise<{status:number;location?:string;text:string}> {
  if(!addresses.length||addresses.some(address=>privateAddress(address.address)))throw new DomainError('Original source address is not public.','research_url',403);
  return new Promise((resolve,reject)=>{
    // DNS is supplied to the actual TLS connection; no second hostname lookup can change the destination.
    const pinnedLookup:LookupFunction=((_host:any,options:any,callback:any)=>options?.all?callback(null,addresses):callback(null,addresses[0]!.address,addresses[0]!.family)) as LookupFunction;
    const req=request(url,{method:'GET',agent:false,lookup:pinnedLookup,timeout:15000,headers:{Accept:'text/html,text/plain,application/json','User-Agent':'PAtrick/0.1 EvidenceReader'}},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>1_000_000){req.destroy();reject(new DomainError('Original evidence exceeds the reading limit.','evidence_unavailable',503));}else chunks.push(chunk);});
      response.on('end',()=>resolve({status:response.statusCode??0,location:response.headers.location,text:Buffer.concat(chunks).toString('utf8')}));
      response.on('error',()=>reject(new DomainError('Original evidence connection interrupted.','evidence_unavailable',503)));
    });
    req.on('timeout',()=>req.destroy());req.on('error',()=>reject(new DomainError('Original evidence could not be opened.','evidence_unavailable',503)));req.end();
  });
}

/** Search gateway contract: POST {query,language,projectId,domain}; originals are fetched independently. */
export class BilingualResearch implements ResearchAdapter {
  constructor(private config:AppConfig,private fetcher:typeof fetch=fetch,private resolveHost:typeof lookup=lookup) {}
  private async original(value:string):Promise<{url:string;text:string}> {
    let url=safeResearchUrl(value);
    for(let redirect=0;redirect<4;redirect++) {
      const addresses=await this.resolveHost(url.hostname,{all:true});
      if(!addresses.length||addresses.some(a=>privateAddress(a.address)))throw new DomainError('Original source resolves to a private address.','research_url',403);
      const response=await pinnedOriginal(url,addresses);
      if(response.status>=300&&response.status<400){url=safeResearchUrl(new URL(response.location??'',url).href);continue;}
      if(response.status<200||response.status>=300)throw new DomainError('Original evidence is unavailable.','evidence_unavailable',503);
      const body=response.text;
      const text=body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
      if(text.length<40)throw new DomainError('Original source does not contain enough readable evidence.','evidence_missing',409);
      return {url:url.href,text};
    }
    throw new DomainError('Too many source redirects.','research_url',403);
  }
  async research(question:string,project:Project):Promise<ResearchRecord> {
    if(!canExport(this.config,project.domain,'research'))throw new DomainError('This data domain is not authorized to use the configured search gateway.','egress_denied',403);
    if(!this.config.researchUrl)throw new DomainError('Configure PATRICK_RESEARCH_URL for bilingual primary-source research.','research_unready',409);
    const gateway=new URL(this.config.researchUrl);
    if(gateway.protocol!=='https:'&&!(gateway.protocol==='http:'&&['localhost','127.0.0.1','::1','[::1]'].includes(gateway.hostname)))throw new DomainError('Research gateway must use HTTPS or local loopback.','research_unready',409);
    const record:ResearchRecord={queries:[],summary:'',gaps:[]};
    for(const language of ['zh','en'] as const) {
      const variants=language==='zh'?[`${question} 一手资料 适用条件`,`${question} 反例 失败案例`,`${question} 官方 实践`]:[`${question} primary source tradeoffs`,`${question} failure counterexample`,`${question} official guidance`];
      let found=0;
      for(const query of variants) {
        const response=await this.fetcher(gateway,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(this.config.researchToken?{Authorization:`Bearer ${this.config.researchToken}`}:{})},body:JSON.stringify({query,language,projectId:project.id,domain:project.domain}),signal:AbortSignal.timeout(20000)});
        if(!response.ok)throw new DomainError(`Research gateway returned ${response.status}.`,'research_unavailable',503);
        const result=resultSchema.parse(await response.json()),sources:ResearchSource[]=[];
        for(const candidate of result.results.slice(0,5)) {
          if(!candidate.primary)continue;
          try {
            safeResearchUrl(candidate.canonicalUrl);const original=await this.original(candidate.url);
            // Translations and mirrors are not independent originals; verify the canonical page itself.
            const canonical=new URL(candidate.canonicalUrl).href===new URL(original.url).href?original:await this.original(candidate.canonicalUrl);
            sources.push({...candidate,url:original.url,canonicalUrl:canonical.url,language,accessedAt:now(),excerpt:canonical.text.slice(0,7000)});
          } catch {record.gaps.push(`Could not verify original: ${candidate.url}`);}
        }
        record.queries.push({language,query,searchedAt:now(),sources});found+=sources.length;
        if(result.summary)record.summary+=(record.summary?'\n':'')+result.summary;
        if(found>=2)break;
      }
      if(!found)record.gaps.push(`No reliable ${language} primary source was found after three searches.`);
    }
    validateResearch(record);return record;
  }
}
