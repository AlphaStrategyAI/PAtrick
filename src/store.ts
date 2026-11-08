import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, existsSync, renameSync, writeFileSync, unlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { DomainError, digest, experienceDetailsSchema, stableId, tokenize, type Entities, type KnowledgeCard, type Scope, type Table } from './domain.js';
import { canonicalExperiencePayloadSchema, factualContextTombstonePayloadSchema, knowledgeActionDependencies, knowledgeRequestSourceRefs, knowledgeSourceRefs, normalizationOriginPayloadSchema, validFactualContextTombstoneTransition, wellFormedParentSources } from './knowledge-records.js';
import { historicalSnapshot, ingestSource, normalizationTombstone, redactWithdrawnEvidence } from './intake.js';
import { enqueueStructuredKnowledge, isStructuredKnowledgeCard, structuredIngestJobSchema, structuredKnowledgeCardId, structuredKnowledgeJobId, validStructuredJobRefs } from './knowledge-jobs.js';
import { parseStructuredKnowledge, structuredRepositoryRequest } from './structured-knowledge.js';
import { knowledgeReference, stripDerivedCardFields } from './knowledge-use.js';
import type { KnowledgeReferenceOptions, KnowledgeView, TestObservation } from './knowledge-contract.js';
import { knowledgeCandidateHash } from './knowledge-identity.js';

const tables: Table[] = ['projects', 'sources', 'tasks', 'cards', 'rules', 'cases', 'questions', 'events', 'attempts', 'outbox', 'receipts', 'actions', 'cursors'];
const vaultTables = new Set<Table>(['sources', 'cards', 'rules', 'cases']);
type VaultJob = { table: Table; entity: Entities[Table]; previous?: Entities[Table]; redactStructuredCard?: boolean; redactTemporary?: boolean };
type TemporaryEntry = { entity: Entities[Table]; privacyInvalidated?: true; missingJobCardId?: string; normalizationTransient?: true; restoredLineage?: true; caseAwaitingRules?: true };
type OpaqueSourceIdentity = {version:1;externalId:string;revision:string;authorId:string;locator:string;parents?:{id:string;revision:string}[]|null};
type StoredSource = Entities['sources'] & {__hostOpaqueIdentity?:OpaqueSourceIdentity};
type OpaqueActionBinding = {version:1;sourceId:string;revision:string;refs?:{id:string;revision:string}[]};
type StoredAction = Entities['actions'] & {__hostOpaqueHold?:OpaqueActionBinding};
type VaultRedaction = {table:'sources'|'cards'|'rules'|'cases';id:string} & ({version:1}|{version:2;origin:string|null}|{version:3;origins:string[]});
type RetentionResolution = {scope:Scope;sources:Map<string,Entities['sources']>;resolved:Map<string,boolean>;affected:Set<string>};
type ExperienceActionQuery = {scope?:Scope;cardId?:string;observationId?:string;revision?:string;after?:string;file?:string};
type IdGroups={keys:Map<string,Set<string>>;byId:Map<string,string[]>};
type OperationGroups={hosts:Map<string,IdGroups>;observations:Map<string,IdGroups>;knowledgeLinks:Map<string,IdGroups>;temporary?:IdGroups};
type MutationFrame={hostScopes:Set<string>;observationScopes:Set<string>;knowledgeLinkScopes:Set<string>;temporary:boolean};
type VaultCopyOptions={vaultCopyFrom?:string;restoringSnapshot?:boolean};
const newGroups=():IdGroups=>({keys:new Map(),byId:new Map()});
const newOperation=():OperationGroups=>({hosts:new Map(),observations:new Map(),knowledgeLinks:new Map()});
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
export class PrivacyCheckpointError extends DomainError {
  readonly committed=true;
  constructor(){super('The change committed, but temporary-data cleanup is waiting for an open database reader.','privacy_checkpoint_unavailable',503);this.name='PrivacyCheckpointError';}
}
export function isKnowledgeSnapshotFailure(error:unknown):boolean {
  if(error instanceof VaultSyncError)return isKnowledgeSnapshotFailure(error.cause);
  if(!error||typeof error!=='object'||!('code' in error))return false;
  const code=(error as {code?:unknown}).code;
  return code==='knowledge_snapshot_unavailable'||code==='privacy_checkpoint_unavailable'||typeof code==='string'&&/^SQLITE_(?:(?:BUSY|LOCKED)(?:_|$)|SCHEMA$)/.test(code);
}
function snapshotError(error:unknown):unknown {
  return isKnowledgeSnapshotFailure(error)&&!(error instanceof VaultSyncError)&&!(error instanceof DomainError&&['knowledge_snapshot_unavailable','privacy_checkpoint_unavailable'].includes(error.code))
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

// Hash exactly the Markdown files copied into backups, without following links.
function vaultFingerprint(root:string):string {
  const entries:{path:string;sha256:string}[]=[];
  const walk=(directory:string):void=>{
    for(const item of readdirSync(directory,{withFileTypes:true})){
      const path=join(directory,item.name);
      if(item.isSymbolicLink())throw new Error('Vault contains a symbolic link.');
      if(item.isDirectory())walk(path);
      else if(!item.isFile())throw new Error('Vault contains a non-file entry.');
      else if(path.endsWith('.md')&&!path.includes('.tmp-'))entries.push({path:relative(root,path).split('\\').join('/'),sha256:createHash('sha256').update(readFileSync(path)).digest('hex')});
    }
  };
  walk(root);entries.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);return digest(entries);
}

