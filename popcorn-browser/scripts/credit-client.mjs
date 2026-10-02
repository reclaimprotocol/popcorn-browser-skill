import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE = 'https://popcorn-mcp-gcp.reclaimprotocol.org';
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = 'http://127.0.0.1:43891/callback';
const DIR = path.resolve(process.env.POPCORN_HOME || path.join(os.homedir(), '.config/popcorn-browser'));
const CREDENTIALS = path.join(DIR, 'credentials.json');
const LOCK = path.join(DIR, '.lock');
const random = () => crypto.randomBytes(32).toString('base64url');

async function privateDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Use a private, real directory');
  await fs.chmod(dir, 0o700);
}
async function save(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => {});
  }
}
async function load(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Expected a private regular file');
  if (process.platform !== 'win32' && (stat.mode & 0o077)) throw new Error('Private file must have mode 0600');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function request(route, { method = 'GET', json, form, token, protocol } = {}) {
  const url = new URL(route, BASE);
  if (url.origin !== BASE) throw new Error('Refusing a different service origin');
  const headers = { Accept: 'application/json, text/event-stream' };
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (protocol) headers['MCP-Protocol-Version'] = protocol;
  let response;
  try {
    response = await fetch(url, {
      method, headers, redirect: 'manual', signal: AbortSignal.timeout(90000),
      body: form ? new URLSearchParams(form).toString() : json !== undefined ? JSON.stringify(json) : undefined,
    });
  } catch {
    throw new Error('Network failure; preserve allocation arguments and retry the same operation');
  }
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { response, text, data };
}
function requireStatus(reply, status, step) {
  if (reply.response.status !== status) {
    const retry = reply.response.headers.get('retry-after');
    throw new Error(`${step}: HTTP ${reply.response.status}${retry ? `; Retry-After: ${retry}` : ''}`);
  }
}
async function login(state) {
  const metadata = await request('/.well-known/oauth-authorization-server');
  requireStatus(metadata, 200, 'OAuth discovery');
  for (const [key, endpoint] of Object.entries({
    issuer: BASE, registration_endpoint: `${BASE}/oauth/register`,
    authorization_endpoint: `${BASE}/oauth/authorize`, token_endpoint: `${BASE}/oauth/token`,
  })) {
    if (metadata.data?.[key] !== endpoint) throw new Error('OAuth endpoints changed; review official documentation');
  }
  if (!state.client_id) {
    const registered = await request('/oauth/register', { method: 'POST', json: {
      client_name: 'Popcorn portable skill', redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], response_types: ['code'],
    } });
    requireStatus(registered, 201, 'Client registration');
    if (typeof registered.data?.client_id !== 'string') throw new Error('Missing client ID');
    state.client_id = registered.data.client_id;
    await save(CREDENTIALS, state);
  }
  const verifier = random();
  const csrf = random();
  const params = {
    client_id: state.client_id, redirect_uri: REDIRECT, state: csrf,
    scope: 'popcorn.sessions popcorn.credit', resource: RESOURCE,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
  };
  const page = await request(`/oauth/authorize?${new URLSearchParams({
    ...params, response_type: 'code', code_challenge_method: 'S256',
  })}`);
  requireStatus(page, 200, 'Device challenge');
  const form = page.text.match(/<form\b[^>]*\bid="approve"[^>]*>/)?.[0];
  const nonce = form?.match(/\bdata-nonce="([A-Za-z0-9_-]+)"/)?.[1];
  if (!nonce || !form.includes('action="/oauth/decision"')) {
    throw new Error('Device flow changed; use supported OAuth or review the server implementation');
  }
  const signature = crypto.sign('sha256', Buffer.from(nonce), {
    key: state.private_key, dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  const decision = await request('/oauth/decision', { method: 'POST', form: {
    ...params, nonce, public_key: JSON.stringify(state.public_key), signature,
  } });
  requireStatus(decision, 302, 'Device authorization');
  const location = decision.response.headers.get('location');
  if (!location) throw new Error('Missing OAuth callback');
  const callback = new URL(location);
  const expected = new URL(REDIRECT);
  if (callback.origin !== expected.origin || callback.pathname !== expected.pathname ||
      callback.searchParams.get('state') !== csrf || !callback.searchParams.get('code')) {
    throw new Error('Invalid OAuth callback or state');
  }
  // Do not follow the loopback redirect. Exchange this client's code directly.
  const token = await request('/oauth/token', { method: 'POST', form: {
    grant_type: 'authorization_code', client_id: state.client_id, redirect_uri: REDIRECT,
    code: callback.searchParams.get('code'), code_verifier: verifier, resource: RESOURCE,
  } });
  requireStatus(token, 200, 'Token exchange');
  if (typeof token.data?.access_token !== 'string' ||
      !Number.isFinite(token.data.expires_in) || token.data.expires_in <= 0 ||
      token.data.token_type?.toLowerCase() !== 'bearer') throw new Error('Invalid token response');
  state.access_token = token.data.access_token;
  state.expires_at = Date.now() + token.data.expires_in * 1000;
  await save(CREDENTIALS, state);
}
async function rpc(state, method, params, protocol, notification = false) {
  const id = crypto.randomUUID();
  const reply = await request('/mcp', { method: 'POST', token: state.access_token, protocol,
    json: { jsonrpc: '2.0', ...(notification ? {} : { id }), method, params } });
  if (reply.response.status === 401) {
    // Do not silently undo an identity-wide revocation by signing in again.
    throw new Error('Access rejected; check expiry/revocation. Run reauth only if reconnecting is intended');
  }
  requireStatus(reply, notification ? 202 : 200, method);
  if (notification) return;
  if (reply.data?.jsonrpc !== '2.0' || reply.data.id !== id || reply.data.error || !('result' in reply.data)) {
    throw new Error(`${method}: invalid JSON-RPC result; inspect protocol compatibility`);
  }
  return reply.data.result;
}
function unpack(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  for (const item of result.content || []) {
    if (item.type === 'text') { try { return JSON.parse(item.text); } catch {} }
  }
  return null;
}
async function main() {
  const [command, tool, argsFile, outputFile] = process.argv.slice(2);
  if (!['balance', 'tools', 'call', 'reauth'].includes(command) ||
      (command === 'call' && (!tool || !argsFile || !outputFile))) {
    throw new Error('Usage: popcorn.mjs balance | tools | reauth | call TOOL PRIVATE_ARGS_JSON PRIVATE_RESULT_JSON');
  }
  // Validate paths and arguments before making any remote call.
  const args = command === 'call' ? await load(path.resolve(argsFile)) : {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Arguments must be an object');
  if (tool === 'create_browser_session' &&
      (typeof args.idempotency_key !== 'string' || !args.idempotency_key.trim() ||
       typeof args.purpose !== 'string' || !args.purpose.trim())) {
    throw new Error('Persist purpose and idempotency_key before allocating');
  }
  const out = outputFile ? path.resolve(outputFile) : null;
  if (out && [CREDENTIALS, LOCK, path.resolve(argsFile)].includes(out)) throw new Error('Use a separate result path');
  if (out) {
    const parent = await fs.lstat(path.dirname(out));
    if (!parent.isDirectory() || parent.isSymbolicLink() ||
        (process.platform !== 'win32' && (parent.mode & 0o077))) throw new Error('Result directory must be private (0700)');
  }
  await privateDirectory(DIR);
  const lock = await fs.open(LOCK, 'wx', 0o600).catch(() => {
    throw new Error('Identity locked by another command; wait. Remove stale lock only after confirming it has exited');
  });
  try {
    await lock.writeFile(String(process.pid));
    let state;
    try { state = await load(CREDENTIALS); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const { kty, crv, x, y } = pair.publicKey.export({ format: 'jwk' });
      state = { origin: BASE, public_key: { kty, crv, x, y },
        private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
      await save(CREDENTIALS, state);
    }
    if (state.origin !== BASE) throw new Error('Stored identity belongs to another origin');
    if (command === 'reauth' || !state.access_token || !(state.expires_at > Date.now() + 30000)) await login(state);
    if (command === 'reauth') { console.log('{"authenticated":true}'); return; }
    const initialized = await rpc(state, 'initialize', {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'popcorn-portable-skill', version: '1.0.0' },
    });
    const protocol = initialized.protocolVersion;
    if (!['2025-06-18', '2025-03-26'].includes(protocol)) throw new Error('Unsupported protocol version');
    await rpc(state, 'notifications/initialized', {}, protocol, true);
    if (command === 'tools') {
      console.log(JSON.stringify(await rpc(state, 'tools/list', {}, protocol), null, 2));
      return;
    }
    const result = await rpc(state, 'tools/call', {
      name: command === 'balance' ? 'get_balance' : tool, arguments: args,
    }, protocol);
    const record = { isError: Boolean(result.isError), data: unpack(result), raw: result };
    if (out) {
      await save(out, record);
      console.log(JSON.stringify({ saved: out, isError: record.isError }));
    } else {
      // Balance alone is nonsecret. All other tool results require a private output file.
      const data = record.data || {};
      console.log(JSON.stringify(record.isError ? { isError: true, error: data.error } : {
        credits: data.credits, metered: data.metered,
        session_block_seconds: data.session_block_seconds, credits_per_operation: data.credits_per_operation,
      }));
    }
    if (record.isError) process.exitCode = 2;
  } finally {
    await lock.close();
    await fs.unlink(LOCK);
  }
}
main().catch(error => {
  // Do not dump HTTP bodies, tokens, keys, URLs, or stack traces into transcripts.
  console.error(`Popcorn: ${error.code || error.message}`);
  process.exitCode = 1;
});
