import { mkdtempSync, writeFileSync, unlinkSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { SourceCollector } from '../../src/collector.js';
import { Store } from '../../src/store.js';
import { Workbench } from '../../src/orchestrator.js';
import { ingestSource } from '../../src/intake.js';
import { readConfig } from '../../src/config.js';
import { configureDemo, demoResearch, demoWriter } from '../../src/demo.js';
it('recovers a missed file event and withdraws a deleted source after complete scans',async()=>{
  const root=mkdtempSync(join(tmpdir(),'patrick-collector-')),store=new Store(':memory:'),config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);
  config.projects[0]!.sourceDir=root;
  const engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});const collector=new SourceCollector(store,config,engine);
  const file=join(root,'idea.md'),original='# 草稿恢复\n导出失败后应恢复草稿。',fixedTime=new Date('2020-01-01T00:00:00.000Z');
  const writeAtSameTime=(content:string)=>{writeFileSync(file,content);utimesSync(file,fixedTime,fixedTime);expect(statSync(file).mtimeMs).toBe(fixedTime.getTime());};
  const lineage=()=>store.list('sources').filter(s=>s.kind==='file'&&(s.externalId==='file:idea.md'||s.externalId===store.auditTemporaryRevision('file:idea.md')));
  try{
    writeAtSameTime(original);
    await collector.scan();expect(store.list('events').filter(event=>event.type==='source.missed')).toHaveLength(0);
    await collector.scan();expect(store.list('tasks')).toHaveLength(1);expect(store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest')).toHaveLength(1);
    writeFileSync(join(root,'missed.md'),'# 漏通知\n由全量补扫恢复。');await collector.scan();expect(store.list('tasks')).toHaveLength(2);expect(store.list('actions').filter(a=>a.kind==='knowledge.structured-ingest')).toHaveLength(2);
    expect(store.list('events').filter(event=>event.type==='source.missed')).toHaveLength(1);
    const source=store.list('sources').find(s=>s.title==='草稿恢复')!;unlinkSync(file);await collector.scan();
    expect(store.get('sources',source.id)).toMatchObject({status:'withdrawn',content:'',externalId:store.auditTemporaryRevision(source.externalId),revision:store.auditTemporaryRevision(source.revision),authorId:store.auditTemporaryRevision(source.authorId)});
    expect(store.get('sources',source.id)?.locator).not.toBe(source.locator);
    expect(()=>ingestSource(store,config,{projectId:source.projectId,kind:'file',externalId:source.externalId,revision:source.revision,title:source.title,content:source.content,locator:source.locator,authorId:source.authorId,retention:'permanent'})).toThrowError(expect.objectContaining({code:'revoked_revision'}));
    writeAtSameTime(original);await collector.scan();
    expect(lineage()).toHaveLength(2);expect(new Set(lineage().map(s=>s.id)).size).toBe(2);
    writeAtSameTime('# 草稿恢复\n新版 B。');await collector.scan();
    writeAtSameTime(original);await collector.scan();await collector.scan();
    expect(lineage()).toHaveLength(4);expect(new Set(lineage().map(s=>s.id)).size).toBe(4);expect(lineage().filter(s=>s.status==='active')).toHaveLength(1);
    expect(store.get('sources',source.id)?.status).toBe('withdrawn');
  }finally{await collector.stop();store.close();rmSync(root,{recursive:true,force:true});}
});
