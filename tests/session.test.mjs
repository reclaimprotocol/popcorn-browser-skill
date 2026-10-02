import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decide, validateRenewal, reserve, perform, save, cancelUnchargedOperation } from '../popcorn-browser/scripts/session.mjs';

const now = 1800000000000;
const session = (extra = {}) => ({ session_id: 'same-browser', cdp_url: 'wss://example.invalid/cdp?secret=opaque',
  live_view_url: 'https://example.invalid/view?secret=opaque', expires_at: new Date(now + 600000).toISOString(), ...extra });
const state = (extra = {}) => ({ status: 'active', session: session(), lastActiveAt: now,
  hardStopAt: now + 3600000, remainingCredits: 5, maxMinutes: 60, ...extra });
const idle = { mode: 'idle', until: 0 };
const persist = async () => {};

test('idle session terminates at five minutes even with paid time left', () => {
  assert.equal(decide(state(), idle, now + 299999), 'keep');
  assert.equal(decide(state(), idle, now + 300000), 'end');
});
test('pending input protects a user before any keystroke', () => {
  assert.equal(decide(state(), { mode: 'wait', until: now + 600000 }, now + 300000), 'keep');
});
test('renewal follows live work, not open tabs or background connections', () => {
  const s = state({ renewal: { leadSeconds: 120 }, lastActiveAt: now + 470000 });
  assert.equal(decide(s, { mode: 'agent', until: now + 600000 }, now + 490000), 'renew');
  assert.equal(decide(s, idle, now + 490000), 'keep');
});
test('pending human and recent browser input both trigger real renewal', () => {
  const s = state({ renewal: { leadSeconds: 120 } });
  assert.equal(decide(s, { mode: 'wait', until: now + 600000 }, now + 490000), 'renew');
  assert.equal(decide(s, idle, now + 490000, now + 489000), 'renew');
});
test('missing extension support warns instead of pretending to renew', () => {
  assert.equal(decide(state(), { mode: 'wait', until: now + 600000 }, now + 490000), 'cannot_renew');
});
test('expired lease eventually stops renewal and terminates idle browser', () => {
  assert.equal(decide(state(), { mode: 'agent', until: now + 120000 }, now + 300000), 'end');
});
test('completion and maximum runtime stop even when activity is present', () => {
  assert.equal(decide(state(), { mode: 'done' }, now + 1), 'end');
  assert.equal(decide(state({ hardStopAt: now + 1000 }), { mode: 'agent', until: now + 600000 }, now + 1000), 'end');
});
test('server expiry cannot be prevented by a client activity flag', () => {
  assert.equal(decide(state(), { mode: 'wait', until: now + 900000 }, now + 600000), 'expired');
});

const renewal = { tool: 'actual_verified_extension', arguments: { session_id: '$SESSION_ID', idempotency_key: '$OPERATION_ID', blocks: 1 },
  creditCost: 1, leadSeconds: 120, source: 'https://official.example/docs' };
const tools = [{ name: renewal.tool, inputSchema: { required: ['session_id', 'idempotency_key'], additionalProperties: false,
  properties: { session_id: {}, idempotency_key: {}, blocks: {} } } }];
