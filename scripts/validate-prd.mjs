import { readFileSync } from 'node:fs';
const path=process.argv[2]??'docs/product/PRD.md';
const content=readFileSync(path,'utf8');
if(!/^# PAtrick\b/m.test(content)||!/^## Acceptance criteria\s*$/m.test(content)||!/^## Operational boundary\s*$/m.test(content)||!/^- .+/m.test(content))throw Error('Formal PAtrick PRD must preserve its title, acceptance criteria and operational boundary.');
console.log(`PRD structure verified: ${path}`);
