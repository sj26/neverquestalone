// Design preview only. No provider calls, OAuth requests, keys, or saved app settings.
// Reuses the desktop renderer's styles and assets; does not modify the installed app.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const renderer = path.join(root, 'app/desktop/renderer');
const out = path.resolve(process.argv.find(a => a.startsWith('--out='))?.slice(6) ?? '.amp/in/artifacts/chatgpt-oauth');
fs.mkdirSync(out, { recursive: true });
const mime = { '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const embedded = new Map();
const css = fs.readFileSync(path.join(renderer, 'style.css'), 'utf8').replace(/url\(([^)]+)\)/g, (_, name) => {
  name = name.replace(/['"]/g, '');
  if (!embedded.has(name)) embedded.set(name, `data:${mime[path.extname(name)]};base64,${fs.readFileSync(path.join(renderer, name)).toString('base64')}`);
  return `url("${embedded.get(name)}")`;
});
// Official ChatGPT favicon, embedded in the review artifact (never fetched by the preview).
const logoResponse = await fetch('https://cdn.oaistatic.com/assets/favicon-o20kmmos.svg');
if (!logoResponse.ok) throw new Error(`ChatGPT artwork: HTTP ${logoResponse.status}`);
const logo = Buffer.from((await logoResponse.text()).replace(/<style>[\s\S]*?<\/style>/, '')).toString('base64');

function preview() {
  const states = ['connect', 'waiting', 'welcome', 'connected', 'expired', 'limit', 'api'];
  let state = 'connect';
  let picked = 'ChatGPT';
  let modelOpen = false;
  let selectedEffort = 'Low';
  let returnFocus = null;
  const app = document.getElementById('app');
  const btn = (label, action, cls = 'btn btn-quiet', more = '') => `<button type="button" class="${cls}" data-action="${action}" ${more}>${label}</button>`;
  const ico = name => `<span class="ico ico-${name}" aria-hidden="true"></span>`;
  const branded = () => btn(`<img src="${document.getElementById('chatgpt-logo').src}" alt="" width="24" height="24">Continue with ChatGPT`, 'start', 'btn oauth-signin');
  const rows = () => `<div class="choices-wrap"><div class="choices" role="radiogroup" aria-label="AI">${[
    ['Claude', '$0.76–1.22 a day'], ['ChatGPT', state === 'api' ? '$0.74–1.22 a day' : 'Your ChatGPT plan'],
    ['Grok', '$0.62–1.00 a day'], ['Gemini', '$0.29–0.46 a day'], ['Other', 'Cost varies'],
  ].map(([name, cost]) => `<button type="button" class="choice" role="radio" aria-checked="${name === picked}" tabindex="${name === picked ? 0 : -1}" data-provider="${name}"><span class="choice-name"><span class="choice-title">${name}</span></span><span class="choice-cost">${cost}</span><span class="ico ico-check choice-tick" aria-hidden="true"></span></button>`).join('')}</div></div>`;
  const title = text => `<div class="title-row"><h1 id="page-title" tabindex="-1">${text}</h1>${btn(ico('info'), 'details', 'btn btn-ghost btn-icon', 'aria-label="Show details"')}</div>`;
  const setRow = (id, label, value, control = '') => `<div class="set set-stack set-rec" id="${id}"><div class="set-value"><span class="set-key">${label}</span><span class="set-main">${value}</span></div><div class="set-control">${control}</div></div>`;
  const group = body => `<section class="group"><div class="group-rows">${body}</div></section>`;
  const setup = () => {
    let lead = state === 'api' ? 'ChatGPT needs an API key and credit at OpenAI.' : 'Use your ChatGPT plan.';
    let actions = branded() + btn('Use an API key', 'api', 'btn-link');
    let result = '';
    if (picked !== 'ChatGPT') { lead = `${picked} selected.`; actions = btn('Back to ChatGPT', 'chatgpt', 'btn btn-primary'); }
    else if (state === 'waiting') {
      actions = btn('Waiting for ChatGPT…', 'none', 'btn btn-quiet', 'aria-busy="true" aria-disabled="true" disabled') + btn('Cancel', 'cancel', 'btn-link');
      result = 'Finish signing in in your browser.';
    } else if (state === 'api') {
      actions = btn('Paste OpenAI key', 'none', 'btn btn-primary', 'disabled') + btn('Use your ChatGPT plan', 'cancel', 'btn-link');
    }
    return `${title('Connect your AI')}<p class="lead lead-slot">${lead}</p>${rows()}<div class="actions">${actions}</div><div class="result-slot" role="status">${result}</div>`;
  };
  const connected = () => {
    const problem = state === 'expired' || state === 'limit';
    let notice = '';
    if (problem) {
      const expired = state === 'expired';
      notice = `<div class="banner banner-neutral" role="status"><p class="banner-text">${expired ? 'Sign in to ChatGPT again.' : 'ChatGPT usage limit reached.'}</p>${expired ? branded() : '<a class="btn btn-primary" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage</a>'}</div>`;
    }
    return `${title('Your AI')}${notice}${group(
      setRow('ai-row', 'AI', 'ChatGPT <span class="set-sub">OpenAI</span>', btn('Switch', 'cancel', 'btn btn-quiet btn-sm')) +
      setRow('account-row', 'Account', `Sam${problem ? '' : ' <span class="chip chip-ok">Connected</span>'}`, btn('Sign out', 'signout', 'btn btn-quiet btn-sm'))
    )}${group(setRow('model-sum', 'Model', `GPT-6 Luna · ${selectedEffort}`, btn(modelOpen ? 'Hide models' : 'Pick a model', 'model', 'btn btn-quiet btn-sm', `aria-expanded="${modelOpen}" aria-controls="model-box"`)) +
      (modelOpen ? `<div class="more" id="model-box"><div class="set-block"><span class="set-key">Thinking</span><div class="row">${['Low', 'Medium', 'High'].map(level => btn(level, `effort-${level}`, 'btn btn-quiet', `aria-pressed="${level === selectedEffort}"`)).join('')}</div></div></div>` : '')
    )}${group(setRow('plan-row', 'Usage', 'Using ChatGPT plan', '<a class="btn-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage</a>'))}`;
  };
  function dialog(titleText, body, action = 'dismiss', label = 'Got it') {
    const modal = document.createElement('div');
    modal.className = 'preview-modal';
    modal.innerHTML = `<section class="oauth-dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" aria-describedby="dialog-body"><h2 id="dialog-title">${titleText}</h2><p id="dialog-body" class="lead">${body}</p><div class="actions">${btn(label, action, 'btn btn-primary')}</div></section>`;
    app.appendChild(modal);
    modal.querySelector('button').focus();
  }
  function render(focus = true) {
    const isSetup = ['connect', 'waiting', 'welcome', 'api'].includes(state);
    app.dataset.mode = isSetup ? 'setup' : 'app';
    document.getElementById('tracker').hidden = !isSetup;
    document.getElementById('nav').hidden = isSetup;
    document.getElementById('side-action').textContent = isSetup ? 'Finish later' : 'Check for updates';
    const page = document.getElementById('page');
    page.dataset.page = isSetup ? 'setup' : 'provider';
    page.innerHTML = `<div class="col ${isSetup ? 'setup-pick' : 'page-yourai'}">${isSetup ? setup() : connected()}</div>`;
    document.querySelector('.preview-modal')?.remove();
    document.getElementById('review-state').value = state;
    document.getElementById('review-approve').hidden = state !== 'waiting';
    if (state === 'welcome') dialog('You’re using your ChatGPT plan', 'Your AI requests use your ChatGPT plan. Manage usage in ChatGPT settings.', 'gotit');
    else if (focus) document.getElementById('page-title').focus();
  }
  function change(next) { state = next; picked = 'ChatGPT'; modelOpen = false; render(); }
  document.addEventListener('click', event => {
    const provider = event.target.closest('[data-provider]');
    if (provider) { picked = provider.dataset.provider; state = 'connect'; render(false); document.querySelector(`[data-provider="${picked}"]`).focus(); return; }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action.startsWith('effort-')) { selectedEffort = action.slice(7); render(false); return; }
    if (action === 'model') { modelOpen = !modelOpen; render(false); document.querySelector('[data-action="model"]').focus(); return; }
    if (action === 'details') { returnFocus = event.target.closest('button'); dialog('Your ChatGPT account', 'Sign in with OpenAI in your browser. Your connection is saved in Windows Credential Manager.'); return; }
    if (action === 'dismiss') { document.querySelector('.preview-modal')?.remove(); returnFocus?.focus(); return; }
    const next = { start: 'waiting', cancel: 'connect', chatgpt: 'connect', api: 'api', approve: 'welcome', gotit: 'connected', signout: 'connect' }[action];
    if (next) change(next);
  });
  document.addEventListener('keydown', event => {
    const modal = document.querySelector('.preview-modal');
    if (modal) {
      if (event.key === 'Tab') { event.preventDefault(); modal.querySelector('button').focus(); }
      if (event.key === 'Escape') { event.preventDefault(); if (state === 'welcome') change('connected'); else { modal.remove(); returnFocus?.focus(); } }
      return;
    }
    if (!event.target.matches('[data-provider]') || !['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const providers = [...document.querySelectorAll('[data-provider]')];
    const current = providers.indexOf(event.target);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? providers.length - 1 : (current + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + providers.length) % providers.length;
    providers[index].click();
  });
  document.getElementById('review-state').addEventListener('change', event => change(event.target.value));
  window.design = { setState: next => { if (!states.includes(next)) throw new Error('Unknown preview state'); change(next); } };
  render(false);
}

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>ChatGPT OAuth — design preview</title><style>${css}
.oauth-signin { background: #fff; border-color: #fff; color: #0d0d0d; gap: 8px; padding-inline: 12px 16px; }
.oauth-signin:hover { background: #e6e6e6; border-color: #e6e6e6; }
.oauth-signin img { display: block; }
.review-bar { position: fixed; inset: 0 0 auto; z-index: 100; height: 38px; display: flex; align-items: center; gap: 12px; padding: 0 16px; background: #211f26; color: #a8a49b; font-size: 12px; border-bottom: 1px solid #2b2931; }
.review-bar label { margin-left: auto; }
.review-bar select { background: #131217; border: 1px solid #76717f; border-radius: 4px; padding: 2px 8px; }
body:has(.review-bar:not([hidden])) .app { padding-top: 38px; }
.preview-modal { position: absolute; inset: 0; display: grid; place-items: center; z-index: 20; background: var(--scrim); padding: 24px; }
.oauth-dialog { width: min(420px,100%); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 24px; }
.oauth-dialog h2 { font-size: 20px; line-height: 28px; }
.oauth-dialog .actions { margin-top: 20px; }
.set-main .chip { margin-left: 6px; }
</style><body>
<aside class="review-bar" id="review-bar" aria-label="Preview controls"><span>Design preview · sign-in is simulated</span><label for="review-state">State</label><select id="review-state"><option value="connect">Connect</option><option value="waiting">Waiting</option><option value="welcome">First sign-in</option><option value="connected">Connected</option><option value="expired">Sign in again</option><option value="limit">Usage limit</option><option value="api">API key</option></select><button type="button" class="btn-link" id="review-approve" data-action="approve" hidden>Complete sign-in</button></aside>
<img id="chatgpt-logo" src="data:image/svg+xml;base64,${logo}" alt="" hidden>
<div class="app" id="app" data-mode="setup" data-os="win32"><aside class="companion" aria-label="NeverQuestAlone"><div class="bones-btn"><span class="portrait" data-mood="idle" data-state="inactive" aria-hidden="true"><span class="bones" data-face="active"></span><span class="bones" data-face="inactive"></span></span></div><ol class="tracker" id="tracker" aria-label="Setup progress"><li class="tracker-row">${'<span class="ico ico-dia-done" aria-hidden="true"></span>'}Download</li><li class="tracker-row tracker-now" aria-current="step"><span class="ico ico-dia-now" aria-hidden="true"></span>Connect your AI</li><li class="tracker-row"><span class="ico ico-dia-next" aria-hidden="true"></span>Set up WoW</li></ol><nav class="nav" id="nav" aria-label="Pages" hidden><span class="nav-item" data-nav="home">Home</span><span class="nav-item" data-nav="provider" aria-current="page">Your AI</span><span class="nav-item" data-nav="privacy">Your data</span><span class="nav-item" data-nav="settings">Settings</span></nav><div class="side-foot"><span class="foot-ver">v1.4.19</span><span class="foot-note" id="side-action">Finish later</span></div></aside><div class="stage"><header class="topbar"></header><main class="main-body"><div class="page" id="page" data-page="setup"></div></main></div></div>
<script>(${preview.toString()})()</script></body></html>`;
const htmlFile = path.join(out, 'chatgpt-oauth.html');
fs.writeFileSync(htmlFile, html);
console.log(`Preview: ${htmlFile}`);

async function renderPreview() {
  const { app, BrowserWindow, session } = await import('electron');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-oauth-preview-'));
  app.setName('NeverQuestAlone OAuth Preview');
  app.setPath('userData', sandbox);
  await app.whenReady();
  const blocked = [];
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const allow = details.url.startsWith('file:') || details.url.startsWith('data:');
    if (!allow) blocked.push(details.url);
    done({ cancel: !allow });
  });
  const capture = process.argv.includes('--screenshots');
  const window = new BrowserWindow({ width: 1000, height: 720, useContentSize: true, show: !capture, backgroundColor: '#0f0e12', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadFile(htmlFile);
  if (capture) {
    const wc = window.webContents;
    const js = source => wc.executeJavaScript(source, true);
    await js('document.fonts.ready');
    await js('document.getElementById("review-bar").hidden = true');
    const results = [];
    const shot = async name => {
      await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
      const layout = await js(`(() => { const p = document.getElementById('page'); return { overflowX: p.scrollWidth > p.clientWidth, overflowY: p.scrollHeight > p.clientHeight, title: document.getElementById('page-title').textContent }; })()`);
      assert.equal(layout.overflowX, false, `${name}: horizontal overflow`);
      assert.equal(layout.overflowY, false, `${name}: vertical overflow`);
      fs.writeFileSync(path.join(out, `${name}.png`), (await wc.capturePage()).toPNG());
      results.push({ state: name, ...layout });
    };
    await shot('01-connect');
    assert.equal(await js('[...document.querySelectorAll(".choice-tick")].filter(el => getComputedStyle(el).visibility === "visible").length'), 1);
    assert.deepEqual(await js('[...document.querySelectorAll("[data-provider]")].map(el => el.dataset.provider)'), ['Claude', 'ChatGPT', 'Grok', 'Gemini', 'Other']);
    await js('document.querySelector("[data-action=api]").click()');
    assert.equal(await js('document.querySelector("[data-provider=ChatGPT] .choice-cost").textContent'), '$0.74–1.22 a day');
    assert.equal(await js('document.querySelector("[data-action=none]").textContent'), 'Paste OpenAI key');
    assert.equal(await js('document.querySelector(".lead-slot").textContent'), 'ChatGPT needs an API key and credit at OpenAI.');
    await js('document.querySelector("[data-action=cancel]").click()');
    assert.equal(await js('!!document.querySelector("[data-action=start]")'), true);
    await js('document.querySelector("[data-action=start]").click()');
    assert.equal(await js('document.querySelector("[aria-busy=true]").textContent'), 'Waiting for ChatGPT…');
    await shot('02-waiting');
    await js('document.querySelector("[data-action=cancel]").click()');
    assert.equal(await js('!!document.querySelector("[data-action=start]")'), true);
    await js('document.querySelector("[data-action=start]").click(); document.querySelector("[data-action=approve]").click()');
    assert.equal(await js('document.activeElement.textContent'), 'Got it');
    await shot('03-first-sign-in');
    await js('document.querySelector("[data-action=gotit]").click()');
    assert.equal(await js('document.querySelector("#plan-row .set-main").textContent'), 'Using ChatGPT plan');
    assert.equal(await js('document.querySelector("[aria-current=page]").textContent'), 'Your AI');
    assert.equal(await js('document.getElementById("page").textContent.includes("$" )'), false);
    await shot('04-connected');
    await js('document.querySelector("[data-action=model]").click()');
    await shot('08-model-options');
    await js('document.querySelector("[data-action=effort-High]").click()');
    assert.equal(await js('document.querySelector("#model-sum .set-main").textContent'), 'GPT-6 Luna · High');
    await js('document.querySelector("[data-action=effort-Low]").click()');
    await js('document.querySelector("[data-action=model]").click()');
    for (const [state, name] of [['expired', '05-sign-in-again'], ['limit', '06-usage-limit'], ['api', '07-api-key']]) {
      await js(`window.design.setState(${JSON.stringify(state)})`);
      await shot(name);
    }
    for (const state of ['connect', 'waiting', 'welcome', 'connected', 'expired', 'limit', 'api']) {
      window.setContentSize(760, 540);
      await js(`window.design.setState(${JSON.stringify(state)})`);
      await shot(`narrow-${state}`);
    }
    await js('window.design.setState("connected"); document.querySelector("[data-action=signout]").click()');
    assert.equal(await js('document.getElementById("page-title").textContent'), 'Connect your AI');
    assert.deepEqual(blocked, [], 'Preview attempted a network request');
    fs.writeFileSync(path.join(out, 'validation.json'), JSON.stringify({ simulated: true, realOAuthTested: false, externalRequests: blocked, passed: true, captures: results }, null, 2));
    console.log('Preview interactions and desktop/narrow layouts passed. No OAuth or inference was performed.');
    window.destroy();
    await session.defaultSession.clearStorageData();
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
    app.exit(0);
  } else {
    app.on('window-all-closed', () => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {} app.quit(); });
  }
}

if (process.versions.electron) renderPreview().catch(async error => {
  console.error(error);
  const { app } = await import('electron');
  app.exit(1);
});
