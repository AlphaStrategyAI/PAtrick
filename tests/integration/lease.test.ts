import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { acquireHostLease } from '../../src/lease.js';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
it('permits one writer and releases idempotently without stealing a replacement marker',()=>{
  const dir=mkdtempSync(join(tmpdir(),'patrick-lease-'));roots.push(dir);const first=acquireHostLease(dir);
  expect(()=>acquireHostLease(dir)).toThrow(/writer|host/i);first.release();first.release();
  const second=acquireHostLease(dir),replacement={...second.marker,leaseId:'f'.repeat(32)};writeFileSync(join(dir,'writer.lock'),JSON.stringify(replacement));second.release();expect(JSON.parse(readFileSync(join(dir,'writer.lock'),'utf8'))).toEqual(replacement);
});
