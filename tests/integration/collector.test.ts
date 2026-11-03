import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { SourceCollector } from '../../src/collector.js';
import { Store } from '../../src/store.js';
import { Workbench } from '../../src/orchestrator.js';
import { readConfig } from '../../src/config.js';
import { configureDemo, demoResearch, demoWriter } from '../../src/demo.js';
it('recovers a missed file event and withdraws a deleted source after complete scans',async()=>{
  const root=mkdtempSync(join(tmpdir(),'patrick-collector-')),store=new Store(':memory:'),config=readConfig({PATRICK_MODE:'demo'});configureDemo(config);
  config.projects[0]!.sourceDir=root;
  const engine=new Workbench({store,config,workers:[],writer:demoWriter,research:demoResearch});const collector=new SourceCollector(store,config,engine);
  try{
    writeFileSync(join(root,'idea.md'),'# 草稿恢复\n导出失败后应恢复草稿。');
    await collector.scan();await collector.scan();expect(store.list('tasks')).toHaveLength(1);
    writeFileSync(join(root,'missed.md'),'# 漏通知\n由全量补扫恢复。');await collector.scan();expect(store.list('tasks')).toHaveLength(2);
    const source=store.list('sources').find(s=>s.title==='草稿恢复')!;unlinkSync(join(root,'idea.md'));await collector.scan();expect(store.get('sources',source.id)?.status).toBe('withdrawn');
    writeFileSync(join(root,'idea.md'),'# 草稿恢复\n导出失败后应恢复草稿。');await collector.scan();
    expect(store.list('sources').filter(s=>s.externalId==='file:idea.md')).toHaveLength(2);
    writeFileSync(join(root,'idea.md'),'# 草稿恢复\n新版 B。');await collector.scan();
    writeFileSync(join(root,'idea.md'),'# 草稿恢复\n导出失败后应恢复草稿。');await collector.scan();await collector.scan();
    const lineage=store.list('sources').filter(s=>s.externalId==='file:idea.md');expect(lineage).toHaveLength(4);expect(lineage.filter(s=>s.status==='active')).toHaveLength(1);
  }finally{await collector.stop();store.close();rmSync(root,{recursive:true,force:true});}
});