test('renewal configuration is gated by a real discovered schema', () => {
  assert.equal(validateRenewal(null, []), null);
  assert.throws(() => validateRenewal(renewal, []), /discovered tool/);
  assert.deepEqual(validateRenewal(renewal, tools), renewal);
  assert.throws(() => validateRenewal({ ...renewal, arguments: { ...renewal.arguments, made_up: true } }, tools), /Unknown renewal/);
  assert.throws(() => validateRenewal({ ...renewal, arguments: { session_id: '$SESSION_ID' } }, tools), /idempotency/);
});
test('a new operation reserves allowance once and binds session/key', () => {
  const s = state();
  reserve(s, 'renew', renewal.tool, renewal.arguments, 1);
  assert.equal(s.remainingCredits, 4);
  assert.equal(s.pending.args.session_id, s.session.session_id);
  assert.equal(s.pending.args.idempotency_key, s.pending.id);
  assert.throws(() => reserve(s, 'renew', renewal.tool, renewal.arguments, 1), /existing operation/);
});
test('budget exhaustion prevents allocation before any remote request', () => {
  const s = state({ remainingCredits: 0 });
  assert.throws(() => reserve(s, 'create', 'create_browser_session', {}, 1), /allowance exhausted/);
  assert.equal(s.pending, undefined);
});
test('ambiguous retry retains the exact key/arguments and allowance', async () => {
  const s = state();
  reserve(s, 'create', 'create_browser_session', { purpose: 'test', idempotency_key: '$OPERATION_ID' }, 1);
  const requests = [];
  const invoke = async (name, args, id) => {
    requests.push({ name, args: structuredClone(args), id });
    if (requests.length === 1) throw new Error('lost response');
    return { isError: false, data: session() };
  };
  await assert.rejects(perform(s, persist, invoke), /lost response/);
  assert.equal(s.remainingCredits, 4);
  s.pending.retryAt = 0;
  await perform(s, persist, invoke);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(s.remainingCredits, 4);
  assert.equal(s.spentCredits, 1);
  assert.equal(s.pending, undefined);
});
test('Retry-After is retained and prevents an early paid retry', async () => {
  const s = state();
  reserve(s, 'create', 'create_browser_session', {}, 1);
  const error = new Error('retry');
  error.retryAt = Date.now() + 60000;
  await assert.rejects(perform(s, persist, async () => { throw error; }));
  assert.equal(s.pending.retryAt, error.retryAt);
  await assert.rejects(perform(s, persist, async () => assert.fail('must not call')), /Wait before retrying/);
});
test('insufficient credit preserves checkout guidance and same operation', async () => {
  const s = state();
  reserve(s, 'create', 'create_browser_session', {}, 1);
  const id = s.pending.id;
  const result = await perform(s, persist, async () => ({ isError: true,
    data: { error: 'insufficient_credit', next_action: { url: 'https://checkout.example/private' } } }));
  assert.equal(result.error, 'insufficient_credit');
  assert.equal(s.pending.id, id);
  assert.equal(s.pending.needsFunding, true);
  assert.equal(s.pending.attempts, 0);
  assert.equal(s.spentCredits, undefined);
});
test('three uncertain calls stop without creating another operation', async () => {
  const s = state();
  reserve(s, 'create', 'create_browser_session', {}, 1);
  let calls = 0;
  const invoke = async () => { calls++; throw new Error('uncertain'); };
  for (let i = 0; i < 3; i++) { s.pending.retryAt = 0; await assert.rejects(perform(s, persist, invoke)); }
  await assert.rejects(perform(s, persist, invoke), /Three uncertain/);
  assert.equal(calls, 3);
});
test('confirmed paid result survives a crash without replaying the paid tool', async () => {
  const s = state();
  reserve(s, 'create', 'create_browser_session', {}, 1);
  s.pending.attempts = 3;
  s.pending.result = { isError: false, data: session() };
  await perform(s, persist, async () => assert.fail('must use saved result'));
  assert.equal(s.status, 'active');
  assert.equal(s.spentCredits, 1);
});
test('renewal verifies the same browser and a later expiry using session status', async () => {
  const s = state();
  reserve(s, 'renew', renewal.tool, renewal.arguments, 1);
  const requests = [];
  await perform(s, persist, async name => {
    requests.push(name);
    return { isError: false, data: name === renewal.tool ? { accepted: true } : session({ expires_at: new Date(now + 900000).toISOString() }) };
  });
  assert.deepEqual(requests, [renewal.tool, 'get_browser_session']);
  assert.equal(s.session.session_id, 'same-browser');
  assert.equal(s.session.expires_at, new Date(now + 900000).toISOString());
});
test('a replacement browser or unchanged deadline is not accepted as renewal', async () => {
  for (const response of [session(), session({ session_id: 'replacement', expires_at: new Date(now + 900000).toISOString() })]) {
    const s = state();
    reserve(s, 'renew', renewal.tool, renewal.arguments, 1);
    await assert.rejects(perform(s, persist, async () => ({ isError: false, data: response })), /preserve the session/);
    assert.ok(s.pending);
  }
});
test('private records are mode 0600 and atomically replace the old value', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'popcorn-storage-'));
  const file = path.join(dir, 'state.json');
  await save(file, { secret: 'first' });
  await save(file, { secret: 'second' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { secret: 'second' });
  assert.deepEqual(await fs.readdir(dir), ['state.json']);
  await fs.rm(dir, { recursive: true });
});

test('confirmed insufficient renewal credit does not block immediate termination', () => {
  const s = state();
  reserve(s, 'renew', renewal.tool, renewal.arguments, 1);
  s.pending.result = { isError: true, data: { error: 'insufficient_credit' } };
  cancelUnchargedOperation(s);
  assert.equal(s.pending, undefined);
  assert.equal(s.remainingCredits, 5);
  assert.equal(s.session.session_id, 'same-browser');
});
test('unknown payment outcome is not silently refunded or discarded', () => {
  const s = state();
  reserve(s, 'renew', renewal.tool, renewal.arguments, 1);
  assert.throws(() => cancelUnchargedOperation(s), /uncertain billed/);
  assert.equal(s.remainingCredits, 4);
  assert.ok(s.pending);
});
