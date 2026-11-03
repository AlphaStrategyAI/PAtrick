import { describe, expect, it } from 'vitest';
import { BilingualResearch, validateResearch, safeResearchUrl } from '../../src/integrations/research.js';
import { readConfig } from '../../src/config.js';
import type { Project } from '../../src/domain.js';
describe('research evidence', () => {
  it('does not send a private-domain question to a personal search gateway',async()=>{
    let calls=0;const adapter=new BilingualResearch({...readConfig({}),researchUrl:'https://search.example.org'},async()=>{calls++;throw Error('should not send');});
    await expect(adapter.research('PRIVATE_SENTINEL',{domain:'company',id:'p'} as Project)).rejects.toThrow(/not authorized/);expect(calls).toBe(0);
  });
  it('does not treat a translation as independent corroboration', () => {
    const source={url:'https://example.org/a',canonicalUrl:'https://example.org/a',title:'Original',language:'en' as const,publishedAt:'2026-01-01',accessedAt:'2026-11-03',excerpt:'Evidence',primary:true,conditions:'Product'};
    expect(()=>validateResearch({queries:[{language:'en',query:'draft',searchedAt:'today',sources:[source]},{language:'zh',query:'草稿',searchedAt:'today',sources:[{...source,url:'https://example.org/translation',language:'zh'}]}],summary:'',gaps:[]})).toThrow();
  });
  it('rejects internal URLs and non-web schemes', () => {
    for (const value of ['http://127.0.0.1/admin','https://localhost/key','file:///etc/passwd','https://169.254.169.254/latest','https://10.1.1.1/','https://[::1]/']) expect(()=>safeResearchUrl(value)).toThrow();
    expect(safeResearchUrl('https://www.sqlite.org/fts5.html').hostname).toBe('www.sqlite.org');
  });
});
