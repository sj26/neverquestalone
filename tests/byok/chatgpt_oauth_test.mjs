import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createChatGPTOAuth } from '../../bridge/byok/chatgpt-oauth.mjs';
import { createOAuthStore } from '../../bridge/byok/security/oauth-store.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { getManifest, createProvider } from '../../bridge/byok/providers/index.mjs';
import { createAppApi } from '../../bridge/byok/app-api.mjs';
import { makeBackend, sendParams, waitFor } from './helpers/byok-env.mjs';

const manifest = getManifest('openai');
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const issuer = 'https://auth.openai.com';
const client = 'oaiapp_testaccount';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const sse = (terminal = 'response.completed') => new Response([
  { type: 'response.output_text.delta', delta: 'Take the kodo quest first.' },
  { type: terminal, response: { usage: { input_tokens: 23, output_tokens: 7 }, error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });

// Simulated OpenAI, real loopback callback, real JWT signatures, real provider stream parser.
async function harness(t) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test' };
  let saved = null, clock = Date.now();
  const h = { requests: [], auth: null, fault: null, terminal: 'response.completed', refreshes: 0, wait: false };
  const store = { load: async () => saved && structuredClone(saved), save: async d => { saved = structuredClone(d); } };
  h.saved = () => structuredClone(saved);
  h.advance = ms => { clock += ms; };
  h.fetch = async (url, init = {}) => {
    assert.equal(init.redirect, 'manual');
    h.requests.push({ url, init });
    if (url === `${issuer}/.well-known/jwks.json`) return json({ keys: [jwk] });
    if (url === `${issuer}/.well-known/openid-configuration`) return json({ revocation_endpoint: `${issuer}/revoke` });
    if (url === `${issuer}/revoke`) return new Response(null, { status: 200 });
    if (url === `${issuer}/api/accounts/oauth/token`) {
      const p = init.body;
      if (p.get('grant_type') === 'refresh_token') {
        h.refreshes++;
        if (h.fault === 'network') throw new Error('offline');
        if (h.fault === 'revoked') return json({ error: 'refresh_token_reused' }, 400);
        assert.equal(p.get('refresh_token'), saved.accounts.find(a => a.client_id === saved.active).refresh_token);
        await new Promise(r => setTimeout(r, 15));
        return json({ access_token: `access-rotated-${h.refreshes}`, refresh_token: `refresh-rotated-${h.refreshes}`, token_type: 'Bearer', expires_in: 3600 });
      }
      assert.equal(p.get('client_id'), client);
      assert.equal(p.get('redirect_uri'), h.auth.searchParams.get('redirect_uri'));
      assert.equal(p.get('resource'), 'https://api.openai.com/v1');
      assert.equal(crypto.createHash('sha256').update(p.get('code_verifier')).digest('base64url'), h.auth.searchParams.get('code_challenge'));
      let idToken = await new SignJWT({ nonce: h.fault === 'nonce' ? 'wrong' : h.auth.searchParams.get('nonce'), email: 'player@example.test', name: 'Player' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject(h.fault === 'identity' ? 'another-player' : 'player')
        .setIssuer(h.fault === 'issuer' ? 'https://attacker.test' : issuer).setAudience(h.fault === 'audience' ? 'oaiapp_wrong' : client)
        .setIssuedAt().setExpirationTime(h.fault === 'expired' ? '-1h' : '1h').sign(privateKey);
      if (h.fault === 'signature') {
        const parts = idToken.split('.');
        const signature = Buffer.from(parts[2], 'base64url'); signature[0] ^= 1;
        parts[2] = signature.toString('base64url'); idToken = parts.join('.');
      }
      return json({ access_token: 'access-initial', refresh_token: 'refresh-initial', id_token: idToken,
        token_type: 'Bearer', expires_in: 3600, scope: h.fault === 'scope' ? 'openid profile email' : scopes });
    }
    if (url === 'https://api.openai.com/v1/models') return json({ models: [
      { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' },
      { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hidden' },
    ] });
    if (url === 'https://api.openai.com/v1/responses') {
      assert.match(init.headers.authorization, /^Bearer access-/);
      const body = JSON.parse(init.body);
      assert.equal(body.stream, true); assert.equal(body.store, false);
      assert.equal(body.input.some(m => m.role === 'system'), false);
      for (const field of ['max_output_tokens', 'safety_identifier', 'previous_response_id', 'temperature', 'metadata']) assert.equal(field in body, false, field);
      return sse(h.terminal);
    }
    assert.fail(`Unexpected endpoint: ${url}`);
  };
  h.openExternal = async value => {
    h.auth = new URL(value);
    assert.equal(h.auth.origin + h.auth.pathname, `${issuer}/api/accounts/authorize`);
    assert.equal(h.auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(h.auth.searchParams.get('scope'), scopes);
    if (h.wait) return;
    const callback = new URL(h.auth.searchParams.get('redirect_uri'));
    callback.search = new URLSearchParams({ ...(h.fault === 'denied' ? { error: 'access_denied' } : { code: 'test-code' }), state: h.fault === 'state' ? 'wrong' : h.auth.searchParams.get('state'),
      ...(h.auth.searchParams.get('client_id') === 'dynamic_agent_client' ? { client_id: client } : {}) });
    const response = await fetch(callback);
    h.callback = { status: response.status, headers: response.headers, html: await response.text() };
  };
  h.restart = async () => {
    h.oauth?.stop();
    h.oauth = await createChatGPTOAuth({ store, manifest, fetch: h.fetch, openExternal: h.openExternal, now: () => clock, timeoutMs: 2000 });
  };
  await h.restart();
  t.after(() => h.oauth.stop());
  return h;
}

test('ChatGPT sign-in persists its registration, discovers plan models and completes inference before connecting', async t => {
  const h = await harness(t);
  const first = await h.oauth.connect();
  assert.equal(first.connected, true);
  assert.equal(first.model, 'gpt-6-luna');
  assert.equal(h.callback.status, 200);
  assert.match(h.callback.headers.get('content-type'), /^text\/html/);
  assert.equal(h.callback.headers.get('cache-control'), 'no-store');
  assert.equal(h.callback.headers.get('referrer-policy'), 'no-referrer');
  assert.match(h.callback.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(h.callback.html, /Continue in the app/);
  assert.doesNotMatch(h.callback.html, /test-code|access-initial|refresh-initial/);
  assert.equal(h.callback.html.includes(h.auth.searchParams.get('state')), false);
  assert.deepEqual(first.models, [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }]);
  assert.doesNotMatch(JSON.stringify(first), /access-initial|refresh-initial|id_token/);
  const host = h.auth.searchParams.get('ext_agent_host_id');
  assert.match(host, /^urn:uuid:/);
  await h.restart();
  assert.equal(await h.oauth.accessToken(), 'access-initial');
  await h.oauth.connect();
  assert.equal(h.auth.searchParams.get('client_id'), client);
  assert.equal(h.auth.searchParams.has('agent_name_hint'), false);
  assert.equal(h.auth.searchParams.get('ext_agent_host_id'), host);
  await h.oauth.signOut();
  assert.equal(h.oauth.view().connected, false);
  assert.equal(h.saved().accounts[0].refresh_token, undefined);
  await h.oauth.connect();
  assert.equal(h.auth.searchParams.get('client_id'), client);
  assert.equal(h.auth.searchParams.has('id_token_hint'), false);
});

test('ChatGPT refuses invalid callbacks, identities, consent and incomplete inference without replacing an active connection', async t => {
  const h = await harness(t);
  await h.oauth.connect();
  for (const fault of ['state', 'nonce', 'issuer', 'audience', 'identity', 'scope', 'expired', 'signature']) {
    h.fault = fault;
    await assert.rejects(h.oauth.connect(), e => ['oauth_failed', 'consent_required'].includes(e.code), fault);
    if (fault === 'state') {
      assert.equal(h.callback.status, 400);
      assert.match(h.callback.html, /Sign-in could not be verified/);
      assert.doesNotMatch(h.callback.html, /Continue in the app/);
    }
    assert.equal(await h.oauth.accessToken(), 'access-initial');
  }
  h.fault = null;
  for (const terminal of ['response.incomplete', 'response.failed']) {
    h.terminal = terminal;
    await assert.rejects(h.oauth.connect(), e => ['inference_failed', 'usage_limit'].includes(e.code));
    assert.equal(h.oauth.view().connected, true);
  }
});

test('ChatGPT cancellation closes the loopback listener and never saves credentials', async t => {
  const h = await harness(t); h.wait = true;
  const connecting = h.oauth.connect();
  await waitFor(() => !!h.auth);
  const redirect = h.auth.searchParams.get('redirect_uri');
  h.oauth.cancel();
  await assert.rejects(connecting, { code: 'cancelled' });
  assert.equal(h.oauth.view().connected, false);
  assert.deepEqual(h.saved().accounts, []);
  await assert.rejects(fetch(redirect));
  h.wait = false; h.fault = 'denied';
  await assert.rejects(h.oauth.connect(), { code: 'cancelled' });
  assert.match(h.callback.html, /Sign-in cancelled/);
  assert.doesNotMatch(h.callback.html, /Continue in the app/);
  assert.deepEqual(h.saved().accounts, []);
});

test('ChatGPT refresh rotates once across concurrent requests, preserves credentials offline and clears revoked tokens', async t => {
  const h = await harness(t); await h.oauth.connect(); h.advance(3_550_000);
  assert.deepEqual(await Promise.all([h.oauth.accessToken(), h.oauth.accessToken(), h.oauth.accessToken()]), Array(3).fill('access-rotated-1'));
  assert.equal(h.refreshes, 1);
  h.advance(3_550_000); h.fault = 'network';
  await assert.rejects(h.oauth.accessToken());
  assert.equal(h.oauth.view().connected, true);
  h.fault = 'revoked';
  await assert.rejects(h.oauth.accessToken(), { code: 'oauth_expired' });
  assert.equal(h.oauth.view().connected, false);
  assert.equal(h.saved().accounts[0].client_id, client);
});

test('ChatGPT quest requests use OAuth, explicit history and no dollar cap or paid fallback', async t => {
  const h = await harness(t); await h.oauth.connect();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-oauth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ks = createKeyStore({ backend: 'memory' });
  await ks.set('openai', `sk-proj-${'a'.repeat(48)}`);
  const config = { provider: 'openai', model: 'gpt-6-luna', auth: 'oauth', authBy: { openai: 'oauth' }, caps: { dailyUsd: 0 } };
  const env = makeBackend({ dataDir: dir, config, keystore: ks, chatgpt: h.oauth, fetch: h.fetch });
  t.after(() => env.backend.stop());
  await env.backend.start();
  assert.equal(env.backend.status().rt.state, 'ready');
  env.backend.send(sendParams('c123abc', 'quest1', 'Which quest next?', { contextLines: ['Character: level 6 warrior', 'Location: Mulgore'] }));
  await waitFor(() => env.chats('final').length === 1);
  const request = JSON.parse(h.requests.filter(r => r.url.endsWith('/responses')).at(-1).init.body);
  assert.equal(request.input[0].role, 'developer');
  assert.match(JSON.stringify(request.input), /Which quest next/);
  const beforeLimit = h.requests.filter(r => r.url.endsWith('/responses')).length;
  h.terminal = 'response.failed';
  env.backend.send(sendParams('c123abc', 'quest2', 'Which way?'));
  await waitFor(() => env.chats('error').length === 1);
  assert.equal(h.requests.filter(r => r.url.endsWith('/responses')).length, beforeLimit + 1, 'no automatic retry after a plan usage limit');
  assert.deepEqual(env.backend.status().rt, { state: 'paused' }, 'no invented reset countdown');
  h.terminal = 'response.completed';
  env.backend.send(sendParams('c123abc', 'quest3', 'Tell me more.'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.filter(r => r.url.endsWith('/responses')).length, beforeLimit + 1, 'new requests wait for explicit Resume');
  env.backend.pause(false);
  await waitFor(() => env.chats('final').length === 2);
  const api = createAppApi({ backend: env.backend, keystore: ks, config: { byok: config }, chatgpt: h.oauth });
  t.after(() => api.stop());
  const p = (await api.providers()).find(p => p.id === 'openai');
  assert.equal(p.auth, 'oauth'); assert.equal(p.models[0].priceHint, null);
  assert.equal((await api.signOutChatGPT()).ok, true);
  assert.equal(env.backend.status().provider.auth, 'oauth');
  assert.equal(env.backend.status().provider.keyState, 'expired');
  assert.equal(await ks.get('openai'), `sk-proj-${'a'.repeat(48)}`);
  const events = [];
  for await (const e of createProvider(h.oauth.manifest(), { getKey: async () => ({ key: await h.oauth.accessToken(), kind: 'oauth' }), fetch: h.fetch }).stream({ model: 'gpt-6-luna', messages: [] })) events.push(e);
  assert.equal(events.at(-1).error.kind, 'oauth_expired');
});

test('OAuth vault encrypts and authenticates disk records; memory fallback writes no file', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-vault-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'chatgpt.enc');
  const keys = createKeyStore({ backend: 'memory' });
  const ks = { ...keys, persistent: true };
  const store = createOAuthStore({ keystore: ks, file });
  const record = { access_token: 'sensitive-access', refresh_token: 'sensitive-refresh', nested: ['one', 'two'] };
  await store.save(record);
  assert.doesNotMatch(fs.readFileSync(file).toString(), /sensitive/);
  assert.deepEqual(await createOAuthStore({ keystore: ks, file }).load(), record);
  const bytes = fs.readFileSync(file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(file, bytes);
  await assert.rejects(createOAuthStore({ keystore: ks, file }).load());
  const memoryFile = path.join(dir, 'must-not-exist');
  const memory = createOAuthStore({ keystore: keys, file: memoryFile });
  await memory.save(record); assert.deepEqual(await memory.load(), record);
  assert.equal(fs.existsSync(memoryFile), false);
});