function vaultOrigin(directory:string):string {
  const path=realpathSync(directory),stat=statSync(path);
  return digest({path,dev:stat.dev,ino:stat.ino});
}
function readVaultRedaction(cursor:Entities['cursors']):VaultRedaction {
  let intent:VaultRedaction;
  try{intent=JSON.parse(cursor.value) as VaultRedaction;}catch{throw new Error('Invalid durable Vault redaction intent.');}
  if(!intent||![1,2,3].includes(intent.version)||!['sources','cards','rules','cases'].includes(intent.table)||typeof intent.id!=='string'||!intent.id||cursor.id!==`vault-redaction:${stableId('vault-redaction',cursor.projectId,cursor.domain,intent.table,intent.id)}`||
    intent.version===2&&intent.origin!==null&&(typeof intent.origin!=='string'||!/^[a-f0-9]{64}$/.test(intent.origin))||
    intent.version===3&&(!Array.isArray(intent.origins)||!intent.origins.length||new Set(intent.origins).size!==intent.origins.length||intent.origins.some(origin=>typeof origin!=='string'||!/^[a-f0-9]{64}$/.test(origin))))throw new Error('Invalid durable Vault redaction intent.');
  return intent;
}
function vaultOriginClear(db:Database.Database,origin:string):boolean {
  const rows=db.prepare("SELECT data FROM cursors WHERE id LIKE 'vault-redaction:%'").all() as {data:string}[];
  for(const row of rows){
    const intent=readVaultRedaction(JSON.parse(row.data) as Entities['cursors']);
    if(intent.version===1||intent.version===2&&(!intent.origin||intent.origin===origin)||intent.version===3&&intent.origins.includes(origin))return false;
  }
  return true;
}
function assertVaultBackup(db:Database.Database,selectedVault:string):{origin:string;known:boolean} {
  const unavailable=()=>new DomainError('Vault privacy cleanup cannot be verified for this location.','vault_cleanup_unavailable',503);
  let origin:string;
  try{origin=vaultOrigin(selectedVault);}catch{throw unavailable();}
  const known=db.prepare('SELECT verified FROM vault_origins WHERE origin = ?').get(origin) as {verified:number}|undefined;
  const uncertain=!!db.prepare("SELECT 1 FROM vault_state WHERE key IN ('redaction_history','origin_history_incomplete') LIMIT 1").get();
  if(known?.verified===0||!known&&uncertain||!vaultOriginClear(db,origin))throw unavailable();
  return {origin,known:!!known};
}
/** Read-only backup source for an already running host. */
export function openReadOnlyBackupSource(databasePath:string):{backup(destination:string):Promise<void>;prepareVaultBackup(vault?:string):void;close():void} {
  const db=new Database(databasePath,{readonly:true,fileMustExist:true});
  return {backup:async destination=>{await db.backup(destination);},prepareVaultBackup:vault=>{if(vault)assertVaultBackup(db,vault);},close:()=>db.close()};
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
  private privacyCheckpointPending=false;
  private retentionResolution?:RetentionResolution;

  constructor(databasePath: string, private readonly vaultDir?: string, options:VaultCopyOptions={}) {
    if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
    if (vaultDir) mkdirSync(vaultDir, { recursive: true });
    this.db = new Database(databasePath);
    try{
    const existingLedger=!!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='sources'").get();
    const existingOrigins=!!this.db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='vault_projection_origins'").get();
    // The old schema needs its function until its two exact indexes are removed.
    this.db.function('knowledge_host_root_key',{deterministic:true},hostRootKey);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // Private search terms stay in SQLite's connection-local memory only.
    this.db.pragma('temp_store = MEMORY');
    // Source retention changes must not leave removed private canonical bytes in free pages.
    this.db.pragma('secure_delete = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrateLegacyHostIndexes();
    for (const table of tables) this.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, domain TEXT NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ${table}_scope ON ${table}(project_id, domain)`);
    this.db.exec('CREATE TABLE IF NOT EXISTS vault_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    this.db.transaction(()=>{
      this.db.exec('CREATE TABLE IF NOT EXISTS vault_origins (origin TEXT PRIMARY KEY, verified INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS vault_projection_origins (id TEXT NOT NULL, origin TEXT NOT NULL, projected INTEGER NOT NULL, PRIMARY KEY(id,origin))');
      if(existingLedger&&!existingOrigins){
        this.db.prepare("INSERT OR IGNORE INTO vault_state(key,value) VALUES ('origin_history_incomplete','1')").run();
        const previous=this.lastVaultOrigin();
        if(previous){
          // The old last-origin value identifies a root, but cannot prove its history is clean.
          this.db.prepare('INSERT OR IGNORE INTO vault_origins(origin,verified) VALUES (?,0)').run(previous);
          const remember=this.db.prepare('INSERT OR IGNORE INTO vault_projection_origins(id,origin,projected) VALUES (?,?,1)');
          for(const table of vaultTables)for(const row of this.db.prepare(`SELECT id,project_id,domain FROM ${table}`).all() as {id:string;project_id:string;domain:string}[])
            remember.run(this.vaultRedactionId({table:table as VaultRedaction['table'],id:row.id},{projectId:row.project_id,domain:row.domain}),previous);
        }
      }
    })();
    if(vaultDir&&options.vaultCopyFrom)this.bindVaultCopy(options.vaultCopyFrom,vaultDir);
    if(vaultDir&&options.restoringSnapshot)this.bindSnapshotVault(vaultDir);
    if(vaultDir)this.registerAttachedVault();
    this.db.exec(`CREATE INDEX IF NOT EXISTS actions_experience_card ON actions(json_extract(data,'$.kind'),project_id,domain,coalesce(json_extract(data,'$.payload.association.cardId'),json_extract(data,'$.payload.normalizationOrigin.cardId')));
      CREATE INDEX IF NOT EXISTS actions_experience_revision ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.observation.snapshot.revision'),json_extract(data,'$.payload.observation.observedAt'));
      CREATE INDEX IF NOT EXISTS actions_experience_time ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.observation.observedAt'));
      CREATE INDEX IF NOT EXISTS actions_host_binding ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.sourceHash'),json_extract(data,'$.payload.requestHash'),json_extract(data,'$.payload.observation.claim.kind'),json_extract(data,'$.payload.observation.origin.originalEventId'));
      CREATE INDEX IF NOT EXISTS actions_host_root ON actions(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.payload.observation.origin.originalEventId'));
      CREATE INDEX IF NOT EXISTS cards_experience_revision ON cards(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.experience.codeVersion'));
      CREATE INDEX IF NOT EXISTS cards_experience_target ON cards(json_extract(data,'$.kind'),project_id,domain,json_extract(data,'$.experience.codeVersion'),json_extract(data,'$.experience.files[0]'))`);
    this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(id UNINDEXED, project_id UNINDEXED, domain UNINDEXED, terms, tokenize='unicode61')");
    this.db.exec("CREATE VIRTUAL TABLE temp.cards_search_fts USING fts5(id UNINDEXED, project_id UNINDEXED, domain UNINDEXED, terms, tokenize='unicode61')");
    this.db.prepare('INSERT INTO cards_fts(cards_fts,rank) VALUES (?,1)').run('secure-delete');
    // Finish committed redactions before any editable Vault projection is read.
    this.flushVault();
    // Remember an attached Vault for cleanup committed while no Vault is attached.
    if(vaultDir&&!this.db.prepare("SELECT 1 FROM cursors WHERE id LIKE 'vault-redaction:%' LIMIT 1").get())
      this.db.prepare("INSERT INTO vault_state(key,value) VALUES ('origin',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(this.attachedVaultOrigin());
    // Migrate any pre-existing temporary ancestry before editable Vault content is read.
    this.transaction(()=>this.protectTemporarySourceDependents(false,true));
    // An old root may be certified only against pre-recovery host ledger content.
    this.certifyLegacyVault();
    // Read the Vault before projecting SQLite, so an independent edit is never overwritten at startup.
    this.recoverVault();
    this.transaction(()=>{this.protectTemporarySourceDependents(false);this.protectTemporaryKnowledgeActions(false);});
    this.protectTemporaryStructuredCards();
    this.flushVault();
    this.transaction(() => { for (const source of this.list('sources')) if (source.status === 'withdrawn') {redactWithdrawnEvidence(this, source.id);this.privacyCheckpointPending=true;} });
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
  /** Select a single action kind without scanning unrelated ledger records. */
  actionsOfKind(kind: string): Entities['actions'][] {
    const rows = this.db.prepare("SELECT data FROM actions WHERE json_extract(data,'$.kind') = ? ORDER BY rowid").all(kind) as { data: string }[];
    const result = new Map(rows.map(row => { const action = this.visible('actions', JSON.parse(row.data) as Entities['actions']) as Entities['actions']; return [action.id, action]; }));
    for (const [key, entry] of this.temporary) if (key.startsWith('actions:')) {
      const action = this.visible('actions', structuredClone(entry.entity)) as Entities['actions'];
      if (action.kind === kind) result.set(action.id, action); else result.delete(action.id);
    }
    return [...result.values()];
  }
  private listScope<K extends Table>(table:K,scope:Scope,bindings?:Map<string,OpaqueSourceIdentity|undefined>):Entities[K][] {
    this.assertTable(table);
    const rows=this.db.prepare(`SELECT data FROM ${table} WHERE project_id = ? AND domain = ? ORDER BY rowid`).all(scope.projectId,scope.domain) as {data:string}[];
    const result=new Map(rows.map(row=>{const stored=JSON.parse(row.data) as Entities[Table];if(bindings&&table==='sources')bindings.set(stored.id,this.validOpaqueSourceIdentity((stored as StoredSource).__hostOpaqueIdentity));const entity=this.visible(table,stored) as Entities[K];return [entity.id,entity];}));
    for(const [key,entry] of this.temporary)if(key.startsWith(`${table}:`)){
      const value=entry.entity as Entities[K];
      if(value.projectId===scope.projectId&&value.domain===scope.domain)result.set(value.id,this.visible(table,structuredClone(value)) as Entities[K]);else result.delete(value.id);
    }
    return [...result.values()];
  }
  private withRetentionResolution<T>(scope:Entities['sources'],run:()=>T):T {
    const prior=this.retentionResolution;
    const bindings=new Map<string,OpaqueSourceIdentity|undefined>();
    const sources=new Map(this.listScope('sources',scope,bindings).map(source=>[source.id,source])),reverse=new Map<string,string[]>();
    const link=(parent:string,child:string)=>{const children=reverse.get(parent)??[];children.push(child);reverse.set(parent,children);};
    for(const source of sources.values()){
      const binding=bindings.get(source.id),parents=Array.isArray(binding?.parents)?binding.parents:source.parentSources;
      if(Array.isArray(parents))for(const ref of parents)if(ref&&typeof ref.id==='string')link(ref.id,source.id);
      const task=this.ownerAnswerTask(source);if(task)link(task.sourceId,source.id);
    }
    const affected=new Set([scope.id]),pending=[scope.id];
    while(pending.length)for(const child of reverse.get(pending.pop()!)??[])if(!affected.has(child)){affected.add(child);pending.push(child);}
    this.retentionResolution={scope,sources,resolved:new Map(),affected};
    try{return run();}finally{this.retentionResolution=prior;}
  }

  private scopeKey(scope:Scope):string {return groupKey(scope.projectId,scope.domain);}
  private actionKeys(action:Entities['actions'],scope:Scope=action):string[] {
    const scoped=this.scopeKey(scope),kind=action.kind,keys=[groupKey('kind',kind),groupKey('kind-scope',kind,scoped)];
    const payload=action.payload as {sourceHash?:unknown;requestHash?:unknown;association?:{cardId?:unknown;observationId?:unknown};link?:{cardId?:unknown};normalizationOrigin?:{cardId?:unknown};observation?:{claim?:{kind?:unknown};snapshot?:{files?:unknown;revision?:unknown};observedAt?:unknown}}|null;
    if(kind==='knowledge.host-observation'){
      const root=hostRoot(action);
      keys.push(identifiableHostRoot(root)?groupKey('host-root',scoped,root):groupKey('host-unrooted',scoped));
      if(typeof payload?.sourceHash==='string'&&typeof payload.requestHash==='string'&&typeof payload.observation?.claim?.kind==='string'){
        const binding=[scoped,payload.sourceHash,payload.requestHash,payload.observation.claim.kind];
        keys.push(groupKey('host-binding',...binding));
        if(identifiableHostRoot(root))keys.push(groupKey('host-binding-root',...binding,root));
      }
    }
    if(kind==='knowledge.evidence-link'&&typeof payload?.link?.cardId==='string')keys.push(groupKey('knowledge-link-card',scoped,payload.link.cardId));
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
    if(key.startsWith('cards:'))this.indexSearchOverlay(entry.entity as KnowledgeCard);
  }
  private deleteTemporary(key:string):void {
    if(this.operation?.temporary)updateGroups(this.operation.temporary,key,[]);
    const frame=this.mutationFrames.at(-1);if(frame&&this.temporary.has(key))frame.temporary=true;
    this.temporary.delete(key);
    if(key.startsWith('cards:')){
      const id=key.slice('cards:'.length);this.db.prepare('DELETE FROM temp.cards_search_fts WHERE id = ?').run(id);
      this.db.prepare('INSERT INTO temp.cards_search_fts(id,project_id,domain,terms) SELECT id,project_id,domain,terms FROM main.cards_fts WHERE id = ?').run(id);
    }
  }
  private scopedActionGroups(kind:'knowledge.host-observation'|'experience.test-observation'|'knowledge.evidence-link',scope:Scope):IdGroups {
    const operation=this.operation;if(!operation)throw new Error('Discovery requires an operation.');
    const scopeKey=this.scopeKey(scope),scopes=kind==='knowledge.host-observation'?operation.hosts:kind==='knowledge.evidence-link'?operation.knowledgeLinks:operation.observations;
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
  /** Resolve only links for this card, within the current coherent Store operation. */
  knowledgeEvidenceActions(scope:Scope,cardId:string):Entities['actions'][] {
    return this.readSnapshot(()=>{const key=groupKey('knowledge-link-card',this.scopeKey(scope),cardId);return [...this.selectedActions(this.scopedActionGroups('knowledge.evidence-link',scope),key),...this.selectedActions(this.temporaryGroups(),key,true)].map(item=>item.row);});
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
    if(!this.depth&&(table==='sources'||table==='actions'||table==='rules'||table==='cases'||table==='cards'&&this.temporary.get(`cards:${entity.id}`)?.normalizationTransient)){this.transaction(()=>this.save(table,entity));return;}
    this.assertTable(table);
    const previous = this.get(table, entity.id);
    if(table==='sources'&&previous&&(previous as Entities['sources']).status!=='withdrawn'&&(entity as Entities['sources']).status==='withdrawn'&&!(entity as Entities['sources']).content)this.privacyCheckpointPending=true;
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
    // This tag belongs to the host's durable row, never to a producer or Vault edit.
    if(table==='sources')delete (value as StoredSource).__hostOpaqueIdentity;
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
    // Sanitized metadata inherits the prior row's temporary lifetime.
    if(table==='actions'){
      const action=value as Entities['actions'],audit=action.kind==='knowledge.factual-context'&&factualContextTombstonePayloadSchema.safeParse(action.payload).success;
      if((this.temporary.has(key)&&normalizationOriginPayloadSchema.safeParse(action.payload).success)||
        (audit&&(this.temporary.has(key)||!validFactualContextTombstoneTransition(previous as Entities['actions']|undefined,action)))){
        this.setTemporary(key,{entity:value});this.deleteAction(entity.id);return;
      }
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
    if (table === 'sources' && this.temporarySource(value as Entities['sources'])) {
      if(previous&&!this.temporary.has(key))this.privacyCheckpointPending=true;
      const restoredLineage=this.temporary.get(key)?.restoredLineage||!!previous&&!(previous as Entities['sources']).content&&this.sourceHasOpaqueIdentity(previous as Entities['sources']);
      this.setTemporary(key, {entity:value,...(restoredLineage?{restoredLineage:true as const}:{})});
      this.write(table, this.redactTemporarySource(value as Entities['sources']) as Entities[K]);
      this.queueTemporaryRedaction(table,value);
      this.withRetentionResolution(value as Entities['sources'],()=>{this.protectTemporarySourceDependents(true,false,value);this.protectTemporaryKnowledgeActions(true,value);this.protectTemporaryStructuredCards(value);});
      if (!this.depth) this.flushVault();
      return;
    }
    if (this.isTemporaryDerived(table, value)) {
      const prior=this.temporary.get(key);
      this.setTemporary(key, {entity:value,...(unknown&&!inactive?{privacyInvalidated:true as const}:{}),...(missingJobCard?{missingJobCardId:entity.id}:{}),...(table==='cases'&&this.mayDeferMissingCaseDependencies(value as Entities['cases'],false)?{caseAwaitingRules:true as const}:{})});
      if(table === 'actions'){
        const hold=this.durableReadHold(value as Entities['actions'])??this.durableOrdinaryClassification(value as Entities['actions']);
        if(hold){this.write('actions',hold);this.deleteTemporary(key);}else if(['decision.evidence','decision.review'].includes((value as Entities['actions']).kind))this.write('actions',this.redactTemporary('actions',value) as Entities['actions']);else this.deleteAction(entity.id);
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
      else if(table==='cards'||table==='rules'||table==='cases'){
        const durable=this.db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(entity.id);
        if(durable){
          this.privacyCheckpointPending=true;this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(entity.id);
          if(table==='cards')this.db.prepare('DELETE FROM cards_fts WHERE id = ?').run(entity.id);
          this.queueTemporaryRedaction(table,value);
        }
      }
      return;
    }
    if (this.isTemporaryTaskEntity(table, value)) {
      this.setTemporary(key, {entity:value});
      this.write(table, this.redactTemporary(table, value) as Entities[K]);
      return;
    }
    this.deleteTemporary(key);
    if(table==='sources'&&(value as Entities['sources']).status==='withdrawn'){
      const prior=previous as Entities['sources']|undefined;
      const binding=this.opaqueSourceIdentity(entity.id)??(prior?.content&&prior.status!=='withdrawn'?this.bindOpaqueSource(prior):undefined);
      this.write(table,{...value,...(binding?{__hostOpaqueIdentity:binding}:{})} as Entities[K]);
    }else this.write(table, value);
    if(table==='actions'&&((value as Entities['actions']).kind==='knowledge.structured-ingest'||(previous as Entities['actions']|undefined)?.kind==='knowledge.structured-ingest')){this.protectTemporaryStructuredCards();if(!this.depth)this.flushVault();}
    if (table === 'cards') this.indexCard(value as KnowledgeCard);
    if (table === 'sources') {
      const source = value as Entities['sources'];
      this.withRetentionResolution(source,()=>{this.protectTemporaryKnowledgeActions(true,source);this.protectTemporaryStructuredCards(source);});
      if (source.status !== 'active') this.db.prepare('DELETE FROM cards_fts WHERE id IN (SELECT json_extract(data, \'$.id\') FROM cards WHERE json_extract(data, \'$.sourceId\') = ?)').run(source.id);
    }
    if (vaultTables.has(table)) {
      // Withdrawn projections and descendants must be cleaned in every recorded Vault.
      if(table==='sources'&&(value as Entities['sources']).status==='withdrawn'||previous&&'status' in previous&&previous.status==='active'&&'status' in value&&value.status!=='active')this.queueTemporaryRedaction(table,value);
      else this.vaultJobs.set(key, { table, entity: value, previous });
      // Owner decisions are recorded before their new rule; revisit only cases
      // waiting on this rule once all their real dependencies are permanent.
      if(table==='rules')this.promoteResolvedCases(entity.id);
      if (!this.depth) this.flushVault();
    }
  }

  delete(table: Table, id: string): void {
    if(this.readDepth)throw new Error('Store read snapshots cannot mutate state.');
    if(!this.depth&&(table==='actions'||table==='sources')){this.transaction(()=>this.delete(table,id));return;}
    this.assertTable(table); const entity = this.get(table, id);
    if(table==='sources'&&entity){
      const source=entity as Entities['sources'];
      const dependent=this.list('sources').some(child=>child.id!==id&&(child.status==='active'||!!child.content)&&child.projectId===source.projectId&&child.domain===source.domain&&
        (Array.isArray(child.parentSources)&&child.parentSources.some(ref=>ref&&ref.id===id)||this.ownerAnswerTask(child)?.sourceId===id));
      if(dependent)throw new DomainError('This source has active dependents and cannot be removed.','source_has_dependents',409);
    }
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
    const previousJobs = new Map(this.vaultJobs); const previousTemporary = new Map(this.temporary);const previousCheckpoint=this.privacyCheckpointPending;
    const frame:MutationFrame={hostScopes:new Set(),observationScopes:new Set(),knowledgeLinkScopes:new Set(),temporary:false};this.mutationFrames.push(frame);
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
      this.privacyCheckpointPending=previousCheckpoint;
      if(outer)this.operation=undefined;
      else if(this.operation){for(const scope of frame.hostScopes)this.operation.hosts.delete(scope);for(const scope of frame.observationScopes)this.operation.observations.delete(scope);for(const scope of frame.knowledgeLinkScopes)this.operation.knowledgeLinks.delete(scope);if(frame.temporary)this.operation.temporary=undefined;}
      throw preserveRawError?error:snapshotError(error);
    }
    this.depth--;
    this.mutationFrames.pop();
    const parent=this.mutationFrames.at(-1);if(parent){for(const scope of frame.hostScopes)parent.hostScopes.add(scope);for(const scope of frame.observationScopes)parent.observationScopes.add(scope);for(const scope of frame.knowledgeLinkScopes)parent.knowledgeLinkScopes.add(scope);parent.temporary||=frame.temporary;}
    if(outer)this.operation=undefined;
    if (!this.depth) {
      let failure:unknown;
      try{this.flushVault();}catch(error){failure=error;}
      try{this.checkpointPrivacy();}catch(error){failure??=error;}
      if(failure)throw failure;
    }
    return result;
  }

  private checkpointPrivacy():void {
    if(!this.privacyCheckpointPending)return;
    const result=this.db.pragma('wal_checkpoint(TRUNCATE)') as {busy:number}[];
    if(result.some(row=>row.busy))throw new PrivacyCheckpointError();
    this.privacyCheckpointPending=false;
  }

  searchCards(query: string, scope: Scope, limit = 20, options: KnowledgeReferenceOptions = {}): KnowledgeView[] {
    return this.readSnapshot(()=>this.searchCardsInSnapshot(query,scope,limit,options));
  }
  private searchCardsInSnapshot(query: string, scope: Scope, limit: number, options: KnowledgeReferenceOptions): KnowledgeView[] {
    const terms = tokenize(query).split(' ').filter(Boolean);
    if (!terms.length) return [];
    const match = [...new Set(terms)].map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ');
    const maximum=Number.isFinite(limit)?Math.max(1,Math.min(100,Math.floor(limit))):20,results:KnowledgeView[]=[];
    const statement=this.db.prepare('SELECT id FROM temp.cards_search_fts WHERE cards_search_fts MATCH ? AND project_id = ? AND domain = ? ORDER BY bm25(cards_search_fts), id LIMIT 100 OFFSET ?');
    for(let offset=0;results.length<maximum;offset+=100){
      const rows=statement.all(match,scope.projectId,scope.domain,offset);
      for(const row of rows){if(!row||typeof row!=='object'||!('id' in row)||typeof row.id!=='string')continue;const card=this.get('cards',row.id);if(!card||!this.cardActive(card,scope))continue;const view=knowledgeReference(this,card,scope,options);if(view)results.push(view);if(results.length===maximum)break;}
      if(rows.length<100)break;
    }
    return results;
  }

  indexCard(card: KnowledgeCard): void {
    if(this.readDepth)throw new Error('Store read snapshots cannot mutate state.');
    this.db.prepare('DELETE FROM cards_fts WHERE id = ?').run(card.id);
    this.indexSearchOverlay(card);
    if (!this.cardActive(card, card) || this.isTemporaryDerived('cards',card)) return;
    this.db.prepare('INSERT INTO cards_fts(id, project_id, domain, terms) VALUES (?, ?, ?, ?)').run(card.id, card.projectId, card.domain, this.cardSearchTerms(card));
  }
  private cardSearchTerms(card:KnowledgeCard):string {return tokenize([card.title,card.aliases.join(' '),card.experience?.problem??'',card.experience?.symptomAliases.join(' ')??'',card.body,card.quote].join(' '));}
  private indexSearchOverlay(card:KnowledgeCard):void {
    this.db.prepare('DELETE FROM temp.cards_search_fts WHERE id = ?').run(card.id);
    if(this.cardActive(card,card))this.db.prepare('INSERT INTO temp.cards_search_fts(id,project_id,domain,terms) VALUES (?,?,?,?)').run(card.id,card.projectId,card.domain,this.cardSearchTerms(card));
  }

  rebuildIndex(): void {
    if(this.readDepth)throw new Error('Store read snapshots cannot mutate state.');
    this.flushVault();this.checkpointPrivacy();
    this.recoverVault();
    this.db.transaction(() => { this.db.exec('DELETE FROM cards_fts; DELETE FROM temp.cards_search_fts'); for (const card of this.list('cards')) this.indexCard(card); })();
  }

  async backup(destination: string): Promise<void> { this.flushVault();this.checkpointPrivacy();mkdirSync(dirname(destination), { recursive: true }); await this.db.backup(destination); }
  vaultDirectory():string|undefined{return this.vaultDir;}
  prepareVaultBackup(selectedVault?:string):void {
    if(!selectedVault)return;
    if(this.vaultDir&&resolve(this.vaultDir)===resolve(selectedVault)){this.flushVault();this.checkpointPrivacy();}
    const {origin,known}=assertVaultBackup(this.db,selectedVault);
    if(!known)this.db.prepare('INSERT INTO vault_origins(origin,verified) VALUES (?,1)').run(origin);
  }
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
      if(kind==='knowledge.evidence-link')frame?.knowledgeLinkScopes.add(scope);
    }
    for(const groups of [...operation.hosts.values(),...operation.observations.values(),...operation.knowledgeLinks.values()])if(previous)updateGroups(groups,previous.id,[]);
    if(next){const scope=this.scopeKey(next);
      if(next.kind==='knowledge.host-observation'){const groups=operation.hosts.get(scope);if(groups)updateGroups(groups,next.id,this.actionKeys(next));}
      if(next.kind==='experience.test-observation'){const groups=operation.observations.get(scope);if(groups)updateGroups(groups,next.id,this.actionKeys(next));}
      if(next.kind==='knowledge.evidence-link'){const groups=operation.knowledgeLinks.get(scope);if(groups)updateGroups(groups,next.id,this.actionKeys(next));}
    }
  }
  private deleteAction(id:string):void {
    const previous=this.rawAction(id);this.db.prepare('DELETE FROM actions WHERE id = ?').run(id);this.actionChanged(previous,undefined);
  }
  private assertTable(table: string): void { if (!tables.includes(table as Table)) throw new Error('Unknown entity table.'); }
  private visible(table:Table,entity:Entities[Table]):Entities[Table] {
    if(table==='sources'){
      const stored=entity as StoredSource,{__hostOpaqueIdentity:_private,...source}=stored;
      const entry=this.temporary.get(`sources:${source.id}`);
      if((!source.content||entry?.restoredLineage)&&Array.isArray(source.parentSources)){
        const parents=this.opaqueSourceIdentity(source.id)?.parents;
        const refs=source.parentSources.map((ref,index)=>{
          const bound=Array.isArray(parents)?parents[index]:undefined;
          const opaque={id:ref.id,revision:{kind:'host-opaque-parent',digest:bound?.revision??''}};
          if(!source.content||!entry?.restoredLineage||!bound||bound.id!==ref.id||ref.id===source.id)return opaque;
          const parent=this.get('sources',ref.id);
          return parent?.content&&parent.status==='active'&&parent.projectId===source.projectId&&parent.domain===source.domain&&digest(parent.revision)===bound.revision?{id:ref.id,revision:parent.revision}:opaque;
        });
        return {...source,parentSources:refs as unknown as Entities['sources']['parentSources']};
      }
      return source;
    }
    if(table==='cards'){
      const card=entity as KnowledgeCard;
      if(isStructuredKnowledgeCard(card)&&cardExpired(card))return this.structuredCardTombstone(card);
    }
    if(table==='actions'){
      const stored=entity as StoredAction,{__hostOpaqueHold:binding,...action}=stored,payload=action.payload;
      if(!payload||typeof payload!=='object'||Array.isArray(payload))return action;
      if(binding?.version===1&&typeof binding.sourceId==='string'&&typeof binding.revision==='string'){
        const source=this.retentionResolution?.sources.get(binding.sourceId)??this.get('sources',binding.sourceId);
        if(!source?.content||digest(source.revision)!==binding.revision)return action;
        const restore=(ref:{id:string;revision:string},index:number)=>{
          const bound=binding.refs?.[index],dependency=this.retentionResolution?.sources.get(ref.id)??this.get('sources',ref.id);
          return bound?.id===ref.id&&dependency?.content&&digest(dependency.revision)===bound.revision?{...ref,revision:dependency.revision}:{...ref,revision:{kind:'host-opaque-revision'}};
        };
        const parsed=action.kind==='knowledge.structured-ingest'&&structuredIngestJobSchema.safeParse(payload);
        if(parsed&&parsed.success){const job=parsed.data;return {...action,payload:{...job,sourceRevision:source.revision,sourceRefs:job.sourceRefs.map(restore),...(job.readHold?{readHold:{...job.readHold,sourceHashes:job.readHold.sourceHashes.map(restore)}}:{})}} as Entities['actions'];}
        return {...action,payload:{...payload,sourceRevision:source.revision}};
      }
      return action;
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
    if(table==='cases'){
      const value=entity as Entities['cases'];
      if(this.temporarySourceDependency(value.sourceId,value))return true;
      if(value.decisionSnapshot&&(!this.validCaseSnapshot(value)||value.decisionSnapshot.sourceRefs.some(ref=>this.temporarySourceDependency(ref.id,value,ref.revision))))return true;
      if(!Array.isArray(value.ruleIds))return true;
      return value.ruleIds.some(id=>{const rule=this.get('rules',id);return !rule||rule.projectId!==value.projectId||rule.domain!==value.domain||this.isTemporaryDerived('rules',rule);});
    }
    if ('sourceId' in entity) return this.temporarySourceDependency(entity.sourceId,entity);
    if ('citations' in entity) return entity.citations.some(c => this.temporarySourceDependency(c.sourceId,entity,c.revision));
    return false;
  }
  private promoteResolvedCases(ruleId:string):void {
    for(const [key,entry] of [...this.temporary]){
      if(!key.startsWith('cases:')||!entry.caseAwaitingRules)continue;
      const value=entry.entity as Entities['cases'];
      if(value.status!=='active'||!Array.isArray(value.ruleIds)||!value.ruleIds.includes(ruleId)||this.isTemporaryDerived('cases',value))continue;
      const active=(id:string,revision?:string)=>{const source=this.get('sources',id);return !!source&&source.status==='active'&&source.projectId===value.projectId&&source.domain===value.domain&&(revision===undefined||source.revision===revision)&&!!knowledgeSourceRefs(this,id,value);};
      if(!active(value.sourceId)||value.decisionSnapshot?.sourceRefs.some(ref=>!active(ref.id,ref.revision)))continue;
      if(value.ruleIds.some(id=>{const rule=this.get('rules',id);return !rule||rule.status!=='active'||!Array.isArray(rule.citations)||rule.citations.some(c=>!active(c.sourceId,c.revision));}))continue;
      this.save('cases',value);
    }
  }

  // Startup may encounter genuinely missing rows which the same authorized
  // recovery pass can restore. Every dependency already present must be valid.
  private mayDeferMissingCaseDependencies(value:Entities['cases'],allowMissingSources=true):boolean {
    if(!Array.isArray(value.ruleIds)||value.decisionSnapshot&&!this.validCaseSnapshot(value))return false;
    let missing=false;
    const available=(id:string,revision?:string)=>{
      const source=this.get('sources',id);if(!source){if(!allowMissingSources)return false;missing=true;return true;}
      const ownerTask=this.ownerAnswerTask(source);
      if(allowMissingSources&&ownerTask&&!this.get('sources',ownerTask.sourceId)){missing=true;return true;}
      return source.status==='active'&&!this.temporarySourceDependency(id,value,revision)&&!!knowledgeSourceRefs(this,id,value);
    };
    if(!available(value.sourceId))return false;
    if(value.decisionSnapshot?.sourceRefs.some(ref=>!available(ref.id,ref.revision)))return false;
    for(const id of value.ruleIds){
      const rule=this.get('rules',id);if(!rule){if(allowMissingSources)return false;missing=true;continue;}
      if(rule.projectId!==value.projectId||rule.domain!==value.domain||rule.status!=='active'||!Array.isArray(rule.citations)||rule.citations.some(c=>!available(c.sourceId,c.revision)))return false;
    }
    return missing;
  }

  private validCaseSnapshot(value:Entities['cases']):boolean {
    const embedded=value.decisionSnapshot;if(!embedded)return true;
    const action=this.get('actions',value.decisionId),host=action&&historicalSnapshot(this,action,value);
    if(!host||embedded.id!==value.decisionId||embedded.taskId!==value.taskId||embedded.id!==host.id||embedded.projectId!==host.projectId||embedded.domain!==host.domain||
      embedded.taskVersion!==host.taskVersion||embedded.attemptId!==host.attemptId||embedded.inputHash!==host.inputHash||embedded.sourceId!==host.sourceId||embedded.sourceRevision!==host.sourceRevision)return false;
    const complete=(snapshot:typeof embedded):boolean=>{
      if(!Array.isArray(snapshot.sourceRefs)||!snapshot.sourceRefs.length||!wellFormedParentSources(snapshot.sourceRefs)||!snapshot.decision||!Array.isArray(snapshot.decision.citations)||!Array.isArray(snapshot.rules))return false;
      const indexed=new Map(snapshot.sourceRefs.map(ref=>[ref.id,ref.revision]));
      const has=(id:unknown,revision:unknown)=>typeof id==='string'&&typeof revision==='string'&&indexed.get(id)===revision;
      if(!has(snapshot.sourceId,snapshot.sourceRevision)||snapshot.decision.citations.some(c=>!c||!has(c.sourceId,c.revision)))return false;
      if(snapshot.rules.some(rule=>!rule||!Array.isArray(rule.citations)||rule.citations.some(c=>!c||!has(c.sourceId,c.revision))))return false;
      const factual=snapshot.factualUse;
      if(factual&&(!Array.isArray(factual.facts)||factual.facts.some(fact=>!fact||!Array.isArray(fact.sourceRefs)||fact.sourceRefs.some(ref=>!ref||!has(ref.id,ref.revision)))||
        !Array.isArray(factual.statements)||factual.statements.some(statement=>!statement?.citation||!has(statement.citation.sourceId,statement.citation.revision))||
        !Array.isArray(factual.unresolved)||factual.unresolved.some(item=>item?.citation&&!has(item.citation.sourceId,item.citation.revision))))return false;
      return true;
    };
    if(!complete(embedded)||!complete(host)||digest(embedded)!==digest(host))return false;
    const expected=new Map(host.sourceRefs.map(ref=>[ref.id,ref.revision]));
    return embedded.sourceRefs.length===host.sourceRefs.length&&embedded.sourceRefs.every(ref=>expected.get(ref.id)===ref.revision);
  }

  private temporaryKnowledgeAction(action:Entities['actions']):boolean {
    const dependencies=knowledgeActionDependencies(action,this);
    if(action.kind==='knowledge.factual-context'&&factualContextTombstonePayloadSchema.safeParse(action.payload).success&&!this.temporary.has(`actions:${action.id}`)&&!dependencies.unresolved)return false;
    return dependencies.unresolved||dependencies.refs.some(ref=>this.temporarySourceDependency(ref.id,action,ref.revision||undefined));
  }
  private durableFactualAudit(action:Entities['actions']):boolean {
    return action.kind==='knowledge.factual-context'&&!this.temporary.has(`actions:${action.id}`)&&factualContextTombstonePayloadSchema.safeParse(action.payload).success&&!knowledgeActionDependencies(action,this).unresolved;
  }
  /** Retain only the bounded denial needed to prevent replay, never a read result. */
  private durableReadHold(action:Entities['actions']):Entities['actions']|undefined {
    const row=this.db.prepare('SELECT data FROM actions WHERE id = ?').get(action.id) as {data:string}|undefined;
    const retained=row?JSON.parse(row.data) as StoredAction:undefined;
    // An unresolved host-tagged hold is a denial, even when a dependency has
    // not yet been reauthorized and its revision cannot be displayed as raw.
    if(action.kind==='knowledge.structured-ingest'&&action.status==='pending'&&retained?.__hostOpaqueHold&&
      (!structuredIngestJobSchema.safeParse(action.payload).success||!this.get('sources',retained.__hostOpaqueHold.sourceId)?.content))return retained;
    const parsed=structuredIngestJobSchema.safeParse(action.payload);
    if(action.kind!=='knowledge.structured-ingest'||action.status!=='pending'||!parsed.success)return undefined;
    const job=parsed.data,hold=job.readHold;
    const source=this.get('sources',job.sourceId);
    const expiredAudit=!!source&&!source.content&&source.revision===job.sourceRevision&&/^sha256:[a-f0-9]{64}$/.test(job.sourceRevision);
    if(job.phase!=='pending-readback'||job.errorCode!=='knowledge_read_inflight'||!hold||
      action.id!==stableId('knowledge.structured-ingest',job.sourceId,job.sourceRevision,job.sourceHash)&&!expiredAudit||
      hold.sourceHashes.length!==job.sourceRefs.length||new Set(job.sourceRefs.map(ref=>ref.id)).size!==job.sourceRefs.length||
      hold.sourceHashes.some((ref,index)=>ref.id!==job.sourceRefs[index]?.id||ref.revision!==job.sourceRefs[index]?.revision)||
      !hold.sourceHashes.some(ref=>ref.id===job.sourceId&&ref.revision===job.sourceRevision&&ref.hash===job.sourceHash))return undefined;
    if(!source||source.id!==job.sourceId||source.revision!==job.sourceRevision||source.projectId!==action.projectId||source.domain!==action.domain)return undefined;
    const audit=(ref:{id:string;revision:string})=>({...ref,revision:this.auditTemporaryRevision(ref.revision)});
    const sanitized={...job,sourceRevision:this.auditTemporaryRevision(job.sourceRevision),sourceRefs:job.sourceRefs.map(audit),readHold:{...hold,sourceHashes:hold.sourceHashes.map(audit)}};
    return {id:action.id,projectId:action.projectId,domain:action.domain,kind:action.kind,status:'pending',payload:sanitized as unknown as Record<string,unknown>,updatedAt:action.updatedAt,
      __hostOpaqueHold:{version:1,sourceId:job.sourceId,revision:digest(job.sourceRevision),refs:job.sourceRefs.map(ref=>({id:ref.id,revision:digest(ref.revision)}))}} as StoredAction;
  }
  /** Preserve only a host-bound hash audit of completed ordinary reference classification. */
  private durableOrdinaryClassification(action:Entities['actions']):Entities['actions']|undefined {
    if(action.kind!=='knowledge.structured-ingest'||action.status!=='completed')return undefined;
    const row=this.db.prepare('SELECT data FROM actions WHERE id = ?').get(action.id) as {data:string}|undefined;
    const retained=row?JSON.parse(row.data) as StoredAction:undefined, opaque=retained?.__hostOpaqueHold;
    const retainedJob=retained&&structuredIngestJobSchema.safeParse(retained.payload),boundSource=opaque&&this.get('sources',opaque.sourceId);
    if(opaque&&retainedJob?.success&&retainedJob.data.phase==='ordinary'&&retained?.status==='completed'&&boundSource?.status==='active'&&
      digest(action)===digest(this.visible('actions',retained))&&(!structuredIngestJobSchema.safeParse(action.payload).success||!boundSource.content))return retained;
    const parsed=structuredIngestJobSchema.safeParse(action.payload);if(!parsed.success||parsed.data.phase!=='ordinary')return undefined;
    const job=parsed.data,source=this.get('sources',job.sourceId),accepted=this.get('cursors',stableId('source-hash',job.sourceId))?.value;
    if(!source||source.purpose!=='reference'||source.status!=='active'||!source.content||source.projectId!==action.projectId||source.domain!==action.domain||source.revision!==job.sourceRevision||job.sourceHash!==digest(source.content)||accepted&&accepted!==job.sourceHash||action.id!==structuredKnowledgeJobId(source)||!validStructuredJobRefs(this,source,job.sourceRefs))return undefined;
    const audit=(ref:{id:string;revision:string})=>({...ref,revision:this.auditTemporaryRevision(ref.revision)});
    const sanitized={...job,sourceRevision:this.auditTemporaryRevision(job.sourceRevision),sourceRefs:job.sourceRefs.map(audit)};
    return {id:action.id,projectId:action.projectId,domain:action.domain,kind:action.kind,status:'completed',payload:sanitized as unknown as Record<string,unknown>,updatedAt:action.updatedAt,
      __hostOpaqueHold:{version:1,sourceId:job.sourceId,revision:digest(job.sourceRevision),refs:job.sourceRefs.map(ref=>({id:ref.id,revision:digest(ref.revision)}))}} as StoredAction;
  }
  private protectTemporaryKnowledgeActions(retainReadable=true,scope?:Scope):void {
    const affected=scope?this.retentionResolution?.affected:undefined;
    for(const action of scope?this.listScope('actions',scope):this.list('actions'))if((!affected||knowledgeActionDependencies(action).refs.some(ref=>affected.has(ref.id)))&&this.temporaryKnowledgeAction(action)){
      const hold=this.durableReadHold(action)??this.durableOrdinaryClassification(action);
      if(hold){this.write('actions',hold);this.deleteTemporary(`actions:${action.id}`);continue;}
      const invalid=new Set(knowledgeActionDependencies(action).refs.filter(ref=>this.temporarySourceDependency(ref.id,action,ref.revision||undefined)).map(ref=>ref.id));
      const tombstone=normalizationTombstone(this,action,invalid,{phase:'invalid',errorCode:'source_invalidated',retracted:true,sourceIds:[...invalid]});
      if(retainReadable)this.setTemporary(`actions:${action.id}`,{entity:action});else this.deleteTemporary(`actions:${action.id}`);
      const origin=normalizationOriginPayloadSchema.safeParse(tombstone);
      if(origin.success){
        const card=this.get('cards',origin.data.normalizationOrigin.cardId),binding=origin.data.normalizationOrigin;
        if(card?.experience&&knowledgeCandidateHash(card)===binding.candidateHash){
          if(/^[a-f0-9]{40}$/.test(binding.observedRevision)){this.write('actions',{...action,payload:tombstone});continue;}
          const reverted={...card,experience:{...card.experience,codeVersion:'unknown'}};
          this.write('cards',reverted);this.indexCard(reverted);this.vaultJobs.set(`cards:${card.id}`,{table:'cards',entity:reverted,previous:card});
        }
      }
      if(['decision.evidence','decision.review'].includes(action.kind))this.write('actions',this.redactTemporary('actions',action) as Entities['actions']);else this.deleteAction(action.id);
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
    if(!this.vaultDir){this.queueTemporaryRedaction('cards',card);return;}
    const path=this.vaultPath('cards',card),directory=dirname(path),prefix=path.slice(path.lastIndexOf('/')+1).replace(/\.md$/,'.conflict-');
    const id=this.vaultRedactionId({table:'cards',id:card.id},card);
    if(this.db.prepare('SELECT 1 FROM vault_projection_origins WHERE id = ? AND projected = 1 LIMIT 1').get(id)||existsSync(path)||existsSync(directory)&&readdirSync(directory).some(name=>name.startsWith(prefix)&&name.endsWith('.md')))this.queueTemporaryRedaction('cards',card);
  }
  private protectTemporaryStructuredCards(scope?:Scope):void {
    const affected=scope?this.retentionResolution?.affected:undefined,cardSources=affected?new Set(affected):undefined;
    if(cardSources)for(const action of this.listScope('actions',scope!))if(action.kind==='knowledge.structured-ingest'&&typeof action.payload.sourceId==='string'&&knowledgeActionDependencies(action).refs.some(ref=>affected!.has(ref.id)))cardSources.add(action.payload.sourceId);
    for(const card of scope?this.listScope('cards',scope):this.list('cards'))if(isStructuredKnowledgeCard(card)&&(!cardSources||cardSources.has(card.sourceId))){
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
      for(const action of scope?this.listScope('actions',scope):this.list('actions'))if((action.kind==='knowledge.evidence-link'&&(action.payload.link as {cardId?:unknown}|undefined)?.cardId===card.id)||(action.kind==='experience.evidence-link'&&canonicalExperiencePayloadSchema.safeParse(action.payload).data?.association.cardId===card.id)){
        this.setTemporary(`actions:${action.id}`,{entity:unknown?{...action,status:'completed',payload:{retracted:true,sourceIds:[card.sourceId]}}:action,...(unknown&&recoverable?{missingJobCardId:card.id}:{})});this.deleteAction(action.id);
      }
    }
  }
  auditTemporaryRevision(revision:string):string {return /^sha256:[a-f0-9]{64}$/.test(revision)?revision:`sha256:${digest(revision)}`;}
  private bindOpaqueSource(source:Entities['sources']):OpaqueSourceIdentity {
    return {version:1,externalId:digest(source.externalId),revision:digest(source.revision),authorId:digest(source.authorId),locator:digest(source.locator),
      ...(source.parentSources!==undefined?{parents:wellFormedParentSources(source.parentSources)?source.parentSources!.map(ref=>({id:ref.id,revision:digest(ref.revision)})):null}:{})};
  }
  private opaqueSourceIdentity(id:string):OpaqueSourceIdentity|undefined {
    const row=this.db.prepare('SELECT data FROM sources WHERE id = ?').get(id) as {data:string}|undefined;
    if(!row)return undefined;
    return this.validOpaqueSourceIdentity((JSON.parse(row.data) as StoredSource).__hostOpaqueIdentity);
  }
  private validOpaqueSourceIdentity(binding:OpaqueSourceIdentity|undefined):OpaqueSourceIdentity|undefined {
    const hash=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    return binding?.version===1&&hash(binding.externalId)&&hash(binding.revision)&&hash(binding.authorId)&&hash(binding.locator)&&
      (binding.parents===undefined||binding.parents===null||Array.isArray(binding.parents)&&binding.parents.every(ref=>!!ref&&typeof ref.id==='string'&&!!ref.id&&hash(ref.revision)))?binding:undefined;
  }
  sourceExternalIdMatches(source:Entities['sources'],externalId:string):boolean {
    if(this.temporary.has(`sources:${source.id}`))return source.externalId===externalId;
    const binding=this.opaqueSourceIdentity(source.id);
    if(binding)return binding.externalId===digest(externalId);
    if(!source.content&&(source.title==='Temporary source'||source.status==='withdrawn'))return false;
    return source.externalId===externalId;
  }
  sourceIdentityMatches(source:Entities['sources'],identity:{externalId:string;revision:string;authorId:string;locator:string},parents?:Entities['sources']['parentSources']):boolean {
    const binding=this.opaqueSourceIdentity(source.id);
    if(!binding)return false;
    if(binding.externalId!==digest(identity.externalId)||binding.revision!==digest(identity.revision)||binding.authorId!==digest(identity.authorId)||binding.locator!==digest(identity.locator))return false;
    if(parents!==undefined){
      if(!wellFormedParentSources(parents)||!Array.isArray(binding.parents)&&!(parents.length===0&&binding.parents===undefined)||parents.length!==(binding.parents?.length??0))return false;
      if(parents.some((ref,index)=>binding.parents![index]!.id!==ref.id||binding.parents![index]!.revision!==digest(ref.revision)))return false;
    }
    return binding.parents!==null;
  }
  sourceHasOpaqueIdentity(source:Entities['sources']):boolean {return !!this.opaqueSourceIdentity(source.id);}
  sourceRevisionHashMatches(source:Entities['sources'],expected:string):boolean {
    const binding=this.opaqueSourceIdentity(source.id);
    if(binding)return binding.revision===expected;
    return !!source.content&&digest(source.revision)===expected;
  }
  sourceParentAuditRefs(source:Entities['sources']):{id:string;revisionHash:string}[]|undefined {
    const binding=this.opaqueSourceIdentity(source.id);
    if(binding?.parents===null)return undefined;
    if(Array.isArray(binding?.parents))return binding.parents.map(ref=>({id:ref.id,revisionHash:ref.revision}));
    if(source.parentSources===undefined)return [];
    if(!source.content||!wellFormedParentSources(source.parentSources))return undefined;
    return source.parentSources!.map(ref=>({id:ref.id,revisionHash:digest(ref.revision)}));
  }
  sourceDependsOnId(source:Entities['sources'],id:string):boolean {
    const binding=this.opaqueSourceIdentity(source.id);
    if(Array.isArray(binding?.parents))return binding.parents.some(ref=>ref.id===id);
    return Array.isArray(source.parentSources)&&source.parentSources.some(ref=>!!ref&&ref.id===id);
  }
  sourceRequiresTemporaryRetention(source:Entities['sources']):boolean {return this.temporarySource(source);}
  private redactTemporarySource(source:Entities['sources']):Entities['sources'] {
    // G7 persisted raw metadata for blank-body ephemeral sources. Capture it only
    // while every preimage is unambiguous and the original host ID still binds it.
    const raw=[source.externalId,source.revision,source.authorId,source.locator];
    const unambiguous=(value:unknown):value is string=>typeof value==='string'&&!/^sha256:[a-f0-9]{64}$/.test(value);
    const legacy=source.retention==='ephemeral'&&source.status==='active'&&raw.every(unambiguous)&&
      source.id===stableId('source',{projectId:source.projectId,domain:source.domain},source.kind,source.externalId,source.revision)&&
      wellFormedParentSources(source.parentSources)&&(source.parentSources??[]).every(ref=>unambiguous(ref.revision));
    const binding=this.opaqueSourceIdentity(source.id)??(source.content||legacy?this.bindOpaqueSource(source):undefined);
    const previous=this.db.prepare('SELECT data FROM sources WHERE id = ?').get(source.id) as {data:string}|undefined;
    const oldParents=previous?(JSON.parse(previous.data) as StoredSource).parentSources:undefined;
    const parents=binding?.parents===null?[{id:'',revision:''}]:Array.isArray(binding?.parents)?binding.parents.map(ref=>({id:ref.id,revision:`sha256:${ref.revision}`})):
      source.parentSources===undefined?undefined:wellFormedParentSources(source.parentSources)?source.parentSources!.map(ref=>({id:ref.id,revision:this.auditTemporaryRevision(ref.revision)})):oldParents??[{id:'',revision:''}];
    return {...source,title:'Temporary source',content:'',externalId:binding?`sha256:${binding.externalId}`:this.auditTemporaryRevision(source.externalId),authorId:binding?`sha256:${binding.authorId}`:this.auditTemporaryRevision(source.authorId),locator:binding?`sha256:${binding.locator}`:this.auditTemporaryRevision(source.locator),revision:binding?`sha256:${binding.revision}`:this.auditTemporaryRevision(source.revision),
      ...(parents!==undefined?{parentSources:parents}:{}),...(binding?{__hostOpaqueIdentity:binding}:{})};
  }
  private temporarySource(source:Entities['sources']):boolean {
    const context=this.retentionResolution&&this.retentionResolution.scope.projectId===source.projectId&&this.retentionResolution.scope.domain===source.domain?this.retentionResolution:undefined;
    const seen=new Set<string>(),resolved=context?.resolved??new Map<string,boolean>();
    const visit=(current:Entities['sources']|undefined,revision?:string):boolean=>{
      if(!current||current.projectId!==source.projectId||current.domain!==source.domain||revision!==undefined&&current.revision!==revision||seen.has(current.id)||!['permanent','ephemeral'].includes(current.retention))return true;
      if(current.retention==='ephemeral')return true;
      const cached=resolved.get(current.id);if(cached!==undefined)return cached;
      const parents:unknown=current.parentSources;
      if(!wellFormedParentSources(parents))return true;
      seen.add(current.id);
      const result=(parents??[]).some(parent=>{
        return visit(parent.id===source.id?source:context?context.sources.get(parent.id):this.get('sources',parent.id),parent.revision);
      })||(()=>{const task=this.ownerAnswerTask(current);return !!task&&visit(task.sourceId===source.id?source:context?context.sources.get(task.sourceId):this.get('sources',task.sourceId),task.sourceRevision);})();
      seen.delete(current.id);resolved.set(current.id,result);return result;
    };
    return visit(source);
  }
  private ownerAnswerTask(source:Entities['sources']):Entities['tasks']|undefined {
    if(source.kind!=='conversation'||!source.externalId.startsWith('answer:'))return undefined;
    const question=this.get('questions',source.externalId.slice('answer:'.length)),task=question&&this.get('tasks',question.taskId),project=this.get('projects',source.projectId);
    if(!question||question.status!=='answered'||!question.answer||!task||!project||source.id!==stableId('owner-answer',question.id)||
      question.projectId!==source.projectId||question.domain!==source.domain||task.projectId!==source.projectId||task.domain!==source.domain||project.domain!==source.domain||
      question.ownerId!==project.ownerId||question.answer.actorId!==project.ownerId||source.authorId!==project.ownerId||task.version<question.taskVersion||
      source.revision!==digest(question.answer.text)||source.content!==question.answer.text||source.locator!==`question:${question.id}@${question.version}`)return undefined;
    const event=this.get('cursors',stableId('answer-event',source.projectId,source.domain,question.answer.eventId));
    if(event&&event.value!==digest({questionId:question.id,choice:question.answer.choice,words:question.answer.text}))return undefined;
    return task;
  }
  private temporarySourceDependency(id:string,scope?:Scope,revision?:string):boolean {
    const context=this.retentionResolution&&(!scope||scope.projectId===this.retentionResolution.scope.projectId&&scope.domain===this.retentionResolution.scope.domain)?this.retentionResolution:undefined;
    const source=context?context.sources.get(id):this.get('sources',id);
    return !source||!!scope&&(source.projectId!==scope.projectId||source.domain!==scope.domain)||revision!==undefined&&source.revision!==revision||this.temporarySource(source);
  }
  private queueTemporaryRedaction(table:Table,entity:Entities[Table]):void {
    if(!vaultTables.has(table))return;
    const identity={table:table as VaultRedaction['table'],id:entity.id},id=this.vaultRedactionId(identity,entity);
    const existing=this.get('cursors',id);
    const prior=existing&&this.readVaultRedaction(existing);
    // Unknown legacy origins remain unbound and cannot be acknowledged by a new attachment.
    if(prior&&(prior.version===1||prior.version===2&&!prior.origin))return;
    const tracked=this.db.prepare('SELECT origin,projected FROM vault_projection_origins WHERE id = ?').all(id) as {origin:string;projected:number}[];
    const origins=tracked.filter(row=>row.projected===1).map(row=>row.origin);
    if(!tracked.length&&!existing){
      const fallback=this.attachedVaultOrigin()??this.lastVaultOrigin();
      if(fallback){origins.push(fallback);this.db.prepare('INSERT OR IGNORE INTO vault_projection_origins(id,origin,projected) VALUES (?,?,1)').run(id,fallback);}
      else{
        this.db.prepare("INSERT OR IGNORE INTO vault_state(key,value) VALUES ('redaction_history','1')").run();
        this.write('cursors',{id,projectId:entity.projectId,domain:entity.domain,value:JSON.stringify({version:2,...identity,origin:null}),updatedAt:''});return;
      }
    }
    const old=prior?(prior.version===2?[prior.origin!]:prior.origins):[];
    const pending=[...new Set([...old,...origins])].sort();
    if(!pending.length)return;
    this.db.prepare("INSERT OR IGNORE INTO vault_state(key,value) VALUES ('redaction_history','1')").run();
    const intent:VaultRedaction=pending.length===1?{version:2,...identity,origin:pending[0]!}:{version:3,...identity,origins:pending};
    if(!existing)this.write('cursors',{id,projectId:entity.projectId,domain:entity.domain,value:JSON.stringify(intent),updatedAt:''});
    else if(pending.some(origin=>!old.includes(origin)))this.write('cursors',{...existing,value:JSON.stringify(intent)});
    if(pending.includes(this.attachedVaultOrigin()??''))this.vaultJobs.set(`${table}:${entity.id}`,{table,entity,redactTemporary:true});
  }
  private vaultOrigin(directory:string):string {
    return vaultOrigin(directory);
  }
  private attachedVaultOrigin():string|undefined {
    if(!this.vaultDir)return undefined;
    // Bind to host filesystem identity without storing the path or trusting Vault content.
    return this.vaultOrigin(this.vaultDir);
  }
  private vaultOriginClear(origin:string):boolean {
    return vaultOriginClear(this.db,origin);
  }
  private copyVaultOrigin(source:string,target:string):void {
    if(!this.vaultOriginClear(target))throw new DomainError('Vault privacy cleanup cannot be verified for this location.','vault_cleanup_unavailable',503);
    this.db.transaction(()=>{
      this.db.prepare('INSERT INTO vault_origins(origin,verified) VALUES (?,1) ON CONFLICT(origin) DO UPDATE SET verified=1').run(target);
      this.db.prepare('INSERT INTO vault_projection_origins(id,origin,projected) SELECT id,?,projected FROM vault_projection_origins WHERE origin = ? ON CONFLICT(id,origin) DO UPDATE SET projected=max(projected,excluded.projected)').run(target,source);
    })();
  }
  private bindVaultCopy(source:string,target:string):void {
    this.prepareVaultBackup(source);
    if(vaultFingerprint(source)!==vaultFingerprint(target))throw new DomainError('Copied Vault does not match its clean source.','vault_cleanup_unavailable',503);
    this.copyVaultOrigin(this.vaultOrigin(source),this.vaultOrigin(target));
  }
  private bindSnapshotVault(target:string):void {
    const row=this.db.prepare("SELECT value FROM vault_state WHERE key = 'backup_vault_proof'").get() as {value:string}|undefined;
    if(!row)return;
    const reject=()=>this.db.prepare('INSERT INTO vault_origins(origin,verified) VALUES (?,0) ON CONFLICT(origin) DO UPDATE SET verified=0').run(this.vaultOrigin(target));
    let proof:{origin?:unknown;fingerprint?:unknown};
    try{proof=JSON.parse(row.value) as typeof proof;}catch{reject();return;}
    if(!proof||typeof proof.origin!=='string'||!/^[a-f0-9]{64}$/.test(proof.origin)||typeof proof.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(proof.fingerprint)){reject();return;}
    const known=this.db.prepare('SELECT verified FROM vault_origins WHERE origin = ?').get(proof.origin) as {verified:number}|undefined;
    if(known?.verified!==1||!this.vaultOriginClear(proof.origin)||vaultFingerprint(target)!==proof.fingerprint){reject();return;}
    this.copyVaultOrigin(proof.origin,this.vaultOrigin(target));
  }
  /** Seal a validated backup copy in its host-owned snapshot ledger. */
  sealVaultSnapshot():void {
    if(!this.vaultDir)return;
    this.prepareVaultBackup(this.vaultDir);
    const value=JSON.stringify({origin:this.attachedVaultOrigin(),fingerprint:vaultFingerprint(this.vaultDir)});
    this.db.prepare("INSERT INTO vault_state(key,value) VALUES ('backup_vault_proof',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value);
  }
  /** Carry a clean staging origin across the imminent same-filesystem directory rename. */
  prepareVaultMove(destinationVault:string):void {
    if(!this.vaultDir)return;
    const source=this.attachedVaultOrigin()!,known=this.db.prepare('SELECT verified FROM vault_origins WHERE origin = ?').get(source) as {verified:number}|undefined;
    if(known?.verified!==1||!this.vaultOriginClear(source))return;
    this.prepareVaultBackup(this.vaultDir);
    const stat=statSync(realpathSync(this.vaultDir));
    const path=join(realpathSync(dirname(dirname(destinationVault))),basename(dirname(destinationVault)),basename(destinationVault));
    const target=digest({path,dev:stat.dev,ino:stat.ino});
    if(!this.vaultOriginClear(target))return;
    this.copyVaultOrigin(source,target);
    if(source!==target)this.db.transaction(()=>{
      this.db.prepare('DELETE FROM vault_projection_origins WHERE origin = ?').run(source);
      this.db.prepare('DELETE FROM vault_origins WHERE origin = ?').run(source);
      this.db.prepare("UPDATE vault_state SET value = ? WHERE key = 'origin' AND value = ?").run(target,source);
    })();
  }
  private certifyLegacyVault():void {
    if(!this.vaultDir||!this.db.prepare("SELECT 1 FROM vault_state WHERE key = 'origin_history_incomplete'").get())return;
    const origin=this.attachedVaultOrigin()!,known=this.db.prepare('SELECT verified FROM vault_origins WHERE origin = ?').get(origin) as {verified:number}|undefined;
    if(known?.verified!==0||!this.vaultOriginClear(origin))return;
    const sources=this.list('sources'),expected=new Map<string,Set<string>>();
    for(const table of vaultTables)for(const entity of this.list(table)){
      if(table==='sources'?this.temporarySource(entity as Entities['sources']):this.isTemporaryDerived(table,entity))continue;
      const path=this.vaultPath(table,entity),canonical=this.markdown(table,entity),effective=this.vaultEntity(table,entity),values=new Set([canonical]);
      const header=canonical.match(/^---\n[\s\S]*?\n---\n/)?.[0],externalId=`vault:${relative(this.vaultDir,path)}`;
      if(header&&(!('status' in effective)||effective.status==='active'))for(const edit of sources){
        if(edit.kind!=='file'||edit.externalId!==externalId||edit.projectId!==entity.projectId||edit.domain!==entity.domain||!['active','superseded'].includes(edit.status)||this.temporarySource(edit)||!edit.parentSources?.length)continue;
        if(edit.parentSources.some(ref=>{const parent=this.get('sources',ref.id);return !parent||parent.status!=='active'||parent.revision!==ref.revision||parent.projectId!==edit.projectId||parent.domain!==edit.domain;}))continue;
        values.add(header+edit.content);
      }
      expected.set(path,values);
    }
    let count=0;
    const matches=(directory:string):boolean=>{
      for(const item of readdirSync(directory,{withFileTypes:true})){
        const path=join(directory,item.name);
        if(item.isSymbolicLink())return false;
        if(item.isDirectory()){if(!matches(path))return false;continue;}
        if(!item.isFile())return false;
        if(!path.endsWith('.md')||path.includes('.tmp-'))continue;
        count++;
        const original=path.replace(/\.conflict-[^/]+\.md$/,'.md'),values=expected.get(original),content=readFileSync(path);
        if(!values||![...values].some(value=>content.equals(Buffer.from(value))))return false;
      }
      return true;
    };
    try{if(matches(this.vaultDir)&&count>0)this.db.prepare('UPDATE vault_origins SET verified = 1 WHERE origin = ?').run(origin);}catch{/* Unverifiable content remains untouched and unverified. */}
  }
  private registerAttachedVault():void {
    const origin=this.attachedVaultOrigin()!;
    const existing=this.db.prepare('SELECT verified FROM vault_origins WHERE origin = ?').get(origin) as {verified:number}|undefined;
    if(existing){
      if(existing.verified===0&&readdirSync(this.vaultDir!).length===0)this.db.prepare('UPDATE vault_origins SET verified = 1 WHERE origin = ?').run(origin);
      return;
    }
    const uncertain=!!this.db.prepare("SELECT 1 FROM vault_state WHERE key IN ('redaction_history','origin_history_incomplete') LIMIT 1").get()||!!this.db.prepare("SELECT 1 FROM cursors WHERE id LIKE 'vault-redaction:%' LIMIT 1").get();
    // An unknown, populated location may be an older projection; never infer it is clean.
    const verified=!uncertain||readdirSync(this.vaultDir!).length===0;
    this.db.prepare('INSERT INTO vault_origins(origin,verified) VALUES (?,?)').run(origin,verified?1:0);
  }
  private lastVaultOrigin():string|undefined {
    const row=this.db.prepare("SELECT value FROM vault_state WHERE key = 'origin'").get() as {value:string}|undefined;
    return row&&/^[a-f0-9]{64}$/.test(row.value)?row.value:undefined;
  }
  private vaultRedactionId(intent:Pick<VaultRedaction,'table'|'id'>,scope:Scope):string {return `vault-redaction:${stableId('vault-redaction',scope.projectId,scope.domain,intent.table,intent.id)}`;}
  private readVaultRedaction(cursor:Entities['cursors']):VaultRedaction {
    return readVaultRedaction(cursor);
  }
  private replayVaultRedactions():void {
    if(!this.vaultDir)return;
    const rows=this.db.prepare("SELECT data FROM cursors WHERE id LIKE 'vault-redaction:%'").all() as {data:string}[];
    for(const row of rows){
      const cursor=JSON.parse(row.data) as Entities['cursors'],intent=this.readVaultRedaction(cursor);
      const origin=this.attachedVaultOrigin();
      if(!origin||intent.version===1||intent.version===2&&intent.origin!==origin||intent.version===3&&!intent.origins.includes(origin))continue;
      const key=`${intent.table}:${intent.id}`,queued=this.vaultJobs.get(key);
      if(queued?.redactTemporary||queued?.redactStructuredCard)continue;
      const scope={id:intent.id,projectId:cursor.projectId,domain:cursor.domain};
      const entity=(intent.table==='sources'?{...scope,kind:'manual',externalId:'',revision:'',title:'',content:'',locator:'',authorId:'',retention:'ephemeral',status:'withdrawn',createdAt:''}:
        intent.table==='cards'?{...scope,sourceId:'',sourceRevision:'',title:'',body:'',quote:'',locator:'',kind:'fact',verification:'reported',status:'withdrawn',aliases:[],createdAt:''}:
        intent.table==='rules'?{...scope,title:'',statement:'',conditions:'',exceptions:'',version:1,kind:'observation',status:'suspended',caseIds:[],citations:[],createdAt:'',reviewAt:''}:
        {...scope,taskId:'',questionId:'',decisionId:'',actorId:'',choice:'C',originalWords:'',rationale:'',alternatives:[],ruleIds:[],sourceId:'',status:'withdrawn',createdAt:''}) as Entities[Table];
      this.vaultJobs.set(key,{table:intent.table,entity,redactTemporary:true});
    }
  }
  private protectTemporarySourceDependents(retainReadable=true,deferMissingSources=false,scope?:Scope):void {
    const list=<K extends Table>(table:K)=>scope?this.listScope(table,scope):this.list(table);
    const affected=scope?this.retentionResolution?.affected:undefined;
    for(const source of list('sources'))if((!affected||affected.has(source.id))&&this.temporarySource(source)){
      const ownerTask=deferMissingSources?this.ownerAnswerTask(source):undefined;
      if(ownerTask&&!this.get('sources',ownerTask.sourceId))continue;
      const key=`sources:${source.id}`;if(!this.temporary.has(key)){this.privacyCheckpointPending=true;if(retainReadable)this.setTemporary(key,{entity:source});}
      this.write('sources',this.redactTemporarySource(source));
      this.queueTemporaryRedaction('sources',source);
    }
    const affectedRules=affected?new Set(list('rules').filter(rule=>Array.isArray(rule.citations)&&rule.citations.some(c=>affected.has(c.sourceId))).map(rule=>rule.id)):undefined;
    const historicalTasks=new Set<string>();
    for(const action of list('actions'))if(action.kind==='decision.snapshot'&&action.taskId){
      const candidate=action.payload?.snapshot as {sourceId?:unknown;sourceRefs?:{id?:unknown}[]}|undefined;
      if(affected&&!affected.has(String(candidate?.sourceId??''))&&(!Array.isArray(candidate?.sourceRefs)||!candidate.sourceRefs.some(ref=>typeof ref?.id==='string'&&affected.has(ref.id))))continue;
      const snapshot=historicalSnapshot(this,action,action);
      if(snapshot?.sourceRefs.some(ref=>this.temporarySourceDependency(ref.id,action,ref.revision)))historicalTasks.add(action.taskId);
    }
    const affectedTasks=affected?new Set(list('tasks').filter(task=>affected.has(task.sourceId)||historicalTasks.has(task.id)||!!task.decision&&(Array.isArray(task.decision.citations)&&task.decision.citations.some(c=>!!c&&affected.has(c.sourceId))||Array.isArray(task.decision.ruleIds)&&task.decision.ruleIds.some(id=>affectedRules!.has(id)))).map(task=>task.id)):undefined;
    for(const table of ['tasks','events','attempts','outbox','questions','actions'] as const)for(const entity of list(table)){
      const taskId=table==='tasks'?entity.id:'taskId' in entity&&entity.taskId||'';
      const outboxIds=table==='outbox'?(entity as Entities['outbox']).sourceIds:undefined;
      if(affectedTasks&&!affectedTasks.has(taskId)&&!(Array.isArray(outboxIds)&&outboxIds.some(id=>affected!.has(id))))continue;
      if(!((table!=='actions'||!this.durableFactualAudit(entity as Entities['actions'])&&!['knowledge.structured-ingest','knowledge.host-observation','knowledge.evidence-link','knowledge.factual-context','experience.test-observation','experience.evidence-link'].includes((entity as Entities['actions']).kind))&&(this.isTemporaryTaskEntity(table,entity)||historicalTasks.has(taskId))))continue;
      const task=table==='tasks'?entity as Entities['tasks']:'taskId' in entity&&entity.taskId?this.get('tasks',entity.taskId):undefined;
      if(deferMissingSources&&task&&!this.get('sources',task.sourceId))continue;
      if(retainReadable)this.setTemporary(`${table}:${entity.id}`,{entity});this.write(table,this.redactTemporary(table,entity) as never);
    }
    for(const event of list('events')){
      const sourceId=event.data?.sourceId;
      if(typeof sourceId!=='string'||affected&&!affected.has(sourceId)||!this.temporarySourceDependency(sourceId,event))continue;
      if(deferMissingSources&&!this.get('sources',sourceId))continue;
      if(!this.temporary.has(`events:${event.id}`))this.privacyCheckpointPending=true;
      if(retainReadable)this.setTemporary(`events:${event.id}`,{entity:event});
      const revision=event.data?.revision;
      this.write('events',{...event,message:'Temporary source event.',data:{sourceId,...(typeof revision==='string'?{revision:this.auditTemporaryRevision(revision)}:{})}});
    }
    for(const table of ['cards','rules','cases'] as const)for(const entity of list(table)){
      if(table==='cards'&&isStructuredKnowledgeCard(entity as KnowledgeCard))continue;
      if(affected){
        const relevant=table==='cards'?affected.has((entity as KnowledgeCard).sourceId):table==='rules'?affectedRules!.has(entity.id):(()=>{
          const value=entity as Entities['cases'],snapshot=value.decisionSnapshot;
          return affected.has(value.sourceId)||!!snapshot&&(affected.has(snapshot.sourceId)||Array.isArray(snapshot.sourceRefs)&&snapshot.sourceRefs.some(ref=>!!ref&&affected.has(ref.id)))||Array.isArray(value.ruleIds)&&value.ruleIds.some(id=>affectedRules!.has(id));
        })();
        if(!relevant)continue;
      }
      if(!this.isTemporaryDerived(table,entity))continue;
      if(deferMissingSources&&(table==='cases'?this.mayDeferMissingCaseDependencies(entity as Entities['cases']):('sourceId' in entity&&!this.get('sources',entity.sourceId)||'citations' in entity&&entity.citations.some(c=>!this.get('sources',c.sourceId)))))continue;
      if(!this.temporary.has(`${table}:${entity.id}`))this.privacyCheckpointPending=true;
      if(retainReadable)this.setTemporary(`${table}:${entity.id}`,{entity});this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(entity.id);
      if(table==='cards')this.db.prepare('DELETE FROM cards_fts WHERE id = ?').run(entity.id);
      this.queueTemporaryRedaction(table,entity);
    }
  }
  private isTemporaryTaskEntity(table: Table, entity: Entities[Table]): boolean {
    if(table==='outbox'){
      const ids=(entity as Entities['outbox']).sourceIds;
      if(ids!==undefined&&(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||this.temporarySourceDependency(id,entity))))return true;
    }
    const task = table === 'tasks' ? entity as Entities['tasks'] : 'taskId' in entity && entity.taskId ? this.get('tasks', entity.taskId) : undefined;
    if(!task)return false;
    if(table==='actions'&&this.durableFactualAudit(entity as Entities['actions']))return false;
    if(this.temporary.has(`tasks:${task.id}`))return true;
    if(this.temporarySourceDependency(task.sourceId,task,task.sourceRevision))return true;
    const decision=task.decision;
    if(decision){
      if(!Array.isArray(decision.citations)||!Array.isArray(decision.ruleIds))return true;
      if(decision.citations.some(c=>!c||typeof c.sourceId!=='string'||typeof c.revision!=='string'||this.temporarySourceDependency(c.sourceId,task,c.revision)))return true;
      if(decision.ruleIds.some(id=>{const rule=this.get('rules',id);return !rule||rule.projectId!==task.projectId||rule.domain!==task.domain||this.isTemporaryDerived('rules',rule);}))return true;
    }
    if(table==='actions'&&(entity as Entities['actions']).kind==='decision.snapshot'){
      const snapshot=historicalSnapshot(this,entity as Entities['actions'],task);
      if(snapshot?.sourceRefs.some(ref=>this.temporarySourceDependency(ref.id,task,ref.revision)))return true;
    }
    return false;
  }
  private redactTemporary(table: Table, entity: Entities[Table]): Entities[Table] {
    if (table === 'tasks') {const task=entity as Entities['tasks'];return { ...task, sourceRevision:this.temporarySourceDependency(task.sourceId,task,task.sourceRevision)?this.auditTemporaryRevision(task.sourceRevision):task.sourceRevision,title: 'Temporary task', description: '', decision: undefined, plan: undefined, artifact: undefined, review: undefined, feedback: undefined, baselineFiles: undefined, error: 'Temporary content is kept only in the active process.' };}
    if (table === 'events') return { ...entity, message: 'Temporary task event.', data: {} } as Entities['events'];
    if (table === 'attempts') {
      const attempt = entity as Entities['attempts'];
      // Retain only fixed accounting/availability codes, never provider or source text.
      const error = ['attempt_abandoned_after_host_restart', 'billing_policy_violation', 'subscription_unavailable'].includes(attempt.error ?? '') ? attempt.error : undefined;
      return { ...attempt, error };
    }
    if (table === 'actions') {
      const action=entity as Entities['actions'],task=action.taskId&&this.get('tasks',action.taskId),payload=action.payload;
      if(['decision.evidence','decision.review'].includes(action.kind)){
        if(payload.retracted===true)return action;
        const refs=knowledgeActionDependencies(action).refs,record=(payload.evidence??payload.review) as {snapshotId?:unknown;evidenceIds?:unknown}|undefined;
        const safe=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
        const sourceIds=[...new Set(refs.map(ref=>ref.id).filter(safe))],snapshotId=safe(record?.snapshotId)?record.snapshotId:undefined;
        const evidenceIds=Array.isArray(record?.evidenceIds)?record.evidenceIds.filter(safe):[];
        return {...action,payload:{retracted:true,sourceIds,payloadHash:digest(payload),...(snapshotId?{snapshotId}:{}),...(evidenceIds.length?{evidenceIds}:{})}};
      }
      const prior=payload.priorSucceededAttemptIds,before=payload.attemptsBefore;
      if(task&&action.status==='pending'&&action.kind===task.stage&&['knowledge_extract','case_extract','decide','plan','execute','check','feedback'].includes(action.kind)&&
        action.id===stableId('stage-action',task.id,task.version,task.stage,task.repairCount)&&action.projectId===task.projectId&&action.domain===task.domain&&
        payload.taskVersion===task.version&&(payload.sourceRevision===task.sourceRevision||typeof payload.sourceRevision==='string'&&this.auditTemporaryRevision(payload.sourceRevision)===task.sourceRevision)&&typeof before==='number'&&Number.isSafeInteger(before)&&before>=0&&before<=task.attempts&&
        Array.isArray(prior)&&prior.length<=32&&new Set(prior).size===prior.length&&prior.every(id=>typeof id==='string'&&this.list('attempts').some(a=>a.id===id&&a.taskId===task.id&&a.projectId===task.projectId&&a.domain===task.domain&&a.taskVersion===task.version&&a.role===task.stage&&a.status==='succeeded')))
        return {id:action.id,projectId:action.projectId,domain:action.domain,taskId:task.id,kind:action.kind,status:'pending',updatedAt:action.updatedAt,payload:{taskVersion:task.version,sourceRevision:this.auditTemporaryRevision(task.sourceRevision),attemptsBefore:before,priorSucceededAttemptIds:prior},__hostOpaqueHold:{version:1,sourceId:task.sourceId,revision:digest(task.sourceRevision)}} as StoredAction;
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
    if (!job.redactStructuredCard && !job.redactTemporary && (this.isTemporaryDerived(job.table, latest) || job.table === 'sources' && this.temporarySource(latest as Entities['sources']))) return;
    const card=latest as KnowledgeCard;
    let temporary=job.redactTemporary?{...job.entity,status:job.table==='rules'?'suspended':'withdrawn'} as Entities[Table]:undefined;
    if(temporary&&job.table==='sources')temporary=this.redactTemporarySource(temporary as Entities['sources']);
    if(temporary&&job.table==='cards'){const value=temporary as KnowledgeCard;temporary={...value,sourceRevision:this.auditTemporaryRevision(value.sourceRevision)};}
    if(temporary&&job.table==='rules'){const value=temporary as Entities['rules'];temporary={...value,citations:value.citations.map(c=>({...c,revision:this.auditTemporaryRevision(c.revision)}))};}
    const entity=job.redactStructuredCard?{...card,status:'withdrawn' as const,title:'[withdrawn]',body:'',quote:'',aliases:[],experience:undefined,claim:undefined,pendingClaim:undefined,locator:`withdrawn:${card.sourceId}`} : temporary??latest;
    const path = this.vaultPath(job.table, entity);
    if(job.redactTemporary&&!existsSync(path)&&!(existsSync(dirname(path))&&readdirSync(dirname(path)).some(name=>name.startsWith(path.slice(path.lastIndexOf('/')+1).replace(/\.md$/,'.conflict-'))&&name.endsWith('.md'))))return;
    const body = this.markdown(job.table, entity);
    const effective = this.vaultEntity(job.table, entity);
    const inactive = 'status' in effective && effective.status !== 'active';
    if(!job.redactTemporary&&!job.redactStructuredCard&&!inactive){
      // Record the possible projection before touching the Vault, so a crash cannot lose its cleanup obligation.
      const id=this.vaultRedactionId({table:job.table as VaultRedaction['table'],id:entity.id},entity),origin=this.attachedVaultOrigin()!;
      this.db.prepare('INSERT INTO vault_projection_origins(id,origin,projected) VALUES (?,?,1) ON CONFLICT(id,origin) DO UPDATE SET projected=1').run(id,origin);
    }
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
    this.replayVaultRedactions();
    let processed=0;
    for(const [key,job] of this.vaultJobs){
      if(processed++>=limit)break;
      try{
        let cursorRow:{data:string}|undefined;
        if(job.redactTemporary||job.redactStructuredCard){
          const id=this.vaultRedactionId({table:job.table as VaultRedaction['table'],id:job.entity.id},job.entity);
          cursorRow=this.db.prepare('SELECT data FROM cursors WHERE id = ?').get(id) as {data:string}|undefined;
          const intent=cursorRow&&this.readVaultRedaction(JSON.parse(cursorRow.data) as Entities['cursors']);
          const origin=this.attachedVaultOrigin();
          if(!intent||!origin||intent.version===1||intent.version===2&&intent.origin!==origin||intent.version===3&&!intent.origins.includes(origin)){this.vaultJobs.delete(key);continue;}
        }
        this.publish(job);
        if(cursorRow)this.db.transaction(()=>{
          const cursor=JSON.parse(cursorRow!.data) as Entities['cursors'],intent=this.readVaultRedaction(cursor),origin=this.attachedVaultOrigin()!;
          const remaining=intent.version===3?intent.origins.filter(value=>value!==origin):[];
          const changed=remaining.length
            ?this.db.prepare('UPDATE cursors SET data = ? WHERE id = ? AND data = ?').run(JSON.stringify({...cursor,value:JSON.stringify({...intent,origins:remaining})}),cursor.id,cursorRow!.data)
            :this.db.prepare('DELETE FROM cursors WHERE id = ? AND data = ?').run(cursor.id,cursorRow!.data);
          if(changed.changes)this.db.prepare('UPDATE vault_projection_origins SET projected = 0 WHERE id = ? AND origin = ?').run(cursor.id,origin);
        })();
      }catch(error){throw error instanceof VaultSyncError?error:new VaultSyncError(error);}
      if(this.vaultJobs.get(key)===job)this.vaultJobs.delete(key);
    }
  }

  /** Retry bounded pending projection work outside read snapshots and transactions. */
  reconcileVault():void {
    if(this.readDepth||this.depth)throw new Error('Vault reconciliation requires an idle Store.');
    this.flushVault(32);
    this.checkpointPrivacy();
  }

  private vaultEntity(table: Table, entity: Entities[Table]): Entities[Table] {
    if (table === 'sources') { const s = entity as Entities['sources']; return s.status === 'active' ? s : { ...s, title: '[withdrawn]', content: '', locator: `withdrawn:${s.id}` }; }
    if (table === 'cards') { const c = entity as Entities['cards']; return this.cardActive(c, c) ? c : { ...c, status: 'withdrawn', title: '[withdrawn]', body: '', quote: '', aliases: [], experience: undefined, claim: undefined, pendingClaim: undefined, locator: `withdrawn:${c.sourceId}` }; }
    if (table === 'rules') {
      const r = entity as Entities['rules'];
      if (r.status !== 'active' || r.citations.some(c => { const s = this.get('sources', c.sourceId); return s?.status !== 'active' || s.revision !== c.revision; })) return { ...r, status: 'suspended', title: '[withdrawn]', statement: '[Evidence no longer active]', conditions: '[withdrawn]', exceptions: '[withdrawn]', citations: r.citations.map(c => ({ ...c, quote: '[inactive]', locator: `withdrawn:${c.sourceId}` })) };
    }
    if (table === 'cases') { const c = entity as Entities['cases']; if (c.status !== 'active' || this.get('sources', c.sourceId)?.status !== 'active' || c.decisionSnapshot?.sourceRefs.some(ref => { const source = this.get('sources', ref.id); return source?.status !== 'active' || source.revision !== ref.revision; })) return { ...c, status: 'withdrawn', originalWords: '[withdrawn]', rationale: '[withdrawn]', alternatives: [], outcome: undefined, decisionSnapshot: undefined, outcomes: undefined }; }
    return entity;
  }

  private ordinarySourceIdentity(source: Entities['sources']): boolean {
    return ['file', 'feishu', 'github', 'gitlab', 'conversation', 'manual', 'reading', 'email'].includes(source.kind)
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
      // An editable projection cannot recreate a missing host decision or its
      // frozen snapshot, including one withheld by the startup privacy pass.
      if(table==='cases'&&!existing)continue;
      let sourceEdited: boolean | undefined;
      if (existing && 'status' in existing && existing.status !== 'active') {this.publish({table,entity:existing},true);continue;}
      if (table === 'sources') {
        const s = entity as Entities['sources'];
        delete (s as StoredSource).__hostOpaqueIdentity;
        if (s.retention !== 'permanent' || typeof s.content !== 'string' || typeof s.revision !== 'string' || !['active', 'superseded', 'withdrawn'].includes(s.status)) continue;
        // Purpose normalization is recovery bookkeeping, not an independent content edit.
        sourceEdited = text !== this.markdown(table, entity);
        const canonical = trustedSources.get(s.id);
        s.parentSources = canonical?.parentSources;
        const recoverable = !!canonical || this.recoverableSourceIdentity(s, trustedQuestions);
        // The separately host-bound owner-answer identity is task material, just
        // as it was when recordOwnerDecision created it without an explicit purpose.
        const ownerAnswer = !canonical && recoverable && !this.ordinarySourceIdentity(s);
        s.purpose = canonical ? canonical.purpose ?? 'task' : ownerAnswer || (trustedTasks ??= this.list('tasks')).some(task => task.kind !== 'reference_knowledge' && task.sourceId === s.id && task.sourceRevision === s.revision && task.projectId === s.projectId && task.domain === s.domain) ? 'task' : 'reference';
        if (!canonical && (!recoverable || s.kind === 'file' && s.externalId.startsWith('vault:'))) {
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
