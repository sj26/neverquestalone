# ChatGPT account connection

Native OAuth implementation for Sam's personal `chatgpt-oauth` branch. LiteLLM
and its dedicated Python environment, caches, task and credentials were removed.
No OpenAI API key or Codex client identity is used for ChatGPT-plan requests.

## Experience

Keep the existing five-provider list and its layout. When ChatGPT is selected:

- Lead: **Use your ChatGPT plan.**
- Row cost: **Your ChatGPT plan** rather than an API dollar estimate.
- Primary: **Continue with ChatGPT**, using OpenAI's white sign-in button.
- Secondary: **Use an API key**, retaining the existing connection option.
- Open the system browser directly, without another confirmation. The app waits
  in place, with Cancel.
- After consent, a self-contained return page matches the app's dark palette,
  gold diamond and compact card: **Continue in the app**. Cancellation and invalid
  callbacks use the same layout. No credentials or external resources enter it.
- First connection: **You're using your ChatGPT plan**, then **Got it**.
- Your AI: the account, connection state, model, **Using ChatGPT plan**, **Manage usage**, and **Sign out**.
- Expired session: **Sign in again** and the same sign-in action.
- Usage limit: **Usage limit reached** and **Manage usage**.

Do not show API spending estimates or dollar caps for ChatGPT-plan requests.
Do not silently fall back to an API key or a different account. Account switching
must leave the active connection intact until the new connection is verified.
The preview uses fixture account Sam and model GPT-6 Luna, not live account data.

The alternative explored was putting the actions inside the selected ChatGPT row.
Keeping them below the list is preferred: it preserves the established layout and
keeps the other provider rows from moving.

## Run the preview

After the usual root and desktop `npm ci`, from the repository root:

```powershell
node app/desktop/node_modules/electron/cli.js tools/preview-chatgpt-oauth.mjs --out=.amp/in/artifacts/chatgpt-oauth
```

Add `--screenshots` to exercise the simulated interactions and capture every
state at 1000 × 720 and 760 × 540, with `validation.json`. The tool also writes a
self-contained `chatgpt-oauth.html` with a separate reviewer state selector.
It reads the real renderer stylesheet, fonts and icons and embeds them. It fetches
the official ChatGPT favicon while generating the artifact. The preview itself
has no network access, does not use the production preload or bridge, and never
reads credentials, the clipboard, app settings, or the WoW installation.

The existing app screenshots can be regenerated separately with the established
`app/desktop` screenshot workflow:

```powershell
node node_modules/electron/cli.js . --screenshots .amp/in/artifacts/before --screenshots-only=setup-s2-chatgpt --screenshots-probe
```

These are design references, not evidence of a successful OAuth exchange.

## Initial design validation on blitzwing

The rendered preview passed its interaction checks and 15 captures at desktop
and minimum-window sizes. No horizontal or vertical clipping was detected, and
the preview made no external requests. Screenshots were inspected visually.

The unchanged repository test suite reported 1,897 passed, 126 skipped and one
failure: `tests/byok/wow_locate_test.mjs:355` compares the Windows system path
case-sensitively. This machine supplies `C:\WINDOWS\System32\icacls.exe`; the
test expects `C:\Windows\System32\icacls.exe`. No production code or existing
test was changed, and the failure was left visible rather than patched here.

## Native validation and local launch

The full suite reported 1,904 passed, 126 skipped and only the same Windows
`icacls.exe` path-case failure. A subsequent focused run passed 168 tests.
The real Electron desktop self-test passed with the real bridge, renderer
sandbox, network guard and OS keystore binding. All 11 native UI captures passed
their checks and visual inspection, including minimum-window, API-key, waiting,
cancellation, success, account, signed-out and usage-limit states. Account and
success screenshots use fixtures, not Sam's credentials.

`NeverQuestAlone - ChatGPT` on Sam's Desktop launches this checkout directly in
Electron. The sign-in screen has ChatGPT selected. The source run uses the
installed release's Windows capture helper, copied byte-for-byte to the ignored
development build path. This is not a packaged update to the installed app.
The temporary interactive launch task was removed; no proxy task is needed.

## Documented integration route

OpenAI explicitly documents ChatGPT plan usage for open-source and locally hosted
applications. This is a better basis than copying the Codex OAuth client or
depending on LiteLLM's ChatGPT backend route:

- [Overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

Read on October 25, 2026. Documentation establishes the integration contract.
On October 26, Sam authorized the native route and its initial streamed inference
check passed with `gpt-6.1-sol`. No API key or LiteLLM proxy was used.

### Native implementation

1. Main process owns OAuth. Generate and persist a stable opaque host ID. Use
   `dynamic_agent_client` for first registration, the fork's actual app name as
   `agent_name_hint`, and the issued client ID for later authorizations.
2. Listen only on `127.0.0.1` before opening the system browser. Generate fresh
   state, nonce and PKCE S256 for each attempt. Preserve the callback path and use
   the exact callback URI in both authorization and exchange. Bound the attempt's
   lifetime; cancel and close the listener on failure, cancellation and quit.
3. Request `openid profile email offline_access resource.invoke
   chatgpt.tokens.use.direct`, with resource `https://api.openai.com/v1`.
   Validate state before handling errors or codes. Reject unexpected client IDs.
4. Exchange using the issued client ID, never Codex's identity or a client secret.
   Validate the ID token signature, issuer, audience, nonce and expiration using a
   maintained OIDC/JWT library. Confirm granted inference scopes and the selected
   account's verified identity before replacing an existing connection.
5. Keep tokens in the existing OS credential-store boundary, never in renderer
   state, configuration JSON, logs, addon files or Git. Persist rotating refresh
   credentials atomically. Serialize refreshes; support restart and revocation.
6. Add a subscription-auth mode to the existing OpenAI provider. Discover the
   route's supported models; complete a small streamed inference before reporting
   Connected. Do not infer entitlement from a model catalog alone.
7. Call Responses directly with `store: false`, `stream: true` and explicit
   history. Convert system context to instructions/developer content and omit
   fields unsupported by this OAuth route. Handle `response.completed` and stream
   failures through the existing backend error contract.
8. Extend the app's explicit network allowlist for OpenAI authorization, token,
   JWKS, models and inference endpoints and the documented usage link. Preserve
   renderer isolation and connection accounting/redaction.
9. Cover cancellation, state/nonce/issuer/audience failures, denied scopes,
   refresh rotation, expired/revoked sessions, limits, restart, account switching,
   API-key mode and actual quest-request streaming. No automatic paid fallback.

`bridge/byok/chatgpt-oauth.mjs` owns registration, sign-in, refresh, sign-out,
account-specific models and the first inference check. The OS keystore holds an
AES-256-GCM key; `chatgpt.enc` holds authenticated ciphertext, atomically replaced.
A session-only keystore writes no token file. The renderer receives account
labels and state, never credentials. No old proxy credentials are reused.

`tests/byok/chatgpt_oauth_test.mjs` exercises real loopback callbacks and signed
test ID tokens with simulated OpenAI responses, including a quest request through
the real backend and streaming parser. It covers restart, cancellation, invalid
state/signature/issuer/audience/nonce/identity, declined scopes, incomplete/failed
streams, rotating concurrent refresh, offline/revoked sessions, encrypted storage
and usage-limit pause/resume without paid fallback. Desktop UI tests exercise
sign-in, cancellation, success acknowledgement, account usage and sign-out.

Sam's initial passkey login failed with OpenAI's
`login_challenge_not_found_in_session`. Signing into ChatGPT in the browser first,
then starting authorization again from the app, completed the native connection.
The underlying login-session trigger remains unknown. In-game quest responses
still need validation. Fixture screenshots are not evidence of a live connection.
The loopback callback must return to blitzwing, not to a different device.

## Fork and upstream

Local branch: `chatgpt-oauth`, based on upstream 1.4.19. Creating Sam's remote
GitHub fork requires GitHub authentication on blitzwing. No upstream PR has been
opened. Keep any future PR narrowly framed as a native implementation of OpenAI's
documented open-source OAuth/Responses contract, with links and measured tests;
do not describe it as a Codex workaround or promise unlimited/free usage.

This preview retains the upstream appearance for review. Before distributing a
forked app, follow the repository's name/artwork/signing requirements in CREDITS
and docs/releasing.md. Do not change the installed app's identity or credentials
for a public release. A personal source run is not a signed packaged release.
