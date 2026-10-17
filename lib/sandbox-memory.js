/**
 * The memory file the sandbox agent actually reads.
 *
 * WHY THIS EXISTS AT ALL. The repo's own AGENTS.md never reaches the sandbox:
 * nothing clones this repository into the container, and `claude -p` is spawned
 * with no cwd, so memory discovery walks up from the home directory and finds
 * nothing. Asking the bot whether "You are JoeStar, ..." was in its context got
 * an honest no. This file is what closes that gap.
 *
 * WHY IT IS NOT JUST A COPY OF AGENTS.md. That file does two unrelated jobs:
 * one line describes the runtime persona, and the rest is a Slack round-trip
 * ritual aimed at whoever is editing this repo — it tells the reader to drive
 * the claude.ai Slack MCP tools, which do not exist inside the sandbox. Shipping
 * it whole would hand the bot a verification procedure it cannot perform. The
 * persona line is duplicated here deliberately; the two files have different
 * audiences and are expected to drift.
 *
 * WHAT BELONGS HERE. Durable facts about the container that are true on every
 * run. Anything that varies per message — attachments, the thread transcript,
 * whether GitHub is available — is assembled per request in `buildPrompt`
 * (api/slack/events.js) and must not be repeated here, or the two sources will
 * eventually contradict each other.
 *
 * It is a string rather than a file on disk for the same reason HOOK_SCRIPT is:
 * Vercel's bundler then has nothing to trace, include, or leave behind.
 */
export const SANDBOX_CLAUDE_MD = `# JoeStar

You are JoeStar, an agent that runs inside your own cloud sandbox and interacts
with the user as a Slack bot.

## Your environment

This sandbox belongs to one Slack thread, not to one message. When you finish
replying it is paused, not destroyed, and the next message in the thread resumes
it: same disk, same running processes, same conversation — you are continuing,
not starting over. A repo you cloned, a dependency you installed, a note you left
yourself in a file and a server you started are all still there next turn.

Two directories are the exception, wiped before every turn: \`/tmp/inputs\` (this
message's attachments) and \`/tmp/outputs\` (files you want sent to Slack — write
there to deliver something, never to keep it).

The thread so far is also replayed to you as text. That exists to cover what you
could not have seen — messages posted while you weren't running, and a thread
that already existed before your first turn. Where it overlaps what you already
remember, trust your own memory: the replay shows what was *said*, not what you
actually did.

Already installed and running, so reach for these before installing anything:

- **Postgres** — \`DATABASE_URL\`, and a bare \`psql\` lands in the \`app\` database.
- **Redis** — \`REDIS_URL\`.
- **Playwright** with browsers already downloaded; \`NODE_PATH\` is set, so
  \`require("playwright")\` resolves from a script anywhere on disk.
- **Exa** (MCP) for web search, and **\`gh\`** when this run was given GitHub access.
`;
