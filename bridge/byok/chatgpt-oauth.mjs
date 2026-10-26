// OpenAI's public-client contract, not Codex's client or ChatGPT's private backend:
// https://developers.openai.com/siwc/token-sharing-open-source
import crypto from 'node:crypto';
import http from 'node:http';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { createProvider } from './providers/index.mjs';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'];
const random = () => crypto.randomBytes(32).toString('base64url');
const fail = (code) => Object.assign(new Error('ChatGPT connection could not be completed.'), { code });
const signedIn = a => !!(a?.access_token && a?.refresh_token);

// Only fixed app copy goes into this page, never callback parameters or credentials.
function callbackPage(title, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<title>${title} · NeverQuestAlone</title>
<style>
:root { color-scheme: dark; font-synthesis: none; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 32px 24px;
  background: #0f0e12; color: #ecebe7; font: 400 14px/20px -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased; }
main { width: 100%; max-width: 440px; }
.brand { display: flex; align-items: center; gap: 10px; margin: 0 0 24px; font-weight: 500; }
.diamond { width: 9px; height: 9px; margin: 0 3px; background: #e3a458; transform: rotate(45deg); }
section { padding: 32px; border: 1px solid #2b2931; border-radius: 12px; background: #16151a; }
.label { margin: 0 0 12px; color: #e3a458; font-size: 14px; }
h1 { margin: 0 0 12px; font-size: 26px; line-height: 32px; font-weight: 500; letter-spacing: -.02em; }
.message { margin: 0; color: #a8a49b; text-wrap: pretty; }
@media (max-width: 400px) { section { padding: 24px; } h1 { font-size: 24px; line-height: 30px; } }
</style>
</head>
<body>
<main>
<p class="brand"><span class="diamond" aria-hidden="true"></span>NeverQuestAlone</p>
<section aria-labelledby="title">
<p class="label">ChatGPT</p>
<h1 id="title">${title}</h1>
<p class="message">${message}</p>
</section>
</main>
</body>
</html>`;
}

export async function createChatGPTOAuth({ store, manifest, fetch: fetchFn = globalThis.fetch, openExternal,
  widen = () => () => {}, addSecret = () => {}, now = Date.now, timeoutMs = 300_000 } = {}) {
  let data = await store.load() ?? { hostId: `urn:uuid:${crypto.randomUUID()}`, accounts: [], active: null };
  let pending = null;
  let stopped = false;
  let signingOut = false;
  let writing = Promise.resolve();
  const update = fn => {
    const job = writing.then(async () => { const next = fn(data); await store.save(next); data = next; });
    writing = job.catch(() => {});
    return job;
  };
  const refreshing = new Map();
  const active = () => data.accounts.find(a => a.client_id === data.active) ?? null;
  const remember = a => {
    for (const k of ['access_token', 'refresh_token', 'id_token']) if (a?.[k]) addSecret(a[k]);
  };
  data.accounts.forEach(remember);
  async function request(url, init = {}) {
    const u = new URL(url);
    if (u.origin !== ISSUER && u.origin !== 'https://api.openai.com') throw fail('bad_endpoint');
    const release = widen([u.hostname], 'sign_in');
    try {
      return await fetchFn(url, { ...init, redirect: 'manual', signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    } finally { release(); }
  }
  async function json(url, init) {
    const r = await request(url, init);
    if (!r.ok) {
      // Never attach token responses, authorization URLs, or server messages to errors/logs.
      let code;
      try { code = (await r.json()).error; } catch { /* safe generic error */ }
      throw fail(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(code) ? 'oauth_expired' : r.status === 429 ? 'usage_limit' : 'oauth_failed');
    }
    return r.json();
  }
  async function token(params, signal) {
    return json(TOKEN, { method: 'POST', signal, headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, resource: RESOURCE }) });
  }
  function credentials(tokens, previous = null) {
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : previous?.scopes ?? [];
    if (SCOPES.some(s => !scopes.includes(s))) throw fail('consent_required');
    if (typeof tokens.access_token !== 'string' || !tokens.access_token ||
        !(tokens.refresh_token || previous?.refresh_token) ||
        String(tokens.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw fail('oauth_failed');
    const result = { ...previous, access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || previous?.refresh_token,
      id_token: tokens.id_token || previous?.id_token, scopes, expiresAt: now() + tokens.expires_in * 1000 };
    remember(result);
    return result;
  }
  function accountView(a) {
    return { id: a.client_id, label: `${a.email || a.name || 'ChatGPT account'} · ${a.client_id.slice(-6)}`,
      email: a.email ?? null, name: a.name ?? null, connected: signedIn(a), active: a.client_id === data.active };
  }
  function view() {
    const a = active();
    return { connected: signedIn(a), account: a ? accountView(a) : null,
      accounts: data.accounts.map(accountView), pending: !!pending, models: a?.models ?? [] };
  }
  function planManifest(a = active()) {
    const list = (a?.models ?? []).map(m => {
      const { replacedBy, ...metadata } = manifest.models.list.find(e => e.id === m.id) ?? {};
      return { ...metadata, id: m.id, label: m.name };
    });
    return { ...manifest, subscription: true, priceSource: 'free', safetyIdentifier: false,
      errorMap: { ...manifest.errorMap, codes: { ...manifest.errorMap.codes,
        subscription_sharing_usage_limit_exceeded: 'rate_limited',
        subscription_sharing_usage_unavailable: 'overloaded', subscription_sharing_user_unavailable: 'overloaded',
        subscription_sharing_user_not_eligible: 'bad_request', subscription_sharing_route_not_supported: 'bad_request',
        subscription_sharing_unsupported_capability: 'bad_request', subscription_sharing_invalid_user: 'oauth_expired',
        chatpass_v2_scope_not_authorized: 'bad_request', chatpass_v2_invalid_authorization_context: 'bad_request',
      } },
      models: { ...manifest.models, default: list.some(m => m.id === manifest.models.default) ? manifest.models.default : list[0]?.id ?? null, list } };
  }
  async function connect({ account, newAccount = false } = {}) {
    if (stopped) throw fail('oauth_failed');
    if (pending || signingOut) throw fail('busy');
    const old = newAccount ? null : account ? data.accounts.find(a => a.client_id === account) : active() ?? data.accounts.at(-1);
    if (account && !old) throw fail('unknown_account');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    pending = controller;
    const state = random(), nonce = random(), verifier = random();
    let server;
    try {
      // Save the stable host/registration mapping before opening the browser, not on app boot.
      await update(d => d);
      const callback = new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
          const url = new URL(req.url, 'http://127.0.0.1');
          res.setHeader('cache-control', 'no-store');
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
          res.setHeader('referrer-policy', 'no-referrer');
          if (req.method !== 'GET' || url.pathname !== '/auth/callback' || req.headers.host !== `127.0.0.1:${server.address().port}`) {
            res.writeHead(404); res.end(callbackPage('Page not found', 'Return to NeverQuestAlone to continue.')); return;
          }
          if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) {
            res.writeHead(400); res.end(callbackPage('Sign-in could not be verified', 'Return to NeverQuestAlone and try again.')); reject(fail('oauth_failed')); return;
          }
          if (url.searchParams.has('error')) { res.end(callbackPage('Sign-in cancelled', 'You can close this tab and return to NeverQuestAlone.')); reject(fail('cancelled')); return; }
          const code = url.searchParams.get('code');
          const clientId = url.searchParams.get('client_id') || old?.client_id;
          if (!code || url.searchParams.getAll('code').length !== 1 || !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId ?? '') ||
              (old && clientId !== old.client_id) || url.searchParams.getAll('client_id').length > 1) {
            res.writeHead(400); res.end(callbackPage('Sign-in could not be verified', 'Return to NeverQuestAlone and try again.')); reject(fail('oauth_failed')); return;
          }
          res.end(callbackPage('Continue in the app', 'You can close this tab and return to NeverQuestAlone.'));
          resolve({ code, clientId });
        });
        server.on('error', () => reject(fail('oauth_failed')));
        signal.addEventListener('abort', () => reject(fail(controller.signal.aborted ? 'cancelled' : 'oauth_timeout')), { once: true });
      });
      // Observe rejection even if opening the browser fails before awaiting the callback.
      callback.catch(() => {});
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const redirect = `http://127.0.0.1:${server.address().port}/auth/callback`;
      const url = new URL(AUTHORIZE);
      url.search = new URLSearchParams({ client_id: old?.client_id ?? 'dynamic_agent_client',
        ...(!old ? { agent_name_hint: 'NeverQuestAlone' } : {}), ext_agent_host_id: data.hostId,
        ...(old?.id_token ? { id_token_hint: old.id_token } : {}), ...(old?.email ? { login_hint: old.email } : {}),
        ...(old?.scopes && !old.scopes.includes('chatgpt.tokens.use.direct') ? { prompt: 'consent' } : {}),
        response_type: 'code', redirect_uri: redirect, scope: SCOPES.join(' '), resource: RESOURCE,
        state, nonce, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') });
      await openExternal(url.href);
      const { code, clientId } = await callback;
      server.close(); server.closeAllConnections();
      const tokens = await token({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect }, signal);
      remember(tokens);
      const jwks = await json(`${ISSUER}/.well-known/jwks.json`, { signal });
      const { payload: identity } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), {
        issuer: ISSUER, audience: clientId, algorithms: ['RS256', 'ES256'], requiredClaims: ['sub', 'exp', 'iat', 'nonce'], clockTolerance: 5,
      });
      if (identity.nonce !== nonce || !identity.sub || (old && identity.sub !== old.subject)) throw fail('oauth_failed');
      // Retain a validated registration even if consent or inference fails. It is not the active
      // connection until the complete flow succeeds, and future attempts reuse its issued ID.
      if (!data.accounts.some(a => a.client_id === clientId)) await update(d => ({ ...d,
        accounts: [...d.accounts, { client_id: clientId, subject: identity.sub,
          email: identity.email_verified === false ? null : identity.email, name: identity.name,
          id_token: tokens.id_token, scopes: typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/) : [] }] }));
      const candidate = { ...credentials(tokens), client_id: clientId, subject: identity.sub,
        email: identity.email_verified === false ? null : identity.email, name: identity.name, models: [] };
      const catalog = await json(`${RESOURCE}/models`, { headers: { authorization: `Bearer ${candidate.access_token}` }, signal });
      candidate.models = (catalog.models ?? []).filter(m => m.visibility === 'list' && typeof m.slug === 'string' && /^[A-Za-z0-9._:/-]{1,80}$/.test(m.slug))
        .map(m => ({ id: m.slug, name: typeof m.display_name === 'string' ? m.display_name : m.slug }));
      if (!candidate.models.length) throw fail('no_models');
      const m = planManifest(candidate);
      const release = widen(['api.openai.com'], 'sign_in');
      let test;
      try { test = await createProvider(m, { getKey: async () => ({ key: candidate.access_token, kind: 'oauth' }), fetch: fetchFn }).testCall({ model: m.models.default, signal }); }
      finally { release(); }
      if (!test.ok) throw fail(test.error?.kind === 'rate_limited' ? 'usage_limit' : test.error?.kind === 'oauth_expired' ? 'oauth_expired' : 'inference_failed');
      signal.throwIfAborted();
      // The old active account and tokens remain untouched until identity, scopes and inference pass.
      await update(d => { signal.throwIfAborted(); return { ...d, accounts: [...d.accounts.filter(a => a.client_id !== clientId), candidate], active: clientId }; });
      return { ...view(), model: m.models.default };
    } catch (e) {
      throw fail(['busy', 'cancelled', 'oauth_timeout', 'consent_required', 'oauth_expired', 'usage_limit', 'no_models', 'inference_failed'].includes(e.code) ? e.code : 'oauth_failed');
    } finally {
      controller.abort(); server?.close(); server?.closeAllConnections(); pending = null;
    }
  }
  async function accessToken() {
    const a = active();
    if (!signedIn(a) || stopped || signingOut) throw fail('oauth_expired');
    if (a.expiresAt > now() + 60_000) return a.access_token;
    if (!refreshing.has(a.client_id)) refreshing.set(a.client_id, (async () => {
      try {
        const tokens = await token({ grant_type: 'refresh_token', client_id: a.client_id, refresh_token: a.refresh_token });
        const renewed = credentials(tokens, a);
        if (stopped || !data.accounts.includes(a)) throw fail('oauth_expired');
        await update(d => {
          if (stopped || !d.accounts.includes(a)) throw fail('oauth_expired');
          return { ...d, accounts: d.accounts.map(x => x === a ? renewed : x) };
        });
        return renewed.access_token;
      } catch (e) {
        if (e.code === 'oauth_expired' && data.accounts.includes(a)) {
          const { access_token, refresh_token, id_token, ...registration } = a;
          await update(d => ({ ...d, accounts: d.accounts.map(x => x === a ? registration : x) }));
        }
        throw e;
      }
    })().finally(() => refreshing.delete(a.client_id)));
    return refreshing.get(a.client_id);
  }
  async function signOut() {
    if (signingOut) throw fail('busy');
    signingOut = true;
    pending?.abort();
    try {
    // Finish any rotating refresh before revoking; no new requests can obtain tokens meanwhile.
    await Promise.allSettled([...refreshing.values()]);
    const a = active();
    if (!a) return { revoked: true };
    let revoked = !a.refresh_token;
    if (a.refresh_token) {
      try {
        const discovery = await json(`${ISSUER}/.well-known/openid-configuration`);
        if (new URL(discovery.revocation_endpoint).origin !== ISSUER) throw fail('bad_endpoint');
        const r = await request(discovery.revocation_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: a.refresh_token, token_type_hint: 'refresh_token', client_id: a.client_id }) });
        revoked = r.status === 200;
      } catch { /* always stop local use, report unconfirmed remote revocation */ }
    }
    const { access_token, refresh_token, id_token, ...registration } = a;
    await update(d => ({ ...d, accounts: d.accounts.map(x => x.client_id === a.client_id ? registration : x) }));
    return { revoked };
    } finally { signingOut = false; }
  }
  return { view, manifest: planManifest, connect, accessToken, signOut,
    cancel: () => pending?.abort(), stop: () => { stopped = true; pending?.abort(); } };
}
