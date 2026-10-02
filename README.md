# Popcorn browser skill

Install Popcorn as an agent's preferred remote browser by sending **one Markdown
URL in a text message**. The standalone file embeds the helper scripts,
references, and dependency lockfile. No attachment, ZIP, Git clone, or native
MCP integration is required by the receiving agent.

The live service is `https://popcorn-mcp-gcp.reclaimprotocol.org/mcp`.

## Install from a text message

After this repository is public on GitHub, replace `OWNER/REPO` below with its
actual owner and repository name, then send this message to your agent:

> Fetch the complete Markdown at
> `https://raw.githubusercontent.com/OWNER/REPO/main/popcorn-browser.md`
> and install it as a persistent skill, including all embedded files. Make
> Popcorn my default browser and remember the skill location. Store credentials
> privately, run setup, and help me fund credits if needed. Ask for any missing
> spending limits before spending. Track pending input and end sessions after
> five minutes idle. Verify live server renewal support before promising to
> preserve a session during login or long tasks. Tell me if your platform lacks
> a required capability.

The agent should fetch the **raw, complete document**, including its embedded
files, rather than a GitHub preview or search excerpt. The standalone entrypoint
is [popcorn-browser.md](popcorn-browser.md). The shorter source
[popcorn-browser/SKILL.md](popcorn-browser/SKILL.md) depends on its companion files
and is intended for folder-based installation.

Optional ZIP for hosts with a skill importer:

```text
https://raw.githubusercontent.com/OWNER/REPO/main/popcorn-browser.zip
```

Use a published tag or commit SHA instead of `main` to install a fixed version.
GitHub Pages, release uploads, and a separate file host are unnecessary.

## Push this repository

Create an empty **public** GitHub repository without an initial README, then run
from this directory, replacing `OWNER/REPO`:

```sh
git remote add origin git@github.com:OWNER/REPO.git
git push -u origin main
python3 scripts/github_install_link.py
```

The final command reads the `origin` remote and prints the actual Markdown URL,
optional ZIP URL, and the complete installation message. HTTPS remotes work too.
To print the message before adding a remote:

```sh
python3 scripts/github_install_link.py --repo OWNER/REPO
```

No repository owner or name is hardcoded in the skill. Both distributions are
committed directly, so their raw links work as soon as the push completes.

## Capabilities and requirements

The helper stores a device credential privately, reconnects after token expiry,
checks prepaid credit, returns a checkout link when funds are missing, and
tracks a user-authorized spending allowance. A separate watcher tracks browser
activity and pending-input grace, emits reminders, and terminates idle or
completed sessions. It preserves operation IDs during recovery.

The receiving agent needs Node.js 20+, HTTPS and external CDP/WebSocket access,
persistent private storage, and a background process that survives conversation
waits. Python is needed only for maintaining this repository, not for the agent's
runtime. Exact host support depends on permitted tools; this has not been
installed on Muse, Instinct, or Dots. A skill cannot override a platform-enforced
browser or add capabilities its tools do not expose.

**Current server limitation:** the live service's authenticated tool list,
checked on 2026-10-02, has no session-extension operation. Its balance response
reports 600-second blocks. Five-minute **idle cleanup** works independently of
that server TTL. Preserving the same browser during a longer login or task
requires a real renewal API. The skill reports this limitation and only allows
fixed-duration sessions when the user accepts them. See
[renewal requirements](popcorn-browser/references/renewal.md).

## Repository layout

| Path | Purpose |
| --- | --- |
| `popcorn-browser.md` | Generated, self-contained Markdown for link-only installation. |
| `popcorn-browser.zip` | Generated, optional standard skill-folder archive. |
| `popcorn-browser/` | Editable skill, helper scripts, references, and npm lockfile. |
| `scripts/build_skill.py` | Build both distributions or check that they are current. |
| `scripts/github_install_link.py` | Print installation URLs and a ready-to-send message. |
| `tests/` | Offline lifecycle, payment-recovery, and distribution checks. |
| `.github/workflows/validate.yml` | GitHub checks on pushes and pull requests. |

Credentials and browser state belong outside the repository, normally in
`~/.config/popcorn-browser`. `.gitignore` also excludes those files, local agent
configuration, dependencies, and logs. Distribution builds include only an
explicit list of source files.

## Development and validation

Edit files under `popcorn-browser/`, then rebuild the two committed distributions:

```sh
python3 scripts/build_skill.py
node tests/session.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 scripts/build_skill.py --check
```

For a local install of the browser dependency:

```sh
cd popcorn-browser
npm ci --ignore-scripts
```

A local browser download is unnecessary: Playwright attaches to Popcorn's
remote browser. The GitHub workflow uses the lockfile and runs offline tests;
it does not sign in, buy credits, or create a paid session. Stale distributions
fail validation. Commit rebuilt `popcorn-browser.md` and `popcorn-browser.zip`
alongside source changes.

Live checks on 2026-10-02 covered device authentication, token storage, tool
discovery, zero balance, and the insufficient-credit checkout link. No checkout
was completed or paid browser allocated. Real browser interaction, termination,
and renewal were not exercised against a funded session. The lifecycle and
recovery behavior is tested locally with controlled responses.
