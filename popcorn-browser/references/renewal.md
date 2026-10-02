# Same-browser renewal: server dependency

On 2026-10-02 the authenticated live endpoint
`https://popcorn-mcp-gcp.reclaimprotocol.org/mcp` advertised:

- `get_balance`
- `create_browser_session`
- `get_browser_session`
- `get_browser_connection`
- `get_live_view`
- `verify_runtime`
- `end_browser_session`
- `list_browser_sessions`

None extends session TTL. The creation schema rejects additional arguments;
there is no duration parameter. The same domain's `/v1/x402/sessions` path
returns 404. Client heartbeats, CDP traffic, and opening LiveView cannot be
assumed to change that deadline. These observations are also consistent with
the [published server](https://github.com/reclaimprotocol/popcorn-oss/blob/main/services/mcp-server/src/tools.ts).

A complete renewable integration needs a server operation that:

1. Takes an owned existing session ID and a durable idempotency key.
2. Reserves and commits the verified credit cost exactly once, with checkout
   guidance on insufficient credit and recoverable uncertain outcomes.
3. Extends the existing browser's lifetime while preserving its browser process,
   cookies, pages, and active login flow. A new browser under the same ID is not
   sufficient.
4. Makes the confirmed new expiry available through `get_browser_session`.
5. Documents extension duration, cost, maximum lifetime, minimum remaining time,
   retry semantics, and any connection URL changes.

This is a requirement for the service, not a claim that such an API exists.
Do not modify or deploy the service as part of installing this skill.

After the operator provides a supported tool, inspect its actual schema and
create private `POPCORN_HOME/renewal.json` with these adapter fields:

| Field | Meaning |
| --- | --- |
| `tool` | Exact discovered name of the supported renewal tool. |
| `arguments` | Its verified arguments, with `$SESSION_ID` and `$OPERATION_ID` replacing the session and idempotency values. Other fields use verified literal values. |
| `creditCost` | Positive integer credits per call, confirmed against the actual billing contract. |
| `leadSeconds` | Renew this many seconds before expiry, allowing for the service's minimum window, request latency, and recovery. At least 30. |
| `source` | Official HTTPS documentation/source URL establishing these semantics. |

No default file or made-up tool name ships with this skill. `setup` and `start`
validate that the tool exists and the configured arguments match its declared
required/allowed fields. They cannot establish semantic correctness from a
schema alone: the agent must verify the behavior and cost from the operator's
published contract before enabling it. The manager substitutes placeholders,
reserves budget, retries the same operation if necessary, and uses the existing
`get_browser_session` tool to confirm the same session ID and a later expiry.

Test renewal while already on a page with known state, checking that state after
the confirmed extension. Run the test only within the user's spending authority.
The watcher does not guarantee survival through service outages or session caps.
