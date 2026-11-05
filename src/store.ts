import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, readdirSync, existsSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { DomainError, digest, experienceDetailsSchema, stableId, tokenize, type Entities, type KnowledgeCard, type Scope, type Table } from './domain.js';
import { canonicalExperiencePayloadSchema, knowledgeActionDependencies, knowledgeRequestSourceRefs, normalizationOriginPayloadSchema } from './knowledge-records.js';
import { ingestSource, redactWithdrawnEvidence } from './intake.js';
import { enqueueStructuredKnowledge, isStructuredKnowledgeCard, structuredIngestJobSchema, structuredKnowledgeCardId, structuredKnowledgeJobId, validStructuredJobRefs } from './knowledge-jobs.js';
import { parseStructuredKnowledge, structuredRepositoryRequest } from './structured-knowledge.js';
import { knowledgeReference, stripDerivedCardFields } from './knowledge-use.js';
import type { KnowledgeReferenceOptions, KnowledgeView, TestObservation } from './knowledge-contract.js';

const tables: Table[] = ['projects', 'sources', 'tasks', 'cards', 'rules', 'cases', 'questions', 'events', 'attempts', 'outbox', 'receipts', 'actions', 'cursors'];
const vaultTables = new Set<Table>(['sources', 'cards', 'rules', 'cases']);
type VaultJob = { table: Table; entity: Entities[Table]; previous?: Entities[Table]; redactStructuredCard?: boolean };
type TemporaryEntry = { entity: Entities[Table]; privacyInvalidated?: true; missingJobCardId?: string; normalizationTransient?: true };
type ExperienceActionQuery = {scope?:Scope;cardId?:string;observationId?:string;revision?:string;after?:string;file?:string};
type IdGroups={keys:Map<string,Set<string>>;byId:Map<string,string[]>};
type OperationGroups={hosts:Map<string,IdGroups>;observations:Map<string,IdGroups>;temporary?:IdGroups};
type MutationFrame={hostScopes:Set<string>;observationScopes:Set<string>;temporary:boolean};
const newGroups=():IdGroups=>({keys:new Map(),byId:new Map()});
const newOperation=():OperationGroups=>({hosts:new Map(),observations:new Map()});
const groupKey=(...parts:unknown[])=>JSON.stringify(parts);
function updateGroups(groups:IdGroups,id:string,keys:string[]):void {
  for(const key of groups.byId.get(id)??[]){const ids=groups.keys.get(key);ids?.delete(id);if(!ids?.size)groups.keys.delete(key);}
  if(!keys.length){groups.byId.delete(id);return;}
  groups.byId.set(id,keys);
  for(const key of keys){let ids=groups.keys.get(key);if(!ids){ids=new Set();groups.keys.set(key,ids);}ids.add(id);}
}
export class VaultSyncError extends DomainError {
  constructor(readonly cause:unknown){super('Changes may have been saved, but Vault synchronization failed; retry.','vault_sync_unavailable',503);this.name='VaultSyncError';}
}
export function isKnowledgeSnapshotFailure(error:unknown):boolean {
  if(error instanceof VaultSyncError)return isKnowledgeSnapshotFailure(error.cause);
  if(!error||typeof error!=='object'||!('code' in error))return false;
  const code=(error as {code?:unknown}).code;
  return code==='knowledge_snapshot_unavailable'||typeof code==='string'&&/^SQLITE_(?:(?:BUSY|LOCKED)(?:_|$)|SCHEMA$)/.test(code);
}
function snapshotError(error:unknown):unknown {
  return isKnowledgeSnapshotFailure(error)&&!(error instanceof VaultSyncError)&&!(error instanceof DomainError&&error.code==='knowledge_snapshot_unavailable')
    ?new DomainError('Knowledge temporarily unavailable; retry.','knowledge_snapshot_unavailable',503):error;
}
const cardExpired=(card:KnowledgeCard):boolean=>!!card.expiresAt&&!(Date.parse(card.expiresAt)>Date.now());
const expiryIntentLocator='withheld:expiry-intent';
// Match the canonical host schema's nonempty, at-most-10000 UTF-16 code units.
const identifiableHostRoot=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=10000;
function hostRoot(row:Entities['actions']):unknown {
  const payload=row?.payload as {observation?:{origin?:{originalEventId?:unknown}}}|null;
  return payload?.observation?.origin?.originalEventId;
}
// A BLOB preserves JavaScript UTF-16 code units, including embedded NUL and
// unpaired surrogates that SQLite's JSON text extraction cannot round-trip.
function hostRootKey(data:string):Buffer|null {
  const root=hostRoot(JSON.parse(data) as Entities['actions']);
  return identifiableHostRoot(root)?Buffer.from(root,'utf16le'):null;
}

/** SQLite owns business state; the Vault and FTS are recoverable, scoped projections. */
export class Store {
  private readonly db: Database.Database;
  private temporary = new Map<string, TemporaryEntry>();
  private vaultJobs = new Map<string, VaultJob>();
  private depth = 0;
  private closed = false;
  private preserveVaultPaths = new Set<string>();
  private operation?:OperationGroups;
  private readDepth=0;
  private mutationFrames:MutationFrame[]=[];

