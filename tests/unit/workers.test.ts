import { describe, expect, it } from 'vitest';
import { parseWorkerOutput, commandFor, guestScripts } from '../../src/integrations/workers.js';
describe('worker protocols', () => {
  it('ships syntactically executable isolation, test and cleanup scripts', () => {
    for(const script of Object.values(guestScripts))expect(()=>new Function(script)).not.toThrow();
  });
  it('unwraps structured CLI envelopes without accepting arbitrary logs as JSON', () => {
    expect(parseWorkerOutput('{"structured_output":{"summary":"ok"}}')).toEqual({summary:'ok'});
    expect(parseWorkerOutput('```json\n{"summary":"ok"}\n```')).toEqual({summary:'ok'});
    expect(()=>parseWorkerOutput('Authorization failed')).toThrow();
  });
  it('uses read-only, ephemeral noninteractive Codex and constrained Grok output', () => {
    expect(commandFor('codex','model').args).toContain('read-only');
    expect(commandFor('codex','model').args).toContain('--ephemeral');
    expect(commandFor('grok','model').args).toContain('--no-subagents');
    expect(commandFor('grok','model').args).toContain('--json-schema');
  });
});
