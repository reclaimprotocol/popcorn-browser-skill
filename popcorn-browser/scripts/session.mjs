import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const CLIENT = fileURLToPath(new URL('./credit-client.mjs', import.meta.url));
const DIR = path.resolve(process.env.POPCORN_HOME || path.join(os.homedir(), '.config/popcorn-browser'));
const STATE = path.join(DIR, 'task.json');
const ACTIVITY = path.join(DIR, 'activity.json');
const HEARTBEAT = path.join(DIR, 'watcher.json');
const nap = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function save(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } finally { await fs.unlink(temp).catch(() => {}); }
}
async function read(file, fallback) {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() ||
        (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Private files need mode 0600');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function lock(name, fn) {
  const file = path.join(DIR, `${name}.lock`);
  let handle;
  try { handle = await fs.open(file, 'wx', 0o600); }
  catch { throw new Error(`${name} is locked; check its owning process before removing a stale lock`); }
  try { await handle.writeFile(String(process.pid)); return await fn(); }
  finally { await handle.close(); await fs.unlink(file); }
}
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, ...args], {
      env: { ...process.env, POPCORN_HOME: DIR }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', diagnostic = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { diagnostic += chunk; });
    child.on('error', () => reject(new Error('Could not start credential client')));
    child.on('close', code => {
      if (code !== 0 && code !== 2) {
        const error = new Error('Credential/HTTP call failed; preserve pending operation and inspect authentication/network');
        const retry = diagnostic.match(/Retry-After: ([^\n]+)/)?.[1];
        if (retry) {
          const seconds = Number(retry);
          error.retryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(retry);
        }
        return reject(error);
      }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid credential-client output')); }
    });
  });
}
async function call(tool, args, operationId = crypto.randomUUID()) {
  const argsFile = path.join(DIR, `${operationId}.args.json`);
  const resultFile = path.join(DIR, `${operationId}.result.json`);
  const existing = await read(argsFile, null);
  if (existing && JSON.stringify(existing) !== JSON.stringify(args)) throw new Error('Operation arguments changed');
  if (!existing) await save(argsFile, args);
  await run(['call', tool, argsFile, resultFile]);
  return read(resultFile);
}
function emit(type, data = {}) { console.log(JSON.stringify({ at: new Date().toISOString(), type, ...data })); }
export function validateRenewal(config, tools) {
  if (!config) return null;
  const tool = tools.find(item => item.name === config.tool);
  if (!tool || !Number.isInteger(config.creditCost) || config.creditCost < 1 ||
      !Number.isInteger(config.leadSeconds) || config.leadSeconds < 30 ||
      !config.arguments || typeof config.arguments !== 'object' || Array.isArray(config.arguments) ||
      typeof config.source !== 'string' || !config.source.startsWith('https://')) {
    throw new Error('Renewal configuration must match a discovered tool and independently verified cost/timing');
  }
  const entries = Object.entries(config.arguments);
  if (!entries.some(([, value]) => value === '$SESSION_ID') ||
      !entries.some(([, value]) => value === '$OPERATION_ID')) throw new Error('Renewal must bind the session and an idempotency key');
  for (const key of tool.inputSchema?.required || []) {
    if (!(key in config.arguments)) throw new Error('Renewal is missing a required tool argument');
  }
  if (tool.inputSchema?.additionalProperties === false) {
    for (const [key] of entries) if (!(key in (tool.inputSchema.properties || {}))) throw new Error('Unknown renewal argument');
  }
  return config;
}
export function reserve(state, kind, tool, args, creditCost) {
  if (state.pending) throw new Error('Recover the existing operation first');
  if (!Number.isInteger(creditCost) || creditCost < 0 || state.remainingCredits < creditCost) throw new Error('Approved credit allowance exhausted');
  const id = crypto.randomUUID();
  state.remainingCredits -= creditCost;
  state.pending = { id, kind, tool, creditCost, attempts: 0, args: Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key,
      value === '$SESSION_ID' ? state.session.session_id : value === '$OPERATION_ID' ? id : value]),
  ) };
}
export async function perform(state, persist, invoke = call) {
  const op = state.pending;
  if (!op) return;
  let result = op.result && !op.result.isError ? op.result : null;
  if (!result) {
    if (op.attempts >= 3) throw new Error('Three uncertain attempts; reconcile this operation before spending again');
    if (op.retryAt > Date.now()) throw new Error('Wait before retrying the saved operation');
    op.attempts += 1;
    await persist(state);
    try { result = await invoke(op.tool, op.args, op.id); }
    catch (error) {
      op.retryAt = Number.isFinite(error.retryAt) ? error.retryAt : Date.now() + 10000;
      await persist(state);
      throw error;
    }
    op.result = result;
    await persist(state);
  }
  if (result.isError) {
    const error = result.data?.error;
    if (error === 'insufficient_credit') {
      op.needsFunding = true;
      // The service confirms no allocation/charge. Preserve key for retry after funding.
      op.attempts -= 1;
    }
    op.retryAt = Date.now() + 10000;
    await persist(state);
    return { error, resultFile: path.join(DIR, `${op.id}.result.json`) };
  }
  let data = result.data;
  if (op.kind === 'renew') {
    const confirmed = await invoke('get_browser_session', { session_id: state.session.session_id });
    if (confirmed.isError) throw new Error('Renewal returned success but current session expiry could not be confirmed');
    data = confirmed.data;
  }
  if (!data?.session_id || !Number.isFinite(Date.parse(data.expires_at)) || !data.cdp_url) throw new Error('Invalid session response; preserve the saved operation');
  if (op.kind === 'renew' && (data.session_id !== state.session.session_id ||
      Date.parse(data.expires_at) <= Date.parse(state.session.expires_at))) throw new Error('Renewal did not preserve the session and advance expiry');
  state.session = data;
  state.status = 'active';
  if (op.kind === 'create') {
    state.startedAt = Date.now();
    state.lastActiveAt = state.startedAt;
    state.hardStopAt = state.startedAt + state.maxMinutes * 60000;
  }
  state.spentCredits = (state.spentCredits || 0) + op.creditCost;
  state.receipts = [...(state.receipts || []), { id: op.id, cost: op.creditCost, usageSettled: data.usage_settled ?? null }];
  delete state.pending;
  delete state.renewalError;
  await persist(state);
  return { ok: true };
}
export function decide(state, signal, now, observedAt = 0) {
  if (state.status !== 'active') return 'stop';
  if (signal.mode === 'done' || now >= state.hardStopAt) return 'end';
  if (now >= Date.parse(state.session.expires_at)) return 'expired';
  const agent = signal.mode === 'agent' && signal.until > now;
  const pendingUser = signal.mode === 'wait' && signal.until > now;
  const observed = observedAt > 0 && now - observedAt < 120000;
  if (!agent && !pendingUser && !observed && now - Math.max(state.lastActiveAt, observedAt) >= 300000) return 'end';
  const remaining = Date.parse(state.session.expires_at) - now;
  if ((agent || pendingUser || observed) && remaining <= (state.renewal?.leadSeconds || 120) * 1000) {
    return state.renewal ? 'renew' : 'cannot_renew';
  }
  return 'keep';
}
export function cancelUnchargedOperation(state) {
  if (!state.pending) return;
  const result = state.pending.result;
  if (!result?.isError || !['insufficient_credit', 'billing_unavailable', 'session_unavailable'].includes(result.data?.error)) {
    throw new Error('Resolve the uncertain billed operation before termination');
  }
  state.remainingCredits += state.pending.creditCost;
  delete state.pending;
}
async function end(state) {
  cancelUnchargedOperation(state);
  if (state.status === 'ended') return;
  const result = await call('end_browser_session', { session_id: state.session.session_id });
  if (result.isError) throw new Error('Session termination was not confirmed');
  state.status = 'ended';
  await save(STATE, state);
  emit('ended');
}
async function signal(mode, lease = 120) {
  const state = await read(STATE);
  if (state.status !== 'active') throw new Error('No active session');
  const now = Date.now();
  if (mode === 'wait') lease = state.humanWaitMinutes * 60;
  else if (!Number.isInteger(lease) || lease < 1 || lease > 300) throw new Error('Agent lease must be 1–300 seconds');
  const until = Math.min(now + lease * 1000, state.hardStopAt);
  await save(ACTIVITY, { mode, at: now, until });
  emit(mode === 'wait' ? 'input_pending' : mode, {
    until: new Date(until).toISOString(), expiresAt: state.session.expires_at,
    renewable: Boolean(state.renewal),
  });
}
function summary(state, heartbeat) {
  return { status: state.status, expiresAt: state.session?.expires_at,
    remainingCredits: state.remainingCredits, spentCredits: state.spentCredits || 0,
    renewable: Boolean(state.renewal), pendingOperation: Boolean(state.pending),
    watcherHealthy: Boolean(heartbeat?.at && Date.now() - heartbeat.at < 30000), stateFile: STATE };
}
async function watch() {
  await lock('watcher', async () => {
    const { chromium } = await import('playwright');
    let browser, observedAt = 0, lastReminder = 0, warned = false, lastConnect = 0;
    const name = `__popcorn_${crypto.randomBytes(12).toString('hex')}`;
    const observe = ({ name }) => {
      if (window[`${name}_ready`]) return;
      window[`${name}_ready`] = true;
      let previous = 0;
      const activity = event => {
        if (!event.isTrusted || Date.now() - previous < 5000) return;
        previous = Date.now();
        window[name]().catch(() => {});
      };
      for (const type of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) window.addEventListener(type, activity, true);
    };
    try {
      while (true) {
        let state = await read(STATE);
        if (state.status !== 'active') break;
        if (!browser?.isConnected() && Date.now() - lastConnect >= 30000) {
          lastConnect = Date.now();
          try {
            browser = await chromium.connectOverCDP(state.session.cdp_url, { timeout: 10000 });
            const context = browser.contexts()[0];
            await context.exposeBinding(name, () => { observedAt = Date.now(); });
            await context.addInitScript(observe, { name });
            const attach = page => page.evaluate(observe, { name }).catch(() => {});
            await Promise.all(context.pages().map(attach));
            context.on('page', attach);
          } catch { emit('activity_detection_unavailable'); }
        }
        try {
          await lock('task', async () => {
            state = await read(STATE);
            const intent = await read(ACTIVITY, { mode: 'idle', until: 0 });
            const now = Date.now();
            if (['agent', 'wait'].includes(intent.mode) && intent.until > now) state.lastActiveAt = now;
            state.lastActiveAt = Math.max(state.lastActiveAt, observedAt);
            await save(HEARTBEAT, { pid: process.pid, at: now });
            const action = decide(state, intent, now, observedAt);
            if (action === 'end') { await end(state); return; }
            if (action === 'expired') { state.status = 'expired'; await save(STATE, state); emit('expired'); return; }
            if (action === 'cannot_renew' && !warned) {
              warned = true;
              emit('renewal_unavailable', { expiresAt: state.session.expires_at, message: 'Server cannot extend this browser; relay the deadline to the user now.' });
            }
            if (action === 'renew' && !state.renewalError && !state.pending?.needsFunding) {
              if (!state.pending) {
                reserve(state, 'renew', state.renewal.tool, state.renewal.arguments, state.renewal.creditCost);
                await save(STATE, state);
              }
              if (!state.pending.retryAt || now >= state.pending.retryAt) {
                const result = await perform(state, value => save(STATE, value));
                emit(result.ok ? 'renewed' : 'renewal_pending', { ...result, expiresAt: state.session.expires_at });
              }
            }
            if (intent.mode === 'wait' && intent.until > now && now - lastReminder >= 60000) {
              lastReminder = now;
              emit('input_pending', { expiresAt: state.session.expires_at, renewable: Boolean(state.renewal),
                message: 'Your input is still pending in the Popcorn browser.' });
            }
            await save(STATE, state);
          });
        } catch (error) {
          emit('attention_required', { message: error.code || error.message });
          await lock('task', async () => {
            const latest = await read(STATE);
            if (!latest.pending || latest.pending.attempts >= 3) latest.renewalError = true;
            await save(STATE, latest);
          }).catch(() => {});
        }
        await nap(5000);
      }
    } finally { if (browser) await browser.close().catch(() => {}); }
  });
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  await fs.mkdir(DIR, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(DIR);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Use a real private directory');
  await fs.chmod(DIR, 0o700);
  if (command === 'watch') return watch();
  if (['agent', 'wait', 'idle'].includes(command)) return signal(command, Number(args[0] || 120));
  if (command === 'done') { await signal('done'); return lock('task', async () => end(await read(STATE))); }
  await lock('task', async () => {
    if (command === 'setup') {
      const balance = await run(['balance']);
      const tools = await run(['tools']);
      await save(path.join(DIR, 'tools.json'), tools);
      const renewal = validateRenewal(await read(path.join(DIR, 'renewal.json'), null), tools.tools);
      console.log(JSON.stringify({ balance, renewable: Boolean(renewal), tools: tools.tools.map(tool => tool.name) }));
      return;
    }
    if (command === 'configure') {
      const [credits, maxMinutes = 60, waitMinutes = 10] = args.map(Number);
      if (!Number.isInteger(credits) || credits < 1 || !Number.isInteger(maxMinutes) || maxMinutes < 5 ||
          !Number.isInteger(waitMinutes) || waitMinutes < 1 || waitMinutes > maxMinutes) throw new Error('Provide credit allowance, maximum session minutes, and input-wait minutes');
      const state = await read(STATE, {});
      if (state.pending || state.status === 'active') throw new Error('Do not change policy during an active or pending operation');
      Object.assign(state, { remainingCredits: credits, maxMinutes, humanWaitMinutes: waitMinutes, status: 'ready' });
      await save(STATE, state);
      console.log(JSON.stringify(summary(state)));
      return;
    }
    const state = await read(STATE);
    if (command === 'status') { console.log(JSON.stringify(summary(state, await read(HEARTBEAT, null)))); return; }
    if (command === 'start') {
      if (state.pending) throw new Error('Use recover with the original operation');
      if (state.status === 'active') { console.log(JSON.stringify(summary(state))); return; }
      const tools = await run(['tools']);
      const renewal = validateRenewal(await read(path.join(DIR, 'renewal.json'), null), tools.tools);
      if (!renewal && !args.includes('--allow-fixed')) throw new Error('Live server has no configured renewal capability. User must accept a fixed-duration session before using --allow-fixed');
      const balance = await run(['balance']);
      if (balance.isError || !Number.isInteger(balance.credits_per_operation)) throw new Error('Could not verify credit cost');
      const now = Date.now();
      Object.assign(state, { status: 'starting', purpose: args.filter(arg => arg !== '--allow-fixed').join(' ') || 'Browser task',
        startedAt: now, lastActiveAt: now, hardStopAt: now + state.maxMinutes * 60000,
        spentCredits: 0, receipts: [], renewal });
      delete state.session;
      delete state.renewalError;
      reserve(state, 'create', 'create_browser_session', { purpose: state.purpose, idempotency_key: '$OPERATION_ID' }, balance.metered ? balance.credits_per_operation : 0);
      await save(STATE, state);
      await save(ACTIVITY, { mode: 'agent', at: now, until: now + 120000 });
      const result = await perform(state, value => save(STATE, value));
      if (result.ok) await save(ACTIVITY, { mode: 'agent', at: Date.now(), until: Date.now() + 120000 });
      console.log(JSON.stringify({ ...summary(state), ...result }));
      if (result.error) process.exitCode = 2;
      return;
    }
    if (command === 'recover') {
      const creating = state.pending?.kind === 'create';
      const result = await perform(state, value => save(STATE, value));
      if (creating && result?.ok) await save(ACTIVITY, { mode: 'agent', at: Date.now(), until: Date.now() + 120000 });
      console.log(JSON.stringify({ ...summary(state), ...(result || {}) }));
      if (result?.error) process.exitCode = 2;
      return;
    }
    if (command === 'end') return end(state);
    if (command === 'live') {
      if (state.status !== 'active') throw new Error('No active browser');
      console.log(state.session.live_view_url);
      return;
    }
    throw new Error('Commands: setup, configure CREDITS MAX_MINUTES WAIT_MINUTES, start PURPOSE, watch, agent [SECONDS], wait, idle, done, status, live, recover, end');
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Popcorn: ${error.code || error.message}`); process.exitCode = 1; });
}
