import { it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/store.js';
import { createBackup } from '../../src/backup.js';
import { restoreBackup } from '../../scripts/restore.js';
import { withdrawSource } from '../../src/intake.js';
import { ingestStructuredKnowledge } from '../../src/knowledge.js';
import { factualEligibility } from '../../src/knowledge-use.js';
import { repositoryKnowledgeFixture, H, H2 } from '../fixtures/repository-knowledge.js';

it('retains H1 history across H2 and outage, then withdraws it across reopen and backup',async()=>{
  const root=mkdtempSync(join(tmpdir(),'g9-lifecycle-')),db=join(root,'db'),vault=join(root,'vault'),backup=join(root,'backup'),destination=join(root,'restored');
  const seed=repositoryKnowledgeFixture('github'),project=seed.project;seed.close();
  let store=new Store(db,vault); const f=repositoryKnowledgeFixture('github',{store,project});
  try {
    expect(await ingestStructuredKnowledge(store,f.reader,f.source.id,new AbortController().signal)).toBe('processed');
    const card=store.list('cards').find(c=>c.claim?.claim.kind==='ci-result')!;
    expect(card).toBeDefined(); expect(factualEligibility(store,card,project,{temporal:'historical'}).eligible).toBe(true);
    expect(f.routes['/pulls/17'].head.sha).toBe(H2); expect(card.claim?.claim.subject).toMatchObject({headSha:H});
    f.setOverride(()=>new Response('unavailable',{status:503}));
    expect(await ingestStructuredKnowledge(store,f.reader,f.source.id,new AbortController().signal,{refresh:'current'})).toBe('pending');
    expect(factualEligibility(store,card,project,{temporal:'current',contextId:'unavailable'}).eligible).toBe(false);
    expect(factualEligibility(store,card,project,{temporal:'historical'}).eligible).toBe(true);
    withdrawSource(store,f.source.id);
    expect(factualEligibility(store,card,project,{temporal:'historical'}).eligible).toBe(false);
    expect(store.searchCards('validate',project)).toEqual([]);
    await createBackup(store,backup,{mode:'test',vaultDir:vault});store.close();
    restoreBackup({snapshot:backup,destination,writerRevoked:true,reconciled:true});
    for(const [path,vaultPath] of [[db,vault],[join(destination,'patrick.db'),join(destination,'vault')]]) {const reopened=new Store(path!,vaultPath!);try {
      expect(reopened.get('sources',f.source.id)?.status).toBe('withdrawn');
      expect(reopened.searchCards('validate',project)).toEqual([]);
      expect(factualEligibility(reopened,card,project,{temporal:'historical'}).eligible).toBe(false);
    } finally {reopened.close();}}
  } finally {store.close();rmSync(root,{recursive:true,force:true});}
});
