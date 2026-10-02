# Optional fixed-duration credit access

This route does not satisfy automatic extension requirements: the live tool
list checked on 2026-10-02 has no extension operation. Use it only when the user
accepts fixed-duration browsers or the server later adds verified extension
support. Credits and x402 wallet funding are separate.

If native MCP is available, add this Streamable HTTP server and complete the
host's browser OAuth flow:

`https://popcorn-mcp-gcp.reclaimprotocol.org/mcp`

To use the same service without native MCP, use the bundled
`scripts/credit-client.mjs` with Node.js 20+. It sends JSON-RPC over normal HTTP
and requires no MCP SDK. `POPCORN_HOME` defaults to `~/.config/popcorn-browser`.
Use a different directory from the x402 helper, whose state has a different format.

```sh
node scripts/credit-client.mjs balance
node scripts/credit-client.mjs tools
```

On first use the helper creates and persists an agent-owned P-256 device key,
registers an OAuth client, signs a nonce, verifies PKCE callback state, and
exchanges the authorization code without following the loopback redirect. This
adapter is based on the public server implementation; stop if the page contract
changes. It reuses the same device key after token expiry. It does not issue or
assume refresh tokens, and does not automatically reauthorize after a 401.

This identity is separate from the user's browser identity. Tell the user which
one they are funding. Use native browser OAuth if they want to reuse existing
browser-owned credits. Do not generate a new identity to fix authentication:
credit is bound to the device key, and losing it can lose access to the balance.
Store keys in private persistent storage or the host's secret store, never
ordinary memory. Store only the credential reference in memory.

Write arguments in a private file with mode 0600. For a new create operation,
persist a fresh UUID as `idempotency_key` and a `purpose` before the request.

```sh
node scripts/credit-client.mjs call create_browser_session /private/create.json /private/session.json
```

Tool results are saved privately as `{isError,data,raw}`. On `insufficient_credit`,
share the returned `data.next_action` checkout link with the user and pause.
The hosted product advertises $5 for 100 credits and one credit per ten-minute
session; verify current terms before checkout. Do not purchase without authority.
Retry the same arguments after funding. A timeout or operation-in-progress also
uses the same key. Stop after three attempts and investigate before reallocating.
Only a confirmed terminal failure asking for a new key permits a new operation.

Read the exact `data.cdp_url` and attach Playwright to the existing context.
Share `data.live_view_url` only with the user for login/MFA. Keep both private.
Use the discovered `get_browser_session`, `get_browser_connection`,
`get_live_view`, `list_browser_sessions`, and `end_browser_session` tools with
session-specific arguments in private files. `verify_runtime` requires a fresh,
locally retained 32-byte nonce, encoded as 64 lowercase hex characters; returned
evidence still requires independent verification.

Explicitly end completed sessions. Do not send a credit session to an x402
extension endpoint or replace a browser and claim its website session survived.
The normal browser, payment, and credential boundaries in the main skill apply.

Sources: [server implementation](https://github.com/reclaimprotocol/popcorn-oss/blob/main/services/mcp-server/index.ts),
[tool schemas](https://github.com/reclaimprotocol/popcorn-oss/blob/main/services/mcp-server/src/tools.ts),
[token lifetime and limitations](https://github.com/reclaimprotocol/popcorn-oss/blob/main/services/mcp-server/README.md).
