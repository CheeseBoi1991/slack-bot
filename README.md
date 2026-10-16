# Joestar

A Slack bot. A Vercel function receives a Slack event, finds (or creates) an E2B sandbox for the thread, and runs your message through Claude Code inside it. The answer replaces a "Thinking…" placeholder in the thread.

Anyone who can @mention the bot can run arbitrary prompts, and arbitrary code, inside the sandbox.

## Configuration

Set these in Vercel (Project → Settings → Environment Variables). Env changes only apply to a **new deployment**, so redeploy after changing them.

| Var                        | Contents                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`     | Slack app → Basic Information → Signing Secret                                         |
| `SLACK_BOT_TOKEN`          | Slack app → OAuth & Permissions → Bot User OAuth Token (`xoxb-…`)                      |
| `E2B_API_KEY`              | https://e2b.dev/dashboard                                                              |
| `CLAUDE_CODE_OAUTH_TOKEN`  | From `claude setup-token`; runs bill against the subscription, not API credit          |
| `E2B_TEMPLATE`             | Optional. Sandbox template name (default `claude-code`)                                |
| `CLAUDE_TIMEOUT_MS`        | Optional. Max time for one Claude run (default 10 minutes)                             |
| `EXA_API_KEY`              | Optional. https://dashboard.exa.ai — gives the agent the [Exa](https://docs.exa.ai/reference/exa-mcp) web-search MCP server |
| `GITHUB_APP_ID`            | Optional. Numeric App ID. See [GitHub access](#github-access)                          |
| `GITHUB_INSTALLATION_ID`   | Optional. Numeric installation ID (the number at the end of the install's settings URL) |
| `GITHUB_APP_PRIVATE_KEY`   | Optional. The App's `.pem`, **base64-encoded onto a single line** — not the raw PEM    |

## Sandbox template

The sandbox image is defined in `e2b/template.js`. After changing it, rebuild:

    npm run template:build

A stale template of the same name silently shadows a new one, so a code change that needs something new in the image (like the GitHub CLI) does nothing until you rebuild. Verify in a fresh sandbox that `claude --version`, `git --version` and `gh --version` all answer before debugging anything else.

## GitHub access

Optional. When configured, the agent can clone, branch, commit, push a **new branch**, open pull requests and read issues, using a token minted fresh for each request that expires in one hour. Leave all three `GITHUB_*` vars unset and the feature is simply off; set only some and the bot answers normally but adds a warning that GitHub access is unavailable.

### Threat model

Assume the worst: anyone who can @mention the bot can run arbitrary code in the sandbox **with the token in its environment**. Everything Claude spawns inherits `GH_TOKEN`, which is what lets `git` and `gh` work and also means any code the model runs can read it. The boundary that actually holds is **what GitHub refuses to do** with that token. Anything inside the sandbox is defence in depth.

The App private key never enters the sandbox: the token is minted in the Vercel function (`lib/github.js`), and the sandbox only ever holds the expiring token. The token is minted on every request and not cached across invocations. The sandbox persists between turns, so anything the model writes to disk survives until the token expires.

### 1. Create the GitHub App

Create a GitHub App and install it on **selected repositories only**. Generate a private key.

Grant:

- `contents`: read and write
- `pull_requests`: read and write
- `metadata`: read

Deliberately **do not** grant:

- `workflows`: it would let injected code rewrite CI and escalate into Actions secrets.
- `administration`: it would let the agent remove branch protection.

### 2. Protect each default branch

Add a ruleset on the default branch of every installed repository: pull request required with 1 approval, force pushes blocked, deletions restricted, **empty bypass list**. This is what stops the agent pushing to the default branch. It protects the default branch only (see the push guard below).

### 3. Put the key in Vercel

Multiline env vars do not survive the round trip cleanly, so base64-encode the key onto one line:

    base64 -i your-app.private-key.pem | tr -d '\n' | pbcopy

On Windows (PowerShell):

    [Convert]::ToBase64String([IO.File]::ReadAllBytes("your-app.private-key.pem")) | Set-Clipboard

Paste it as `GITHUB_APP_PRIVATE_KEY`. Despite the name it holds base64, and the code decodes it first. If the decoded value is not a PEM, the bot says the variable is expected to be base64. Never commit the `.pem` (`*.pem` is gitignored).

### 4. Rebuild the template

`npm run template:build`, so the sandbox has `gh`. See [Sandbox template](#sandbox-template).

### The push guard

One PreToolUse hook (`lib/git-guard.js`) blocks destructive `git push` forms: `--force`, `-f`, `--force-with-lease`, `--delete`, `-d`, `--mirror`, `--prune`, a leading `+` in a refspec, and colon-delete (`git push origin :branch`). It exists because the ruleset above covers the default branch only, so `contents: write` could otherwise still force-push over or delete any other branch.

It is a nudge, not a boundary. It parses command text, so an alias, a shell function, indirection (`G=push; git $G --force`), `sh -c "…"`, `gh api` deleting a ref, or calling `git-receive-pack` directly all walk past it. It prevents an agent's bad decision, not an attacker's. It is also not a general command denylist, on purpose: the sandbox is thrown away and a list that stops the obvious cases reads as protection it isn't.

### Known limitations

- **Network is open.** E2B allows outbound network by default, so code in the sandbox can send the token anywhere. Nothing here prevents that; the one-hour expiry and the App's narrow permissions limit the damage.
- Secret scanning push protection will block a push that contains a token.
- An expired token returns `401`. The bot reports GitHub's own status and message when it can't mint one.
- `gh pr create` needs the branch pushed first, and the PR base must be the repository's real default branch, not an assumed `main`. The model is told both.
