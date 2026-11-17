import { expect, test } from 'vitest';
import { createCommandJournal, type CommandAttempt } from '../../apps/web/src/api/command-journal.js';

const identity = { account_id: 'owner', caller_id: 'web', data_domain: 'personal', permission_epoch: 7 };
const intent = {
  operation: 'createConsultation', parameters: {}, requestId: 'stable-id',
  command: { expected_revision: null, payload: { text: 'draft', parent_work_id: null, request_scope: identity } },
};
const sending: CommandAttempt = { phase: 'sending', intent };

test('resets hide in-flight command data, restore the same binding, and ignore late outcomes', () => {
  const journal = createCommandJournal();
  journal.verify(identity);
  expect(journal.replace('consultation', undefined, sending)).toBe(true);
  journal.hide('reset');
  expect(journal.scope(identity, identity.caller_id)).toBeUndefined();
  expect(journal.snapshot()).toEqual({});
  const late: CommandAttempt = { phase: 'received', intent, receiptUrl: '/api/v1/consultations/late' };
  expect(journal.replace('consultation', sending, late)).toBe(false);
  journal.verify(identity);
  expect(journal.snapshot().consultation).toMatchObject({ phase: 'retry', intent });
  expect(journal.replace('consultation', sending, late)).toBe(false);
});

test.each([
  ['account', { ...identity, account_id: 'other' }],
  ['domain', { ...identity, data_domain: 'work-company' }],
  ['caller', { ...identity, caller_id: 'different' }],
  ['epoch', { ...identity, permission_epoch: 8 }],
] as const)('reset plus a different %s irreversibly discards the other command', (_field, replacement) => {
  const journal = createCommandJournal();
  journal.verify(identity);
  journal.replace('consultation', undefined, sending);
  journal.hide('reset');
  journal.verify(replacement);
  expect(journal.snapshot()).toEqual({});
  journal.verify(identity);
  expect(journal.snapshot()).toEqual({});
});

test('a definitive revocation erases parked commands even when the browser signs back into the same scope', () => {
  const journal = createCommandJournal();
  journal.verify(identity);
  journal.replace('consultation', undefined, sending);
  journal.hide('reset');
  journal.hide('revoked');
  journal.verify(identity);
  expect(journal.snapshot()).toEqual({});
});
