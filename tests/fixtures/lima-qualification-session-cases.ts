export const malformedQualificationSessionCases = [
  'registry-extra','records-duplicate','record-token','binding-shape',
  'binding-duplicate','marker-null','marker-shape','code-key',
  'network-lineage','network-role','network-token','network-reserved-record',
  'network-role-phase','network-complete-phase','network-owner','network-record-shape',
] as const;

export type QualificationSessionFault = typeof malformedQualificationSessionCases[number];

export function addCompletedQualificationNetworkOperation(session: any): void {
  session.networkOperation = {
    version:1,generation:session.generation,artifactHash:session.artifactHash,
    policyHash:session.policyHash,inventoryHash:session.inventoryHash,
    owner:{pid:5678,startTime:'12345',bootId:'01234567-89ab-4cde-8fab-0123456789ab'},
    phase:'complete',preconditionRequests:{header:0,tls:1},
    roles:['grok','codex','dsh'].map((role,index)=>({role,token:String(index+1).repeat(32),phase:'closed',steps:1})),
  };
}

export function corruptQualificationSession(session: any, kind: QualificationSessionFault): void {
  const op = session.networkOperation;
  if(kind==='registry-extra')session.registry.extra=true;
  if(kind==='records-duplicate')session.records=['b'.repeat(32),'b'.repeat(32)];
  if(kind==='record-token')session.records=['invalid'];
  if(kind==='binding-shape')delete session.bindings[0].domain;
  if(kind==='binding-duplicate')session.bindings[1].runner='grok';
  if(kind==='marker-null')session.bindings[0].markers[0]=null;
  if(kind==='marker-shape')session.bindings[0].markers[0].removed=true;
  if(kind==='code-key')session.codeHashes.untrusted='f'.repeat(64);
  if(kind==='network-lineage')op.policyHash='b'.repeat(64);
  if(kind==='network-role')op.roles[1].role='grok';
  if(kind==='network-token')op.roles[1].token=op.roles[0].token;
  if(kind==='network-reserved-record'){op.phase='running';op.roles[0].phase='reserved';session.records=[op.roles[0].token];}
  if(kind==='network-role-phase')op.roles[0].phase='invalid';
  if(kind==='network-complete-phase')op.roles[0].phase='client';
  if(kind==='network-owner')op.owner=null;
  if(kind==='network-record-shape')session.records=null;
}