  constructor(databasePath: string, private readonly vaultDir?: string) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    if (vaultDir) mkdirSync(vaultDir, { recursive: true });
    this.db = new Database(databasePath);
    try{
    // The old schema needs its function until its two exact indexes are removed.
    this.db.function('knowledge_host_root_key',{deterministic:true},hostRootKey);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Source retention changes must not leave removed private canonical bytes in free pages.
    this.db.pragma('secure_delete = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrateLegacyHostIndexes();
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, domain TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_scope ON ${table}(project_id, domain)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS actions_experience_card ON actions(json_extract(data,'$.kind'),project_id,domain,coalesce(json_extract(data,'$.payload.association.cardId'),json_extract(data,'$.payload.normalizationOrigin.cardId')));
      CREATE INDEX IF NOT EXISTS actions_experience_revision ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.observation.snapshot.revision'),json_extract(data,'$.payload.observation.observedAt'));
      CREATE INDEX IF NOT EXISTS actions_experience_time ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.observation.observedAt'));
      CREATE INDEX IF NOT EXISTS actions_host_binding ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.sourceHash'),json_extract(data,'$.payload.requestHash'),json_extract(data,'$.payload.observation.claim.kind'),json_extract(data,'$.payload.observation.origin.originalEventId'));
      CREATE INDEX IF NOT EXISTS actions_host_root ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.observation.origin.originalEventId'));
      CREATE INDEX IF NOT EXISTS cards_experience_revision ON cards(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.experience.codeVersion'));
      CREATE INDEX IF NOT EXISTS cards_experience_target ON cards(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.experience.codeVersion'),json_extract(data,'$.experience.files[0]'))`);
    this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(id UNINDEXED, project_id UNINDEXED, domain UNINDEXED, terms, tokenize='unicode61')");
    // Read the Vault before projecting SQLite, so an independent edit is never overwritten at startup.
    this.recoverVault();
    this.protectTemporaryStructuredCards();
    this.flushVault();
    this.transaction(() => { for (const source of this.list('sources')) if (source.status === 'withdrawn') redactWithdrawnEvidence(this, source.id); });
    if (vaultDir) for (const table of vaultTables) for (const entity of this.list(table)) this.publish({ table, entity }, true);
    this.rebuildIndex();
    }catch(error){this.db.close();throw error;}
  }

  private migrateLegacyHostIndexes():void {
    const definitions:Record<string,string>={
      actions_host_binding_key:"CREATE INDEX actions_host_binding_key ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.sourceHash'),json_extract(data,'$.payload.requestHash'),json_extract(data,'$.payload.observation.claim.kind'),knowledge_host_root_key(data)) WHERE json_extract(data,'$.kind') = 'knowledge.host-observation'",
      actions_host_root_key:"CREATE INDEX actions_host_root_key ON actions(json_extract(data,'$.kind'),project_id,domain,knowledge_host_root_key(data)) WHERE json_extract(data,'$.kind') = 'knowledge.host-observation'",
    };
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const present:string[]=[];
      for(const [name,sql] of Object.entries(definitions)){
        const row=this.db.prepare('SELECT type,tbl_name,sql FROM sqlite_schema WHERE name = ?').get(name) as {type:string;tbl_name:string;sql:string}|undefined;
        if(row){if(row.type!=='index'||row.tbl_name!=='actions'||row.sql!==sql)throw new Error(`Unexpected legacy index definition: ${name}`);present.push(name);}
      }
      for(const name of present)this.db.exec(`DROP INDEX ${name}`);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  get<K extends Table>(table: K, id: string): Entities[K] | undefined {
    this.assertTable(table);
    const temporary = this.temporary.get(`${table}:${id}`);
    if (temporary) return this.visible(table,structuredClone(temporary.entity)) as Entities[K];
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? this.visible(table,JSON.parse(row.data) as Entities[Table]) as Entities[K] : undefined;
  }

  list<K extends Table>(table: K): Entities[K][] {
    this.assertTable(table);
    const rows = this.db.prepare(`SELECT data FROM ${table} ORDER BY rowid`).all() as { data: string }[];
    const result = new Map(rows.map(row => { const entity = this.visible(table,JSON.parse(row.data) as Entities[Table]) as Entities[K]; return [entity.id, entity]; }));
    for (const [key, entry] of this.temporary) if (key.startsWith(`${table}:`)) result.set(entry.entity.id, this.visible(table,structuredClone(entry.entity)) as Entities[K]);
    return [...result.values()];
  }

  private scopeKey(scope:Scope):string {return groupKey(scope.projectId,scope.domain);}
  private actionKeys(action:Entities['actions'],scope:Scope=action):string[] {
    const scoped=this.scopeKey(scope),kind=action.kind,keys=[groupKey('kind',kind),groupKey('kind-scope',kind,scoped)];
    const payload=action.payload as {sourceHash?:unknown;requestHash?:unknown;association?:{cardId?:unknown;observationId?:unknown};normalizationOrigin?:{cardId?:unknown};observation?:{claim?:{kind?:unknown};snapshot?:{files?:unknown;revision?:unknown};observedAt?:unknown}}|null;
    if(kind==='knowledge.host-observation'){
      const root=hostRoot(action);
      keys.push(identifiableHostRoot(root)?groupKey('host-root',scoped,root):groupKey('host-unrooted',scoped));
      if(typeof payload?.sourceHash==='string'&&typeof payload.requestHash==='string'&&typeof payload.observation?.claim?.kind==='string'){
        const binding=[scoped,payload.sourceHash,payload.requestHash,payload.observation.claim.kind];
        keys.push(groupKey('host-binding',...binding));
        if(identifiableHostRoot(root))keys.push(groupKey('host-binding-root',...binding,root));
      }
    }
    if(kind==='experience.evidence-link'){
      const cardId=payload?.association?.cardId??payload?.normalizationOrigin?.cardId;
      if(typeof cardId==='string')keys.push(groupKey('link-card',scoped,cardId));
    }
    if(kind==='experience.test-observation'){
      const snapshot=payload?.observation?.snapshot,files=snapshot?.files,revision=snapshot?.revision,at=payload?.observation?.observedAt;
      if(Array.isArray(files)&&typeof revision==='string'&&typeof at==='string'&&Number.isFinite(Date.parse(at))){
        for(const path of new Set(files.map((f:unknown)=>(f as {path?:unknown}|null)?.path).filter((v:unknown):v is string=>typeof v==='string'))){
          keys.push(groupKey('observation-file',scoped,path),groupKey('observation-file-revision',scoped,path,revision));
        }
      }
    }
    return keys;
  }
  private cardKeys(card:KnowledgeCard):string[] {
    const first=card.experience?.files?.[0],version=card.experience?.codeVersion;
    return card.kind==='experience'&&typeof first==='string'&&typeof version==='string'
      ?[groupKey('candidate',this.scopeKey(card),version,first)]:[];
  }
  private temporaryGroups():IdGroups {
    const operation=this.operation;if(!operation)throw new Error('Discovery requires an operation.');
    if(!operation.temporary){
      const groups=newGroups();
      for(const [key,entry] of this.temporary){
        if(key.startsWith('actions:'))updateGroups(groups,key,this.actionKeys(entry.entity as Entities['actions']));
        else if(key.startsWith('cards:'))updateGroups(groups,key,this.cardKeys(entry.entity as KnowledgeCard));
      }
      operation.temporary=groups;
    }
    return operation.temporary;
  }
  private setTemporary(key:string,entry:TemporaryEntry):void {
    const groups=this.operation?.temporary;
    if(groups)updateGroups(groups,key,key.startsWith('actions:')?this.actionKeys(entry.entity as Entities['actions']):key.startsWith('cards:')?this.cardKeys(entry.entity as KnowledgeCard):[]);
    const frame=this.mutationFrames.at(-1);if(frame)frame.temporary=true;
    this.temporary.set(key,entry);
  }
  private deleteTemporary(key:string):void {
    if(this.operation?.temporary)updateGroups(this.operation.temporary,key,[]);
    const frame=this.mutationFrames.at(-1);if(frame&&this.temporary.has(key))frame.temporary=true;
    this.temporary.delete(key);
  }
  private scopedActionGroups(kind:'knowledge.host-observation'|'experience.test-observation',scope:Scope):IdGroups {
    const operation=this.operation;if(!operation)throw new Error('Discovery requires an operation.');
    const scopeKey=this.scopeKey(scope),scopes=kind==='knowledge.host-observation'?operation.hosts:operation.observations;
    let groups=scopes.get(scopeKey);if(groups)return groups;
    groups=newGroups();
    const sql="SELECT id, project_id, domain, data FROM actions WHERE json_extract(data,'$.kind') = ? AND project_id = ? AND domain = ? ORDER BY rowid";
    for(const row of this.db.prepare(sql).iterate(kind,scope.projectId,scope.domain) as Iterable<{id:string;project_id:string;domain:string;data:string}>){
      const action=JSON.parse(row.data) as Entities['actions'];
      updateGroups(groups,row.id,this.actionKeys(action,{projectId:row.project_id,domain:row.domain}));
    }
    scopes.set(scopeKey,groups);return groups;
  }
  private selectedActions(groups:IdGroups,key:string,temporary=false):{row:Entities['actions'];order:number}[] {
    const selected:{row:Entities['actions'];order:number}[]=[];
    for(const id of groups.keys.get(key)??[]){
      if(temporary){
        const entry=this.temporary.get(id);if(!entry)throw new Error('Temporary discovery changed inside an operation.');
        const row=entry.entity as Entities['actions'];
        if(id!==`actions:${row.id}`||!this.actionKeys(row).includes(key))throw new Error('Temporary discovery mismatch.');
        selected.push({row:structuredClone(row),order:selected.length});
      }else{
        if(this.temporary.has(`actions:${id}`))continue;
        const value=this.db.prepare('SELECT rowid,project_id,domain,data FROM actions WHERE id = ?').get(id) as {rowid:number;project_id:string;domain:string;data:string}|undefined;
        if(!value)throw new Error('Durable discovery changed inside an operation.');
        const row=JSON.parse(value.data) as Entities['actions'];
        if(row.id!==id||!this.actionKeys(row,{projectId:value.project_id,domain:value.domain}).includes(key))throw new Error('Durable discovery mismatch.');
        selected.push({row,order:value.rowid});
      }
    }
    return selected.sort((a,b)=>a.order-b.order);
  }
  /** Scoped discovery only; every returned host row is revalidated by the caller. */
  hostObservationActions(scope:Scope,sourceHash:string,requestHash:string,claimKind:'change-head'|'ci-result',eventId?:string):Entities['actions'][] {
    return this.readSnapshot(()=>{
      if(eventId!==undefined&&!identifiableHostRoot(eventId))return [];
      const binding=[this.scopeKey(scope),sourceHash,requestHash,claimKind];
      const key=eventId===undefined?groupKey('host-binding',...binding):groupKey('host-binding-root',...binding,eventId);
      return [...this.selectedActions(this.scopedActionGroups('knowledge.host-observation',scope),key),...this.selectedActions(this.temporaryGroups(),key,true)].map(item=>item.row);
    });
  }
  /** Same execution root across all source/request bindings, plus unrooted malformed rows. */
  hostObservationRootActions(scope:Scope,eventId:string):Entities['actions'][] {
    return this.readSnapshot(()=>{
      const scoped=this.scopeKey(scope),keys=[...(identifiableHostRoot(eventId)?[groupKey('host-root',scoped,eventId)]:[]),groupKey('host-unrooted',scoped)];
      const durable=this.scopedActionGroups('knowledge.host-observation',scope),temporary=this.temporaryGroups();
      return [...keys.flatMap(key=>this.selectedActions(durable,key)),...keys.flatMap(key=>this.selectedActions(temporary,key,true))].map(item=>item.row);
    });
  }
  /** Indexed, scoped candidates; temporary entries overlay persisted rows just as in get/list. */
  experienceActions(kind:'experience.evidence-link'|'experience.test-observation',query:ExperienceActionQuery={}):Entities['actions'][] {
    return this.readSnapshot(()=>{
      if(kind==='experience.test-observation'&&query.scope&&query.file){
        const scoped=this.scopeKey(query.scope),key=query.revision?groupKey('observation-file-revision',scoped,query.file,query.revision):groupKey('observation-file',scoped,query.file);
        const selected=[...this.selectedActions(this.scopedActionGroups(kind,query.scope),key),...this.selectedActions(this.temporaryGroups(),key,true)];
        return selected.filter(({row})=>!query.after||Date.parse((row.payload.observation as TestObservation).observedAt)>Date.parse(query.after))
          .sort((a,b)=>Date.parse((a.row.payload.observation as TestObservation).observedAt)-Date.parse((b.row.payload.observation as TestObservation).observedAt)||a.order-b.order).map(value=>value.row);
      }
      const clauses=["json_extract(data,'$.kind') = ?"],params:(string|number)[]=[kind];
      if(query.scope){clauses.push('project_id = ?','domain = ?');params.push(query.scope.projectId,query.scope.domain);}
      if(query.cardId){clauses.push("coalesce(json_extract(data,'$.payload.association.cardId'),json_extract(data,'$.payload.normalizationOrigin.cardId')) = ?");params.push(query.cardId);}
      if(query.observationId){clauses.push("json_extract(data,'$.payload.association.observationId') = ?");params.push(query.observationId);}
      if(query.revision){clauses.push("json_extract(data,'$.payload.observation.snapshot.revision') = ?");params.push(query.revision);}
      if(query.after){clauses.push("julianday(json_extract(data,'$.payload.observation.observedAt')) > julianday(?)");params.push(query.after);}
      if(query.file){clauses.push("EXISTS (SELECT 1 FROM json_each(data,'$.payload.observation.snapshot.files') f WHERE json_extract(f.value,'$.path') = ?)");params.push(query.file);}
      const rows=this.db.prepare(`SELECT id,data FROM actions WHERE ${clauses.join(' AND ')} ORDER BY rowid`).all(...params) as {id:string;data:string}[];
      const values=rows.filter(row=>!this.temporary.has(`actions:${row.id}`)).map(row=>{const action=JSON.parse(row.data) as Entities['actions'];if(action.id!==row.id)throw new Error('Durable discovery mismatch.');return action;});
      const scoped=query.scope&&this.scopeKey(query.scope),key=scoped&&query.cardId?groupKey('link-card',scoped,query.cardId):scoped?groupKey('kind-scope',kind,scoped):groupKey('kind',kind);
      const temporary=this.selectedActions(this.temporaryGroups(),key,true).map(value=>value.row);
      return [...values,...temporary.filter(action=>{
        const p=action.payload as {association?:{cardId?:string;observationId?:string};normalizationOrigin?:{cardId?:string};observation?:TestObservation};
        return action.kind===kind&&(!query.scope||action.projectId===query.scope.projectId&&action.domain===query.scope.domain)&&(!query.cardId||(p.association?.cardId??p.normalizationOrigin?.cardId)===query.cardId)&&(!query.observationId||p.association?.observationId===query.observationId)&&(!query.revision||p.observation?.snapshot?.revision===query.revision)&&(!query.after||!!p.observation?.observedAt&&Date.parse(p.observation.observedAt)>Date.parse(query.after))&&(!query.file||!!p.observation?.snapshot?.files?.some(file=>file.path===query.file));
      })];
    });
  }

  /** Sweep discovery retains IDs only, never all observation bodies. */
  experienceObservationIds():string[] {
    return this.readSnapshot(()=>{
      const ids:string[]=[];
      for(const row of this.db.prepare("SELECT id FROM actions WHERE json_extract(data,'$.kind') = 'experience.test-observation' ORDER BY rowid").iterate() as Iterable<{id:string}>)
        if(!this.temporary.has(`actions:${row.id}`))ids.push(row.id);
      for(const id of this.temporaryGroups().keys.get(groupKey('kind','experience.test-observation'))??[])ids.push(id.slice('actions:'.length));
      return ids;
    });
  }

  experienceCandidates(observation:TestObservation):KnowledgeCard[] {
    return this.readSnapshot(()=>{
      const paths=[...new Set(observation.snapshot.files.map(file=>file.path))];if(!paths.length)return [];
      const sql=`SELECT id, data FROM cards WHERE json_extract(data,'$.kind') = 'experience' AND project_id = ? AND domain = ? AND json_extract(data,'$.experience.codeVersion') IN (?, 'unknown') AND json_extract(data,'$.experience.files[0]') IN (${paths.map(()=>'?').join(',')}) ORDER BY rowid`;
      const rows=this.db.prepare(sql).all(observation.projectId,observation.domain,observation.snapshot.revision,...paths) as {id:string;data:string}[];
      const values=rows.filter(row=>!this.temporary.has(`cards:${row.id}`)).map(row=>{const card=this.visible('cards',JSON.parse(row.data)) as KnowledgeCard;if(card.id!==row.id)throw new Error('Durable candidate mismatch.');return card;});
      const groups=this.temporaryGroups(),ids=new Set<string>();
      for(const version of [observation.snapshot.revision,'unknown'])for(const path of paths)
        for(const id of groups.keys.get(groupKey('candidate',this.scopeKey(observation),version,path))??[])ids.add(id);
      for(const id of ids){const entry=this.temporary.get(id);if(!entry)throw new Error('Temporary candidate changed inside an operation.');
        const card=this.visible('cards',structuredClone(entry.entity)) as KnowledgeCard;
        if(id!==`cards:${card.id}`||!this.cardKeys(card).some(key=>(groups.keys.get(key)??new Set()).has(id)))throw new Error('Temporary candidate mismatch.');
        values.push(card);
      }
      return values;
    });
  }

  /** Keep a version derived from temporary evidence in memory over the original durable candidate. */
  saveTemporaryNormalizedExperienceCard(card:KnowledgeCard):void {
    const key=`cards:${card.id}`,previous=this.temporary.get(key);
    this.setTemporary(key,{...previous,entity:structuredClone(card),normalizationTransient:true});
  }

  save<K extends Table>(table: K, entity: Entities[K]): void {
    if(this.readDepth)throw new Error('Store read snapshots cannot mutate state.');
    if(!this.depth&&(table==='sources'||table==='actions'||table==='cards'&&this.temporary.get(`cards:${entity.id}`)?.normalizationTransient)){this.transaction(()=>this.save(table,entity));return;}
    this.assertTable(table);
    const previous = this.get(table, entity.id);
    const withdrawing=table==='cards'&&(entity as KnowledgeCard).status==='withdrawn'&&
      (previous as KnowledgeCard|undefined)?.status==='active'&&(previous as KnowledgeCard).kind==='experience';
    // Retiring the associations and the card is one transaction, including
    // the in-memory overlay and the queued Vault projection.
    if(withdrawing&&!this.depth){this.transaction(()=>this.save(table,entity));return;}
    // A standalone card's row, FTS entry and projection intent must commit
    // together. Keep its historical pre-commit SQLite error contract intact.
    if(table==='cards'&&!this.depth){this.commitTransaction(()=>this.save(table,entity),true);return;}
    if(withdrawing){
      const card=previous as KnowledgeCard;
      for(const row of this.experienceActions('experience.evidence-link',{scope:card,cardId:card.id})){
        const parsed=canonicalExperiencePayloadSchema.safeParse(row.payload),origin=normalizationOriginPayloadSchema.safeParse(row.payload);
        if(row.status==='completed'&&(parsed.success&&parsed.data.association.cardId===card.id||origin.success&&origin.data.normalizationOrigin.cardId===card.id))this.save('actions',{...row,status:'pending'});
      }
    }
    let value = structuredClone(entity);
    if(table==='cards')stripDerivedCardFields(value);
    const key = `${table}:${entity.id}`,structured=table==='cards'&&isStructuredKnowledgeCard(value as KnowledgeCard);
    const priorEntry=this.temporary.get(key);
    if(table==='cards'&&priorEntry?.normalizationTransient){
      const incoming=value as KnowledgeCard,overlay=priorEntry.entity as KnowledgeCard;
      const row=this.db.prepare('SELECT data FROM cards WHERE id = ?').get(entity.id) as {data:string}|undefined;
      const base=row?JSON.parse(row.data) as KnowledgeCard:undefined;
      const sameIdentity=!!base&&base.id===incoming.id&&base.sourceId===incoming.sourceId&&base.sourceRevision===incoming.sourceRevision&&
        base.projectId===incoming.projectId&&base.domain===incoming.domain;
      const retainsVersion=!!incoming.experience&&!!overlay.experience&&incoming.experience.codeVersion===overlay.experience.codeVersion;
      // Only the observed version remains transient. Authored fields are always
      // projected onto the durable unknown-version base.
      if(incoming.status==='active'&&base?.experience?.codeVersion==='unknown'&&sameIdentity&&retainsVersion&&incoming.experience&&!this.isTemporaryDerived('cards',base)){
        const durable:KnowledgeCard={...incoming,experience:{...incoming.experience,codeVersion:'unknown'}};
        this.write('cards',durable);this.indexCard(durable);
        this.vaultJobs.set(key,{table:'cards',entity:durable,previous:base});
        if(!this.depth)this.flushVault();
        this.setTemporary(key,{...priorEntry,entity:value});return;
      }
      if(incoming.status==='active'&&!base&&retainsVersion&&incoming.sourceId===overlay.sourceId&&incoming.sourceRevision===overlay.sourceRevision&&incoming.projectId===overlay.projectId&&incoming.domain===overlay.domain&&this.isTemporaryDerived('cards',incoming)){
        this.setTemporary(key,{...priorEntry,entity:value});return;
      }
      // A removed descriptor, changed version or changed identity ends the overlay.
      // Do not carry its revision into a newly durable identity.
      for(const row of this.experienceActions('experience.evidence-link',{scope:overlay,cardId:overlay.id})){
        const actionKey=`actions:${row.id}`,entry=this.temporary.get(actionKey),parsed=canonicalExperiencePayloadSchema.safeParse(row.payload);
        if(entry&&row.status==='completed'&&parsed.success&&parsed.data.association.versionBinding)this.setTemporary(actionKey,{...entry,entity:{...row,status:'pending'}});
      }
      if(retainsVersion&&incoming.experience)value={...incoming,experience:{...incoming.experience,codeVersion:'unknown'}} as Entities[K];
      if(base&&!sameIdentity&&!this.isTemporaryDerived('cards',base)&&this.isTemporaryDerived('cards',value)){
        // A temporary replacement must not uncover the old durable card on restart.
        const retired:KnowledgeCard={...base,status:'withdrawn',experience:undefined};
        this.write('cards',retired);this.indexCard(retired);
        this.vaultJobs.set(key,{table:'cards',entity:retired,previous:base});
        if(!this.depth)this.flushVault();
      }
      this.deleteTemporary(key);
    }
    if(table==='actions'){
      const parsed=canonicalExperiencePayloadSchema.safeParse((value as Entities['actions']).payload);
      if(parsed.success&&parsed.data.association.versionBinding&&this.temporary.get(`cards:${parsed.data.association.cardId}`)?.normalizationTransient){
        this.setTemporary(key,{entity:value});this.deleteAction(entity.id);return;
      }
    }
    // A sanitized origin inherits the prior row's temporary lifetime even after old refs disappear.
    if(table==='actions'&&this.temporary.has(key)&&normalizationOriginPayloadSchema.safeParse((value as Entities['actions']).payload).success){
      this.setTemporary(key,{entity:value});this.deleteAction(entity.id);return;
    }
    let card=structured?value as KnowledgeCard:undefined;
    if(card?.status==='active'&&previous&&(previous as KnowledgeCard).status==='withdrawn'){
      const existing=previous as KnowledgeCard,entry=this.temporary.get(key),source=this.get('sources',card.sourceId);
      if(cardExpired(existing)||!existing.expiresAt||!(entry?.missingJobCardId===card.id||this.isStructuredCardExpiryIntent(existing))||
        existing.sourceId!==card.sourceId||existing.sourceRevision!==card.sourceRevision||existing.projectId!==card.projectId||existing.domain!==card.domain||
        card.id!==structuredKnowledgeCardId(card)||card.verification!=='reported'||card.claim||!source?.content.includes(card.quote)||this.structuredCardDependencyState(card)==='unknown')return;
      card={...card,expiresAt:existing.expiresAt};value=card as Entities[K];
      this.deleteTemporary(key);
      for(const [actionKey,action] of this.temporary)if(action.missingJobCardId===card.id)this.deleteTemporary(actionKey);
    }
    const inactive=!!card&&(card.status==='withdrawn'||cardExpired(card));
    const unknown=!!card&&this.structuredCardDependencyState(card)==='unknown',source=card&&this.get('sources',card.sourceId);
    const missingJobCard=unknown&&!inactive&&!!source&&source.status==='active'&&!this.get('actions',structuredKnowledgeJobId(source));
    if(card&&inactive)value=this.structuredCardTombstone(card) as Entities[K];
    else if(card&&unknown)value=this.redactStructuredCard(card) as Entities[K];
    if (table === 'cards' && !this.cardActive(value as KnowledgeCard, value)) delete (value as KnowledgeCard).experience;
    if (table === 'sources' && (value as Entities['sources']).retention === 'ephemeral') {
      this.setTemporary(key, {entity:value});
      this.write(table, { ...value, content: '', title: 'Temporary source' } as Entities[K]);
      this.protectTemporaryKnowledgeActions();
      this.protectTemporaryStructuredCards();
      if (!this.depth) this.flushVault();
      return;
    }
    if (this.isTemporaryDerived(table, value)) {
      const prior=this.temporary.get(key);
      this.setTemporary(key, {entity:value,...(unknown&&!inactive?{privacyInvalidated:true as const}:{}),...(missingJobCard?{missingJobCardId:entity.id}:{})});
      if(table === 'actions'){
        const hold=this.durableReadHold(value as Entities['actions']);
        if(hold)this.write('actions',hold);else this.deleteAction(entity.id);
        if((value as Entities['actions']).kind==='knowledge.structured-ingest'){this.protectTemporaryStructuredCards();if(!this.depth)this.flushVault();}
      }
      if(table==='cards'&&isStructuredKnowledgeCard(value as KnowledgeCard)){
        if(inactive)this.write('cards',this.structuredCardTombstone(entity as KnowledgeCard));
        else if(card?.expiresAt&&Number.isFinite(Date.parse(card.expiresAt))){
          const recoverable=!unknown||missingJobCard||prior?.missingJobCardId===entity.id;
          this.write('cards',recoverable?this.structuredCardExpiryIntent(card):this.structuredCardTombstone(card));
        }
        else this.db.prepare('DELETE FROM cards WHERE id = ?').run(entity.id);
        this.db.prepare('DELETE FROM cards_fts WHERE id = ?').run(entity.id);
        this.queueStructuredCardRedaction(value as KnowledgeCard);
        if(!this.depth)this.flushVault();
      }
      return;
    }
    if (this.isTemporaryTaskEntity(table, value)) {
      this.setTemporary(key, {entity:value});
      this.write(table, this.redactTemporary(table, value) as Entities[K]);
      return;
    }
    this.deleteTemporary(key);
    this.write(table, value);
    if(table==='actions'&&((value as Entities['actions']).kind==='knowledge.structured-ingest'||(previous as Entities['actions']|undefined)?.kind==='knowledge.structured-ingest')){this.protectTemporaryStructuredCards();if(!this.depth)this.flushVault();}
    if (table === 'cards') this.indexCard(value as KnowledgeCard);
    if (table === 'sources') {
      const source = value as Entities['sources'];
      this.protectTemporaryKnowledgeActions();
      this.protectTemporaryStructuredCards();
      if (source.status !== 'active') this.db.prepare('DELETE FROM cards_fts WHERE id IN (SELECT json_extract(data, \'$.id\') FROM cards WHERE json_extract(data, \'$.sourceId\') = ?)').run(source.id);
    }
    if (vaultTables.has(table)) {
      this.vaultJobs.set(key, { table, entity: value, previous });
      if (!this.depth) this.flushVault();
    }
  }

  delete(table: Table, id: string): void {
    if(this.readDepth)throw new Error('Store read snapshots cannot mutate state.');
    if(!this.depth&&table==='actions'){this.transaction(()=>this.delete(table,id));return;}
    this.assertTable(table); const entity = this.get(table, id);
    this.deleteTemporary(`${table}:${id}`);
    if(table==='actions')this.deleteAction(id);else this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
    if(table==='actions'&&(entity as Entities['actions']|undefined)?.kind==='knowledge.structured-ingest'){this.protectTemporaryStructuredCards();if(!this.depth)this.flushVault();}
    if (table === 'cards') this.db.prepare('DELETE FROM cards_fts WHERE id = ?').run(id);
    if (entity && this.vaultDir && vaultTables.has(table)) {
      const path = this.vaultPath(table, entity);
      // Deletions are represented by a tombstone in the same post-commit projection queue.
      this.vaultJobs.set(`${table}:${id}`, { table, entity: { ...entity, status: 'withdrawn' } as Entities[Table], previous: entity });
      if (!this.depth && existsSync(path)) this.flushVault();
    }
  }

  readSnapshot<T>(fn:()=>T):T {
    const outer=!this.operation;
    if(outer&&this.db.inTransaction)throw new Error('Untracked Store transaction.');
    let begun=false;
    try{
      if(outer){this.db.exec('BEGIN DEFERRED');begun=true;this.db.pragma('main.data_version');this.operation=newOperation();}
      this.readDepth++;
      let value:T;
      try{value=fn();if(value&&typeof (value as {then?:unknown}).then==='function')throw new Error('Store snapshots must be synchronous.');}
      finally{this.readDepth--;}
      if(outer){this.db.exec('COMMIT');begun=false;}
      return value;
    }catch(error){if(begun)this.db.exec('ROLLBACK');throw snapshotError(error);}
    finally{if(outer)this.operation=undefined;}
  }

  transaction<T>(fn: () => T): T {
    return this.commitTransaction(fn,false);
  }

  private commitTransaction<T>(fn: () => T, preserveRawError:boolean): T {
    if(this.readDepth)throw new Error('Store read snapshots cannot enter a write transaction.');
    const outer=!this.operation;
    if(outer&&this.db.inTransaction)throw new Error('Untracked Store transaction.');
    if(outer)this.operation=newOperation();
    const previousJobs = new Map(this.vaultJobs); const previousTemporary = new Map(this.temporary);
    const frame:MutationFrame={hostScopes:new Set(),observationScopes:new Set(),temporary:false};this.mutationFrames.push(frame);
    this.depth++;
    let result: T;
    try {
      result = this.db.transaction(() => {
        const value = fn();
        if (value && typeof (value as { then?: unknown }).then === 'function') throw new Error('Store transactions must be synchronous.');
        return value;
      })();
    } catch (error) {
      this.depth--;
      this.mutationFrames.pop();
      this.vaultJobs = previousJobs; this.temporary = previousTemporary;
      if(outer)this.operation=undefined;
      else if(this.operation){for(const scope of frame.hostScopes)this.operation.hosts.delete(scope);for(const scope of frame.observationScopes)this.operation.observations.delete(scope);if(frame.temporary)this.operation.temporary=undefined;}
      throw preserveRawError?error:snapshotError(error);
    }
    this.depth--;
    this.mutationFrames.pop();
    const parent=this.mutationFrames.at(-1);if(parent){for(const scope of frame.hostScopes)parent.hostScopes.add(scope);for(const scope of frame.observationScopes)parent.observationScopes.add(scope);parent.temporary||=frame.temporary;}
    if(outer)this.operation=undefined;
    if (!this.depth) this.flushVault();
    return result;
  }

  searchCards(query: string, scope: Scope, limit = 20, options: KnowledgeReferenceOptions = {}): KnowledgeView[] {
    return this.readSnapshot(()=>this.searchCardsInSnapshot(query,scope,limit,options));
  }
  private searchCardsInSnapshot(query: string, scope: Scope, limit: number, options: KnowledgeReferenceOptions): KnowledgeView[] {
    const terms = tokenize(query).split(' ').filter(Boolean);
    if (!terms.length) return [];
    const match = [...new Set(terms)].map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const maximum=Number.isFinite(limit)?Math.max(1,Math.min(100,Math.floor(limit))):20,results:KnowledgeView[]=[];
    const statement=this.db.prepare('SELECT id FROM cards_fts WHERE cards_fts MATCH ? AND project_id = ? AND domain = ? ORDER BY bm25(cards_fts), id LIMIT 100 OFFSET ?');
    for(let offset=0;offset<1000&&results.length<maximum;offset+=100){
      const rows=statement.all(match,scope.projectId,scope.domain,offset);
      for(const row of rows){if(!row||typeof row!=='object'||!('id' in row)||typeof row.id!=='string')continue;const card=this.get('cards',row.id);if(!card||!this.cardActive(card,scope))continue;const view=knowledgeReference(this,card,scope,options);if(view)results.push(view);if(results.length===maximum)break;}
      if(rows.length<100)break;
    }
    return results;
  }

  indexCard(card: KnowledgeCard): void {
    if(this.readDepth)throw new Error('Store read snapshots cannot mutate state.');
    this.db.prepare('DELETE FROM cards_fts WHERE id = ?').run(card.id);
    if (!this.cardActive(card, card) || this.isTemporaryDerived('cards',card)) return;
    this.db.prepare('INSERT INTO cards_fts(id, project_id, domain, terms) VALUES (?, ?, ?, ?)').run(card.id, card.projectId, card.domain, tokenize([card.title, card.aliases.join(' '), card.experience?.problem ?? '', card.experience?.symptomAliases.join(' ') ?? '', card.body, card.quote].join(' ')));
  }

  rebuildIndex(): void {
    if(this.readDepth)throw new Error('Store read snapshots cannot mutate state.');
    this.recoverVault();
    this.db.transaction(() => { this.db.exec('DELETE FROM cards_fts'); for (const card of this.list('cards')) this.indexCard(card); })();
  }

  async backup(destination: string): Promise<void> { mkdirSync(dirname(destination), { recursive: true }); await this.db.backup(destination); }
  vaultDirectory():string|undefined{return this.vaultDir;}
  close(): void { if (this.closed) return; this.db.close(); this.closed = true; this.temporary.clear(); this.operation=undefined; }

  private write<K extends Table>(table: K, entity: Entities[K]): void {
    const previous=table==='actions'?this.rawAction(entity.id):undefined;
    this.db.prepare(`INSERT INTO ${table}(id, project_id, domain, data) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, domain = excluded.domain, data = excluded.data`).run(entity.id, entity.projectId, entity.domain, JSON.stringify(entity));
    if(table==='actions')this.actionChanged(previous,entity as Entities['actions']);
  }
  private rawAction(id:string):Entities['actions']|undefined {
    if(!this.operation)return undefined;
    const row=this.db.prepare('SELECT data FROM actions WHERE id = ?').get(id) as {data:string}|undefined;
    return row?JSON.parse(row.data) as Entities['actions']:undefined;
  }
  private actionChanged(previous:Entities['actions']|undefined,next:Entities['actions']|undefined):void {
    const operation=this.operation;if(!operation)return;
    const frame=this.mutationFrames.at(-1);
    for(const action of [previous,next])if(action){
      const scope=this.scopeKey(action),kind=action.kind;
      if(kind==='knowledge.host-observation')frame?.hostScopes.add(scope);
      if(kind==='experience.test-observation')frame?.observationScopes.add(scope);
    }
    for(const groups of [...operation.hosts.values(),...operation.observations.values()])if(previous)updateGroups(groups,previous.id,[]);
    if(next){const scope=this.scopeKey(next);
      if(next.kind==='knowledge.host-observation'){const groups=operation.hosts.get(scope);if(groups)updateGroups(groups,next.id,this.actionKeys(next));}
      if(next.kind==='experience.test-observation'){const groups=operation.observations.get(scope);if(groups)updateGroups(groups,next.id,this.actionKeys(next));}
    }
  }
  private deleteAction(id:string):void {
    const previous=this.rawAction(id);this.db.prepare('DELETE FROM actions WHERE id = ?').run(id);this.actionChanged(previous,undefined);
  }
  private assertTable(table: string): void { if (!tables.includes(table as Table)) throw new Error('Unknown entity table.'); }
  private visible(table:Table,entity:Entities[Table]):Entities[Table] {
    if(table==='cards'){
      const card=entity as KnowledgeCard;
      if(isStructuredKnowledgeCard(card)&&cardExpired(card))return this.structuredCardTombstone(card);
    }
    return entity;
  }
  private cardActive(card: KnowledgeCard, scope: Scope): boolean {
    const source = this.get('sources', card.sourceId);
    return card.status === 'active' && card.projectId === scope.projectId && card.domain === scope.domain && (!card.expiresAt || Date.parse(card.expiresAt) > Date.now()) && source?.status === 'active' && source.revision === card.sourceRevision && source.projectId === card.projectId && source.domain === card.domain;
  }
  private isTemporaryDerived(table: Table, entity: Entities[Table]): boolean {
    if (table === 'actions') return this.temporaryKnowledgeAction(entity as Entities['actions']);
    if (table === 'cards'&&isStructuredKnowledgeCard(entity as KnowledgeCard)) return this.temporaryStructuredCard(entity as KnowledgeCard);
    if (!['cards', 'rules', 'cases'].includes(table)) return false;
    if ('sourceId' in entity) return this.get('sources', entity.sourceId)?.retention === 'ephemeral';
    if ('citations' in entity) return entity.citations.some(c => this.get('sources', c.sourceId)?.retention === 'ephemeral');
    return false;
  }
  private temporaryKnowledgeAction(action:Entities['actions']):boolean {
    const dependencies=knowledgeActionDependencies(action);
    return dependencies.unresolved||dependencies.refs.some(ref=>this.temporarySourceDependency(ref.id));
  }
  /** Retain only the bounded denial needed to prevent replay, never a read result. */
  private durableReadHold(action:Entities['actions']):Entities['actions']|undefined {
    const parsed=structuredIngestJobSchema.safeParse(action.payload);
    if(action.kind!=='knowledge.structured-ingest'||action.status!=='pending'||!parsed.success)return undefined;
    const job=parsed.data,hold=job.readHold;
    if(job.phase!=='pending-readback'||job.errorCode!=='knowledge_read_inflight'||!hold||
      action.id!==stableId('knowledge.structured-ingest',job.sourceId,job.sourceRevision,job.sourceHash)||
      hold.sourceHashes.length!==job.sourceRefs.length||new Set(job.sourceRefs.map(ref=>ref.id)).size!==job.sourceRefs.length||
      hold.sourceHashes.some((ref,index)=>ref.id!==job.sourceRefs[index]?.id||ref.revision!==job.sourceRefs[index]?.revision)||
      !hold.sourceHashes.some(ref=>ref.id===job.sourceId&&ref.revision===job.sourceRevision&&ref.hash===job.sourceHash))return undefined;
    const source=this.get('sources',job.sourceId);
    if(!source||source.id!==job.sourceId||source.revision!==job.sourceRevision||source.projectId!==action.projectId||source.domain!==action.domain)return undefined;
    return {id:action.id,projectId:action.projectId,domain:action.domain,kind:action.kind,status:'pending',payload:job as unknown as Record<string,unknown>,updatedAt:action.updatedAt};
  }
  private protectTemporaryKnowledgeActions():void {
    for(const action of this.list('actions'))if(this.temporaryKnowledgeAction(action)){
      this.setTemporary(`actions:${action.id}`,{entity:action});
      const hold=this.durableReadHold(action);if(hold)this.write('actions',hold);else this.deleteAction(action.id);
    }
  }
  private structuredCardDependencyState(card:KnowledgeCard):'unknown'|'temporary'|'permanent' {
    const source=this.get('sources',card.sourceId);if(!source||source.revision!==card.sourceRevision)return 'unknown';
    const action=this.get('actions',structuredKnowledgeJobId(source)),job=action&&structuredIngestJobSchema.safeParse(action.payload);
    if(!action||action.kind!=='knowledge.structured-ingest'||!job?.success||action.projectId!==card.projectId||action.domain!==card.domain||job.data.sourceId!==source.id||job.data.sourceRevision!==source.revision||job.data.sourceHash!==digest(source.content)||!validStructuredJobRefs(this,source,job.data.sourceRefs))return 'unknown';
    if(job.data.sourceRefs.some(ref=>{const dependency=this.get('sources',ref.id),hash=this.get('cursors',stableId('source-hash',ref.id))?.value;return !dependency||!!hash&&hash!==digest(dependency.content);}))return 'unknown';
    if(!(action.status==='pending'&&['queued','pending-readback'].includes(job.data.phase)||action.status==='completed'&&job.data.phase==='processed'))return 'unknown';
    const project=this.get('projects',card.projectId);if(!project)return 'unknown';
    try{
      const parsed=parseStructuredKnowledge(source,project);if(!parsed)return 'unknown';
      if(parsed.kind==='experience'&&parsed.input.issueId){const issue=this.get('sources',parsed.input.issueId);if(issue&&(issue.status!=='active'||issue.projectId!==source.projectId||issue.domain!==source.domain||issue.retention==='ephemeral'&&!issue.content))return 'unknown';}
      const request=structuredRepositoryRequest(this,source,project,parsed),expected=knowledgeRequestSourceRefs(this,source.id,project,request);
      if(!expected||digest(expected)!==digest(job.data.sourceRefs))return 'unknown';
    }catch(error){if(isKnowledgeSnapshotFailure(error))throw error;return 'unknown';}
    return job.data.sourceRefs.some(ref=>this.temporarySourceDependency(ref.id))?'temporary':'permanent';
  }
  private temporaryStructuredCard(card:KnowledgeCard):boolean {return this.structuredCardDependencyState(card)!=='permanent';}
  private redactStructuredCard(card:KnowledgeCard):KnowledgeCard {return {...card,status:'withdrawn',title:'[withdrawn]',body:'',quote:'',aliases:[],experience:undefined,claim:undefined,pendingClaim:undefined,locator:`withdrawn:${card.sourceId}`};}
  private structuredCardTombstone(card:KnowledgeCard):KnowledgeCard {
    const expiry=card.expiresAt?Date.parse(card.expiresAt):NaN;
    return {id:card.id,projectId:card.projectId,domain:card.domain,sourceId:card.sourceId,sourceRevision:card.sourceRevision,status:'withdrawn',kind:'fact',verification:'reported',title:'',body:'',quote:'',locator:'',aliases:[],createdAt:'',...(Number.isFinite(expiry)&&card.expiresAt?{expiresAt:card.expiresAt}:{})};
  }
  private structuredCardExpiryIntent(card:KnowledgeCard):KnowledgeCard {return {...this.structuredCardTombstone(card),locator:expiryIntentLocator};}
  private isStructuredCardExpiryIntent(card:KnowledgeCard):boolean {
    return card.status==='withdrawn'&&card.locator===expiryIntentLocator&&!!card.expiresAt&&Number.isFinite(Date.parse(card.expiresAt))&&card.kind==='fact'&&card.verification==='reported'&&!card.title&&!card.body&&!card.quote&&!card.createdAt&&!card.aliases.length&&!card.experience&&!card.claim&&!card.pendingClaim;
  }
  private queueStructuredCardRedaction(card:KnowledgeCard):void {
    if(!this.vaultDir)return;
    const path=this.vaultPath('cards',card),directory=dirname(path),prefix=path.slice(path.lastIndexOf('/')+1).replace(/\.md$/,'.conflict-');
    if(existsSync(path)||existsSync(directory)&&readdirSync(directory).some(name=>name.startsWith(prefix)&&name.endsWith('.md')))this.vaultJobs.set(`cards:${card.id}`,{table:'cards',entity:card,redactStructuredCard:true});
  }
  private protectTemporaryStructuredCards():void {
    for(const card of this.list('cards'))if(isStructuredKnowledgeCard(card)){
      const key=`cards:${card.id}`,entry=this.temporary.get(key),state=this.structuredCardDependencyState(card),unknown=state==='unknown',expired=cardExpired(card),intent=this.isStructuredCardExpiryIntent(card);
      if(!unknown&&!expired&&entry?.missingJobCardId===card.id){
        if(card.expiresAt)continue;
        // Drop only automatically invalidated placeholders. A fresh processor must rebuild
        // the description and perform a new authenticated read before it can link facts.
        this.deleteTemporary(key);
        for(const [actionKey,action] of this.temporary)if(action.missingJobCardId===card.id)this.deleteTemporary(actionKey);
        continue;
      }
      if(state==='permanent'&&!expired)continue;
      const source=this.get('sources',card.sourceId),missing=!!source&&!this.get('actions',structuredKnowledgeJobId(source));
      const automatic=!!entry?.privacyInvalidated||intent||card.status==='active'&&!expired;
      let validIssue=true;
      if(source){const project=this.get('projects',source.projectId);try{const parsed=project&&parseStructuredKnowledge(source,project);if(parsed?.kind==='experience'&&parsed.input.issueId){const issue=this.get('sources',parsed.input.issueId);validIssue=!issue||issue.status==='active'&&issue.projectId===source.projectId&&issue.domain===source.domain&&!(issue.retention==='ephemeral'&&!issue.content);}}catch(error){if(isKnowledgeSnapshotFailure(error))throw error;validIssue=false;}}
      const recoverable=unknown&&automatic&&!expired&&source?.status==='active'&&validIssue&&(entry?.privacyInvalidated?entry.missingJobCardId===card.id:intent||missing);
      const redacted=unknown?this.redactStructuredCard(card):card;
      this.setTemporary(key,{entity:redacted,...(unknown&&automatic?{privacyInvalidated:true as const}:{}),...(recoverable?{missingJobCardId:card.id}:{})});
      if((recoverable||state==='temporary'&&card.status==='active'&&!expired)&&card.expiresAt&&Number.isFinite(Date.parse(card.expiresAt)))this.write('cards',this.structuredCardExpiryIntent(card));
      else if(card.expiresAt||!automatic&&card.status==='withdrawn'||intent&&!recoverable)this.write('cards',this.structuredCardTombstone(card));
      else this.db.prepare('DELETE FROM cards WHERE id = ?').run(card.id);
      this.db.prepare('DELETE FROM cards_fts WHERE id = ?').run(card.id);this.queueStructuredCardRedaction(card);
      for(const action of this.list('actions'))if((action.kind==='knowledge.evidence-link'&&(action.payload.link as {cardId?:unknown}|undefined)?.cardId===card.id)||(action.kind==='experience.evidence-link'&&canonicalExperiencePayloadSchema.safeParse(action.payload).data?.association.cardId===card.id)){
        this.setTemporary(`actions:${action.id}`,{entity:unknown?{...action,status:'completed',payload:{retracted:true,sourceIds:[card.sourceId]}}:action,...(unknown&&recoverable?{missingJobCardId:card.id}:{})});this.deleteAction(action.id);
      }
    }
  }
  private temporarySourceDependency(id:string, seen=new Set<string>()):boolean {
    if(seen.has(id))return true;seen.add(id);const source=this.get('sources',id);
    const temporary=!source||source.retention==='ephemeral'||!!source.parentSources?.some(ref=>this.temporarySourceDependency(ref.id,seen));
    seen.delete(id);return temporary;
  }
  private isTemporaryTaskEntity(table: Table, entity: Entities[Table]): boolean {
    const task = table === 'tasks' ? entity as Entities['tasks'] : 'taskId' in entity && entity.taskId ? this.get('tasks', entity.taskId) : undefined;
    return !!task && this.get('sources', task.sourceId)?.retention === 'ephemeral';
  }
  private redactTemporary(table: Table, entity: Entities[Table]): Entities[Table] {
    if (table === 'tasks') return { ...entity, title: 'Temporary task', description: '', decision: undefined, plan: undefined, artifact: undefined, review: undefined, feedback: undefined, baselineFiles: undefined, error: 'Temporary content is kept only in the active process.' } as Entities['tasks'];
    if (table === 'events') return { ...entity, message: 'Temporary task event.', data: {} } as Entities['events'];
    if (table === 'attempts') {
      const attempt = entity as Entities['attempts'];
      // Retain only fixed accounting/availability codes, never provider or source text.
      const error = ['attempt_abandoned_after_host_restart', 'billing_policy_violation', 'subscription_unavailable'].includes(attempt.error ?? '') ? attempt.error : undefined;
      return { ...attempt, error };
    }
    if (table === 'actions') {
      const action=entity as Entities['actions'],task=action.taskId&&this.get('tasks',action.taskId),payload=action.payload;
      const prior=payload.priorSucceededAttemptIds,before=payload.attemptsBefore;
      if(task&&action.status==='pending'&&action.kind===task.stage&&['knowledge_extract','case_extract','decide','plan','execute','check','feedback'].includes(action.kind)&&
        action.id===stableId('stage-action',task.id,task.version,task.stage,task.repairCount)&&action.projectId===task.projectId&&action.domain===task.domain&&
        payload.taskVersion===task.version&&payload.sourceRevision===task.sourceRevision&&typeof before==='number'&&Number.isSafeInteger(before)&&before>=0&&before<=task.attempts&&
        Array.isArray(prior)&&prior.length<=32&&new Set(prior).size===prior.length&&prior.every(id=>typeof id==='string'&&this.list('attempts').some(a=>a.id===id&&a.taskId===task.id&&a.projectId===task.projectId&&a.domain===task.domain&&a.taskVersion===task.version&&a.role===task.stage&&a.status==='succeeded')))
        return {id:action.id,projectId:action.projectId,domain:action.domain,taskId:task.id,kind:action.kind,status:'pending',updatedAt:action.updatedAt,payload:{taskVersion:task.version,sourceRevision:task.sourceRevision,attemptsBefore:before,priorSucceededAttemptIds:prior}};
      return { ...action, payload: {} };
    }
    if (table === 'outbox') return { ...entity, text: '', status: 'sent', remoteId: 'expired-temporary' } as Entities['outbox'];
    if (table === 'questions') {
      const q = entity as Entities['questions']; const option = { label: '[expired]', description: '[expired]', rationale: '[expired]', tradeoff: '[expired]', evidenceUrls: [] };
      return { ...q, title: 'Temporary question', context: '', status: 'stale', options: { A: option, B: option }, research: { queries: [], summary: '', gaps: [] }, answer: q.answer ? { ...q.answer, text: '' } : undefined };
    }
    return entity;
  }
  private vaultPath(table: Table, entity: Entities[Table]): string {
    const segment = (text: string) => encodeURIComponent(text).replaceAll('.', '%2E');
    return join(this.vaultDir!, segment(entity.projectId), segment(entity.domain), table, `${segment(entity.id)}.md`);
  }
  private markdown(table: Table, entity: Entities[Table]): string {
    entity = this.vaultEntity(table, entity);
    const meta = ['---', `id: ${JSON.stringify(entity.id)}`, `project: ${JSON.stringify(entity.projectId)}`, `domain: ${JSON.stringify(entity.domain)}`, `type: ${table}`, `patrick_entity: ${JSON.stringify(entity)}`];
    if ('status' in entity) meta.push(`status: ${entity.status}`);
    if ('sourceId' in entity) meta.push(`source: ${JSON.stringify(entity.sourceId)}`);
    if ('sourceRevision' in entity) meta.push(`revision: ${JSON.stringify(entity.sourceRevision)}`);
    if ('verification' in entity) meta.push(`verification: ${entity.verification}`);
    meta.push('---', '');
    if ('status' in entity && !['active'].includes(entity.status)) return `${meta.join('\n')}\nEvidence is no longer active.\n`;
    const title = 'title' in entity ? entity.title : 'originalWords' in entity ? 'Decision case' : entity.id;
    let body = '';
    if (table === 'sources') body = (entity as Entities['sources']).content;
    if (table === 'cards') {
      const card = entity as Entities['cards'], experience = card.experience;
      const description = card.kind === 'experience' ? `\n\nExperience: pending (reported description; no host evidence)${experience ? `\nReported problem: ${experience.problem}\nReported solution: ${experience.solution}\nReported files: ${experience.files.join(', ')}\nReported product: ${experience.productId}\nReported code version: ${experience.codeVersion}\nReported environment: ${experience.environment}\nReported invalidation conditions: ${experience.invalidationConditions.join('; ')}` : '\nReported details unavailable (legacy card).'}` : '';
      body = `${card.body}${description}\n\n> ${card.quote.replaceAll('\n', '\n> ')}\n\nSource: ${card.locator}\nRevision: ${card.sourceRevision}`;
    }
    if (table === 'rules') { const rule = entity as Entities['rules']; body = `${rule.statement}\n\nKind: ${rule.kind}\nVersion: ${rule.version}\nConditions: ${rule.conditions}\nExceptions: ${rule.exceptions}\n\n${rule.citations.map(c => `> ${c.quote}\n\nSource: ${c.locator} (${c.revision})`).join('\n\n')}`; }
    if (table === 'cases') {
      const c = entity as Entities['cases'], s = c.decisionSnapshot;
      body = `${c.originalWords}\n\nChoice: ${c.choice}\nActor: ${c.actorId}\nQuestion: ${c.questionId}\nRationale: ${c.rationale}\n\n## Judgment at the time\n\n${s ? `Goal: ${s.goal.title}\n\n${s.decision.summary}\n\n${s.decision.rationale}\n\nExpected outcome: ${s.expectedOutcome ?? 'Not stated'}\n\n${s.rules.map(rule => `Used rule: ${rule.title} @ v${rule.version}\n${rule.statement}`).join('\n\n')}` : 'Historical judgment snapshot unavailable.'}\n\n## Observed results\n\n${c.outcomes?.length ? c.outcomes.map(outcome => `${outcome.recordedAt} · Receipt ${outcome.receiptId}\n${outcome.summary}`).join('\n\n') : c.outcome ?? 'Not observed'}`;
    }
    return `${meta.join('\n')}\n# ${title}\n\n${body}\n`;
  }
  private publish(job: VaultJob, startup = false): void {
    if (!this.vaultDir) return;
    // A queued projection never grants authority. Read the current durable row,
    // not a temporary overlay; use a tombstone if the row disappeared.
    const row=this.db.prepare(`SELECT data FROM ${job.table} WHERE id = ?`).get(job.entity.id) as {data:string}|undefined;
    const latest=row?this.visible(job.table,JSON.parse(row.data) as Entities[Table]):{...job.entity,status:'withdrawn'} as Entities[Table];
    if (!job.redactStructuredCard && (this.isTemporaryDerived(job.table, latest) || job.table === 'sources' && (latest as Entities['sources']).retention === 'ephemeral')) return;
    const card=latest as KnowledgeCard;
    const entity=job.redactStructuredCard?{...card,status:'withdrawn' as const,title:'[withdrawn]',body:'',quote:'',aliases:[],experience:undefined,claim:undefined,pendingClaim:undefined,locator:`withdrawn:${card.sourceId}`} : latest;
    const path = this.vaultPath(job.table, entity); const body = this.markdown(job.table, entity);
    const effective = this.vaultEntity(job.table, entity);
    const inactive = 'status' in effective && effective.status !== 'active';
    if (startup && !inactive && this.preserveVaultPaths.has(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    if (inactive) {
      const prefix = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, '.conflict-');
      for (const name of readdirSync(dirname(path))) if (name.startsWith(prefix) && name.endsWith('.md')) writeFileSync(join(dirname(path), name), body, { mode: 0o600 });
    }
    if (existsSync(path)) {
      const previous = readFileSync(path, 'utf8');
      if (previous === body) return;
      const prior=job.previous&&this.vaultEntity(job.table,job.previous);
      const priorAuthorized=!prior||!('status' in prior)||prior.status==='active';
      if (!inactive && priorAuthorized && (!job.previous || previous !== this.markdown(job.table, job.previous))) {
        const conflict = path.replace(/\.md$/, `.conflict-${digest(previous).slice(0, 12)}.md`);
        if (!existsSync(conflict)) writeFileSync(conflict, previous, { flag: 'wx', mode: 0o600 });
      }
    }
    const temporaryPath = `${path}.tmp-${process.pid}`;
    try { writeFileSync(temporaryPath, body, { mode: 0o600 }); renameSync(temporaryPath, path); }
    finally { if (existsSync(temporaryPath)) unlinkSync(temporaryPath); }
  }
  private flushVault(limit=Number.POSITIVE_INFINITY): void {
    let processed=0;
    for(const [key,job] of this.vaultJobs){
      if(processed++>=limit)break;
      try{this.publish(job);}catch(error){throw error instanceof VaultSyncError?error:new VaultSyncError(error);}
      if(this.vaultJobs.get(key)===job)this.vaultJobs.delete(key);
    }
  }

  /** Retry bounded pending projection work outside read snapshots and transactions. */
  reconcileVault():void {
    if(this.readDepth||this.depth)throw new Error('Vault reconciliation requires an idle Store.');
    this.flushVault(32);
  }

  private vaultEntity(table: Table, entity: Entities[Table]): Entities[Table] {
    if (table === 'sources') { const s = entity as Entities['sources']; return s.status === 'active' ? s : { ...s, title: '[withdrawn]', content: '', locator: `withdrawn:${s.id}` }; }
    if (table === 'cards') { const c = entity as Entities['cards']; return this.cardActive(c, c) ? c : { ...c, status: 'withdrawn', title: '[withdrawn]', body: '', quote: '', aliases: [], experience: undefined, locator: `withdrawn:${c.sourceId}` }; }
    if (table === 'rules') {
      const r = entity as Entities['rules'];
      if (r.status !== 'active' || r.citations.some(c => { const s = this.get('sources', c.sourceId); return s?.status !== 'active' || s.revision !== c.revision; })) return { ...r, status: 'suspended', title: '[withdrawn]', statement: '[Evidence no longer active]', conditions: '[withdrawn]', exceptions: '[withdrawn]', citations: r.citations.map(c => ({ ...c, quote: '[inactive]', locator: `withdrawn:${c.sourceId}` })) };
    }
    if (table === 'cases') { const c = entity as Entities['cases']; if (c.status !== 'active' || this.get('sources', c.sourceId)?.status !== 'active' || c.decisionSnapshot?.sourceRefs.some(ref => { const source = this.get('sources', ref.id); return source?.status !== 'active' || source.revision !== ref.revision; })) return { ...c, status: 'withdrawn', originalWords: '[withdrawn]', rationale: '[withdrawn]', alternatives: [], outcome: undefined, decisionSnapshot: undefined, outcomes: undefined }; }
    return entity;
  }

  private ordinarySourceIdentity(source: Entities['sources']): boolean {
    return ['file', 'feishu', 'github', 'conversation', 'manual', 'reading'].includes(source.kind)
      && typeof source.externalId === 'string' && !!source.externalId.trim()
      && source.id === stableId('source', { projectId: source.projectId, domain: source.domain }, source.kind, source.externalId, source.revision);
  }

  /** Missing rows must match a host-generated identity; editable classification is not authority. */
  private recoverableSourceIdentity(source: Entities['sources'], trustedQuestions: ReadonlyMap<string, Entities['questions']>): boolean {
    if (this.ordinarySourceIdentity(source)) return true;
    if (source.kind !== 'conversation' || typeof source.externalId !== 'string' || !source.externalId.startsWith('answer:')) return false;
    const question = trustedQuestions.get(source.externalId.slice('answer:'.length));
    if (!question || question.status !== 'answered' || !question.answer || source.id !== stableId('owner-answer', question.id)) return false;
    const project = this.get('projects', question.projectId), task = this.get('tasks', question.taskId);
    const primary = task && this.get('sources', task.sourceId);
    return !!project && !!task && !!primary && question.projectId === source.projectId && question.domain === source.domain
      && project.domain === source.domain && project.ownerId === question.ownerId && question.answer.actorId === project.ownerId
      && source.authorId === project.ownerId && task.projectId === source.projectId && task.domain === source.domain && task.version >= question.taskVersion
      && primary.status === 'active' && primary.revision === task.sourceRevision && primary.projectId === source.projectId && primary.domain === source.domain
      && source.retention === primary.retention && source.revision === digest(question.answer.text) && source.content === question.answer.text
      && source.locator === `question:${question.id}@${question.version}`;
  }

  /** Import only our structured card format; existing withdrawal records always win. */
  private recoverVault(): void {
    if (!this.vaultDir) return;
    // Capture authority before any editable projection can be written back into SQLite.
    const trustedSources = new Map(this.list('sources').map(source => [source.id, source]));
    const trustedQuestions = new Map(this.list('questions').map(question => [question.id, question]));
    let trustedTasks: Entities['tasks'][] | undefined;
    const trustedPaths = new Map<string, { id: string; revision: string }[]>();
    for (const table of vaultTables) for (const entity of this.list(table)) {
      const refs = table === 'sources' ? [{ id: entity.id, revision: (entity as Entities['sources']).revision }]
        : table === 'rules' ? (entity as Entities['rules']).citations.map(c => ({ id: c.sourceId, revision: c.revision }))
        : table === 'cards' ? [{ id: (entity as Entities['cards']).sourceId, revision: (entity as Entities['cards']).sourceRevision }]
        : [{ id: (entity as Entities['cases']).sourceId, revision: trustedSources.get((entity as Entities['cases']).sourceId)?.revision ?? '' }, ...((entity as Entities['cases']).decisionSnapshot?.sourceRefs ?? [])];
      trustedPaths.set(`vault:${relative(this.vaultDir, this.vaultPath(table, entity))}`, refs);
    }
    // Legacy SQLite rows have trustworthy path identities even when their projections were edited or removed.
    for (const source of trustedSources.values()) if (!source.parentSources && source.kind === 'file' && source.externalId.startsWith('vault:')) {
      const refs = trustedPaths.get(source.externalId);
      if (refs?.length && !refs.some(ref => ref.id === source.id)) {
        source.parentSources = refs; this.write('sources', source);
      }
    }
    const records: { table: Table; entity: Entities[Table]; path: string; text: string }[] = [];
    const walk = (directory: string) => {
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, item.name);
        if (item.isDirectory()) { walk(path); continue; }
        if (!item.isFile() || !item.name.endsWith('.md') || item.name.includes('.conflict-')) continue;
        const text = readFileSync(path, 'utf8'); const header = text.match(/^---\n([\s\S]*?)\n---\n/);
        if (!header) continue;
        const table = header[1]?.match(/^type: (\w+)$/m)?.[1] as Table;
        const json = header[1]?.match(/^patrick_entity: (.+)$/m)?.[1];
        if (!json || !vaultTables.has(table)) continue;
        try {
          const entity = JSON.parse(json) as Entities[Table];
          if (!entity.id || !entity.projectId || !entity.domain || this.vaultPath(table, entity) !== path) continue;
          records.push({ table, entity, path, text });
        } catch { /* A malformed human edit is preserved and never silently trusted. */ }
      }
    };
    walk(this.vaultDir);
    const order = ['sources', 'cases', 'cards', 'rules'];
    // Accepted answers depend on primary rows: finish ordinary source recovery first, regardless of filenames.
    const recoveryOrder = (record: typeof records[number]) => record.table === 'sources'
      ? this.ordinarySourceIdentity(record.entity as Entities['sources']) ? 0 : 1
      : order.indexOf(record.table) + 1;
    records.sort((a, b) => recoveryOrder(a) - recoveryOrder(b));
    const edits: typeof records = [];
    for (const record of records) {
      const { table, entity, path, text } = record;
      const existing = this.get(table, entity.id);
      let sourceEdited: boolean | undefined;
      if (existing && 'status' in existing && existing.status !== 'active') {this.publish({table,entity:existing},true);continue;}
      if (table === 'sources') {
        const s = entity as Entities['sources'];
        if (s.retention !== 'permanent' || typeof s.content !== 'string' || typeof s.revision !== 'string' || !['active', 'superseded', 'withdrawn'].includes(s.status)) continue;
        // Purpose normalization is recovery bookkeeping, not an independent content edit.
        sourceEdited = text !== this.markdown(table, entity);
        const canonical = trustedSources.get(s.id);
        s.parentSources = canonical?.parentSources;
        s.purpose = canonical ? canonical.purpose ?? 'task' : (trustedTasks ??= this.list('tasks')).some(task => task.sourceId === s.id && task.sourceRevision === s.revision && task.projectId === s.projectId && task.domain === s.domain) ? 'task' : 'reference';
        if (!canonical && (!this.recoverableSourceIdentity(s, trustedQuestions) || s.kind === 'file' && s.externalId.startsWith('vault:'))) {
          // Mismatched identities and copies without host provenance cannot recover readable material.
          s.status = 'withdrawn'; s.content = ''; s.title = '[withdrawn]'; s.locator = `withdrawn:${s.id}`; s.parentSources = []; s.purpose = 'reference'; sourceEdited = false;
        }
      }
      if (table === 'cards') {
        const c = entity as Entities['cards']; stripDerivedCardFields(c); const source = this.get('sources', c.sourceId);
        if (source && source.status !== 'active') { this.publish({ table, entity: this.vaultEntity(table, entity) }, true); continue; }
        if (!this.cardActive(c, c) || source?.retention !== 'permanent' || !source.content.includes(c.quote) || !Array.isArray(c.aliases) || !['reported', 'verified', 'inference'].includes(c.verification)) continue;
        // A recovered model card is never promoted to verified merely by its Markdown label.
        if (!existing && c.verification === 'verified') c.verification = 'reported';
        if (c.experience !== undefined) {
          const details = experienceDetailsSchema.safeParse(c.experience);
          if (c.kind === 'experience' && details.success && details.data.productId === c.projectId) {
            c.experience = details.data;
            c.aliases = [...new Set([...c.aliases, ...details.data.symptomAliases].map(value => value.trim()).filter(Boolean))];
          } else delete c.experience;
        }
      }
      if (table === 'cases') {
        const c = entity as Entities['cases']; const p = this.get('projects', c.projectId); const source = this.get('sources', c.sourceId); const q = this.get('questions', c.questionId);
        if (!p || c.actorId !== p.ownerId || source?.status !== 'active' || source.authorId !== p.ownerId || q?.status !== 'answered' || q.answer?.actorId !== p.ownerId || q.answer.text !== c.originalWords) continue;
      }
      if (table === 'rules') {
        const r = entity as Entities['rules'];
        if (!Array.isArray(r.citations) || !r.citations.length || r.citations.some(c => { const s = this.get('sources', c.sourceId); return s?.status !== 'active' || s.revision !== c.revision || s.projectId !== r.projectId || s.domain !== r.domain || !s.content.includes(c.quote); })) continue;
        if (r.kind === 'principle' && (!Array.isArray(r.caseIds) || !r.caseIds.length || r.caseIds.some(id => this.get('cases', id)?.status !== 'active'))) continue;
      }
      if (!existing) {
        if(table==='cards'&&isStructuredKnowledgeCard(entity as KnowledgeCard))this.save('cards',entity as KnowledgeCard);
        else this.write(table, entity);
      }
      if (sourceEdited ?? text !== this.markdown(table, entity)) { this.preserveVaultPaths.add(path); edits.push(record); }
    }
    for (const record of records) if (record.table === 'sources') {
      const source = this.get('sources', record.entity.id), project = source && this.get('projects', source.projectId);
      if (source && project && source.status === 'active' && source.domain === project.domain) enqueueStructuredKnowledge(this, source);
    }
    for (const record of edits) {
      if (!this.get('projects', record.entity.projectId)) continue;
      const content = record.text.replace(/^---\n[\s\S]*?\n---\n/, '');
      const externalId=`vault:${relative(this.vaultDir,record.path)}`,lineage=this.list('sources').filter(source=>source.projectId===record.entity.projectId&&source.domain===record.entity.domain&&source.kind==='file'&&source.externalId===externalId),current=lineage.find(source=>source.status==='active');
      if(current&&digest(current.content)===digest(content))continue;
      const revision=stableId('vault-occurrence',lineage.at(-1)?.id??'first',digest(content));
      // Source purpose was resolved from pre-recovery authority, never from editable frontmatter.
      const purpose=record.table==='sources'?(record.entity as Entities['sources']).purpose??'reference':'task';
      const parentSources = trustedPaths.get(`vault:${relative(this.vaultDir, record.path)}`)
        ?? (record.table === 'sources' ? [{ id: record.entity.id, revision: (record.entity as Entities['sources']).revision }] : []);
      if (parentSources.some(ref => { const parent = this.get('sources', ref.id); return parent?.status !== 'active' || parent.revision !== ref.revision; })) continue;
      try { ingestSource(this, { projects: [] }, { projectId: record.entity.projectId, kind: 'file', externalId,revision, title: `Vault edit: ${'title' in record.entity ? record.entity.title : record.entity.id}`, content, locator: record.path, retention: 'permanent',purpose }, parentSources); }
      catch(error) { if(isKnowledgeSnapshotFailure(error))throw error; /* Revoked/conflicting edits remain intact for explicit review. */ }
    }
  }
}
