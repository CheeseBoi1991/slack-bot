import crypto from "node:crypto";

import { Sandbox } from "e2b";

const TEMPLATE = process.env.E2B_TEMPLATE ?? "claude-code";

// Bound the run so we always have time left to post the answer back to Slack
// before Vercel terminates the function at maxDuration.
const RUN_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 10 * 60 * 1000);

// How long a thread's sandbox may sit before E2B reclaims it, refreshed on
// every turn. This used to mean "kill it eagerly, E2B bills for the lifetime";
// now that the box outlives the run it is a BACKSTOP. We pause the sandbox
// ourselves the moment the turn ends — a paused sandbox bills no compute — so
// in the normal case this deadline never arrives. It is here for the run that
// dies without reaching that pause, and `lifecycle.onTimeout: "pause"` (see
// getOrCreateSandbox) means even then the thread loses time, not its
// transcript.
const SANDBOX_TIMEOUT_MS = RUN_TIMEOUT_MS + 60_000;

// The two well-known directories the Slack layer and the model agree on:
// attachments land in inputs before the run, anything the model wants to send
// back it drops into outputs. They used to be self-cleaning, because the whole
// container was. They are not any more — see the hygiene in runClaude and in
// the run script; a leftover here is turn 1's artifact re-uploaded on turn 2.
const INPUT_DIR = "/tmp/inputs";
const OUTPUT_DIR = "/tmp/outputs";

// Don't try to ship a giant artifact back through Slack — it would fail the
// upload anyway. Cap count and per-file size and skip the rest (logged).
const MAX_OUTPUT_FILES = 5;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// A fixed namespace for the UUIDv5 below. Any constant UUID does; it is there
// so ids derived here can't collide with ids someone derives from the same
// channel/thread string for a different purpose.
const SESSION_NAMESPACE = "6c9e3a1f-8b2d-4f7a-9c31-5a0e7d24b18f";

// Exit code the run script uses for "another turn already holds the lock".
// 75 is EX_TEMPFAIL from sysexits.h — a conventional "try again later" that
// nothing else in the pipeline returns, so it can never be mistaken for a real
// failure out of claude.
const BUSY_EXIT_CODE = 75;

/**
 * The Claude Code session id for a Slack thread: a pure function of the thread,
 * stored nowhere.
 *
 * `claude --session-id` lets US choose the id rather than handing us one back,
 * and that is what removes the need for a database. Given a channel and a
 * thread timestamp we can always re-derive the same id, so a redeploy, a cold
 * function or a different region all land on the same session.
 *
 * It has to be a valid UUID or the CLI rejects it, hence the v5 shape: SHA-1
 * over a fixed namespace plus the name, with the version and variant bits
 * stamped in per RFC 4122. That is all `uuid`'s v5 does for our purposes, so we
 * don't take the dependency for it.
 */
export function sessionIdFor(channelId, threadTs) {
  const namespace = Buffer.from(SESSION_NAMESPACE.replace(/-/g, ""), "hex");
  const bytes = crypto
    .createHash("sha1")
    .update(namespace)
    .update(`${channelId}:${threadTs}`)
    .digest()
    .subarray(0, 16);

  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * Raised when this thread's sandbox is already running a turn.
 *
 * Its own type so the Slack layer can say "I'm still working on your last
 * message" instead of rendering a failure. Nothing failed: the request simply
 * arrived while the previous one was still going.
 */
export class BusyError extends Error {
  constructor() {
    super("a turn is already running in this thread's sandbox");
    this.name = "BusyError";
  }
}

/**
 * This thread's sandbox — found and resumed, or created.
 *
 * There is no database here either. The lookup key is the sandbox's own
 * METADATA, which `Sandbox.list` filters on and which matches PAUSED sandboxes
 * too — so a thread that has been quiet for an hour is found exactly like one
 * that replied a second ago.
 *
 * @returns {Promise<{sandbox: Sandbox, isNew: boolean}>} `isNew` is what the
 *          caller gates one-time provisioning on: a resumed box already has it.
 */
async function getOrCreateSandbox({ channelId, threadTs }) {
  const metadata = { slack_channel: channelId, slack_thread: threadTs };

  // `list` returns a PAGINATOR, not an array — `.nextItems()` is the first
  // page, and one page is plenty: a thread should have exactly one sandbox.
  const matches = await Sandbox.list({ query: { metadata } }).nextItems();

  if (!matches.length) {
    const sandbox = await Sandbox.create(TEMPLATE, {
      metadata,
      timeoutMs: SANDBOX_TIMEOUT_MS,
      // Not decoration. The default is "kill", which would DESTROY the session
      // transcript — the thread's entire memory — the first time a box sat idle
      // past its deadline. Pausing keeps the disk, so the worst an expiry can
      // do is make the next turn slower.
      lifecycle: { onTimeout: "pause" },
    });
    return { sandbox, isNew: true };
  }

  // Metadata is a filter, not a unique key, so two mentions arriving in one
  // thread at the same moment can both miss the lookup above and both create a
  // box. Converge on the OLDEST, always: it is the one holding the session
  // transcript, and "oldest" is a decision every turn makes the same way
  // without coordinating. The others are left alone rather than killed — one
  // may be mid-turn — and park themselves when their own timeout fires.
  const [oldest, ...rest] = [...matches].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );
  if (rest.length) {
    const ignored = rest.map((s) => s.sandboxId).join(", ");
    console.warn(
      `thread has ${matches.length} sandboxes; using ${oldest.sandboxId}, ignoring ${ignored}`,
    );
  }

  // connect() RESUMES a paused sandbox — that is the entire restore path, and
  // it is also why stopping one must never go through connect() (see the
  // `finally` in runClaude). Passing timeoutMs is not optional: connect's own
  // default is five minutes, which would park the box mid-run.
  const sandbox = await Sandbox.connect(oldest.sandboxId, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  return { sandbox, isNew: false };
}

/**
 * The shell wrapper around `claude`, and the only place that knows the sandbox
 * now outlives the turn. Three jobs:
 *
 * 1. ONE TURN AT A TIME. Two `--resume` runs against the same session interleave
 *    their writes and corrupt the transcript permanently — a thread's whole
 *    memory, unrepairable. `flock -n` takes the lock or gives up immediately.
 *    Immediately, not queued: this function is awaited inside a Slack event
 *    handler, so waiting for the lock would just burn the caller's maxDuration
 *    and time out anyway. Losing the race is reported, not waited out.
 * 2. FIRST TURN OR RESUME. The ground truth is the transcript file itself, not a
 *    marker we maintain: if claude already has a session file for this id,
 *    resume it, otherwise create it. The `*` is deliberate — the directory under
 *    ~/.claude/projects is derived from claude's working directory, which `-p`
 *    picks for us, so we match on the id and let the path be whatever it is.
 * 3. HYGIENE. /tmp/outputs is emptied here, inside the lock, rather than before
 *    the run: a turn that loses the race must not delete the files the winning
 *    turn is busy producing.
 *
 * The session id rides in as an env var rather than being interpolated, for the
 * same reason the prompt is piped from a file — the shell only ever sees a fixed
 * string.
 */
function runScript({ claudeArgs }) {
  return `
exec 9>/tmp/turn.lock
flock -n 9 || exit ${BUSY_EXIT_CODE}

rm -rf ${OUTPUT_DIR}
mkdir -p ${OUTPUT_DIR}

SESSION_FLAG=--session-id
ls ~/.claude/projects/*/"$JOESTAR_SESSION_ID".jsonl >/dev/null 2>&1 && SESSION_FLAG=--resume

cat /tmp/prompt.txt | claude -p ${claudeArgs} "$SESSION_FLAG" "$JOESTAR_SESSION_ID"
`;
}

/**
 * Runs one prompt through Claude Code in this THREAD's sandbox — created on the
 * first message, resumed on every one after it, and paused in between.
 *
 * @param {object}   opts
 * @param {string}   opts.prompt      the (already-assembled) prompt text
 * @param {string}   opts.channelId   the Slack channel this run belongs to
 * @param {string}   opts.threadTs    the thread it is answering in. Together
 *                                    with channelId this is the whole state
 *                                    store: it names the sandbox (metadata) and
 *                                    derives the session id.
 * @param {Array}    [opts.inputFiles] `{ name, data: Buffer }` attachments to
 *                                     drop into /tmp/inputs before the run
 * @returns {Promise<{text, costUsd, sessionId, outputFiles}>}
 * @throws {BusyError} if a turn is already running in this thread's sandbox
 *
 * Auth note: we pass CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY, so the run
 * bills against a Claude subscription instead of API credit. That token is also
 * why `--bare` is absent below — bare mode deliberately skips OAuth and would
 * leave the CLI unauthenticated.
 */
export async function runClaude({ prompt, channelId, threadTs, inputFiles = [] }) {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set");
  if (!channelId || !threadTs) {
    throw new Error("runClaude needs channelId and threadTs to find its sandbox");
  }

  const sessionId = sessionIdFor(channelId, threadTs);
  const { sandbox } = await getOrCreateSandbox({ channelId, threadTs });

  // Set when this turn bounced off the lock. The teardown below then has to
  // keep its hands off the box: it belongs to the turn still running in it, and
  // pausing it would suspend that run mid-answer.
  let busy = false;

  try {
    // Empty this turn's inbox before filling it. On a throwaway container the
    // directory was new every time; on a box that survives the reply, turn 1's
    // attachments would otherwise still be sitting there on turn 2, alongside
    // (or overwriting) the ones this turn is about to write.
    //
    // /tmp/outputs gets the same treatment inside the run script — see there for
    // why that one has to happen under the lock and this one can't.
    await sandbox.commands.run(`rm -rf ${INPUT_DIR} && mkdir -p ${INPUT_DIR}`);

    // Attachments are binary and untrusted; write them as bytes, never as a
    // shell argument. A Blob avoids Buffer's shared-pool slicing surprises.
    if (inputFiles.length) {
      await sandbox.files.write(
        inputFiles.map((f) => ({
          path: `${INPUT_DIR}/${f.name}`,
          data: new Blob([f.data]),
        })),
      );
    }

    // The prompt is untrusted Slack input, so it never touches the command
    // line. Writing it to a file and piping it in means the shell only ever
    // sees a fixed string, and Claude reads the prompt from stdin.
    await sandbox.files.write("/tmp/prompt.txt", prompt);

    // The OAuth token is passed HERE, per command — not at Sandbox.create.
    // E2B's create-time envs live on the client-side Sandbox object and do not
    // reach the process commands.run spawns, so a create-only token arrives
    // empty and Claude rejects the blank credential as "Invalid API key". This
    // is the load-bearing line for auth. (Lesson copied from percy-agent.)
    //
    // requestTimeoutMs: 0 disables the SDK's own request timeout so only our
    // RUN_TIMEOUT_MS bounds the run. On a non-zero exit e2b throws a
    // CommandExitError carrying stdout/stderr — surface that, since bare
    // "exit status 1" says nothing about why claude failed.
    let result;
    try {
      result = await sandbox.commands.run(
        runScript({
          claudeArgs: "--output-format json --dangerously-skip-permissions",
        }),
        {
          envs: {
            CLAUDE_CODE_OAUTH_TOKEN: token,
            JOESTAR_SESSION_ID: sessionId,
          },
          timeoutMs: RUN_TIMEOUT_MS,
          requestTimeoutMs: 0,
        },
      );
    } catch (err) {
      // The one exit code that isn't a failure: another turn holds this
      // thread's lock. Distinguishable on purpose, so the Slack layer can say
      // so rather than posting a warning with someone else's stack trace.
      if (err.exitCode === BUSY_EXIT_CODE) {
        busy = true;
        throw new BusyError();
      }
      const detail = (err.stderr || err.stdout || "").trim();
      console.error("claude exited non-zero:", {
        exitCode: err.exitCode,
        stderr: err.stderr,
        stdout: err.stdout,
      });
      throw new Error(detail ? detail.slice(0, 1500) : err.message);
    }

    const parsed = parseResult(result.stdout);
    // Collect outputs after a successful run — a failed run threw above.
    parsed.outputFiles = await collectOutputs(sandbox);
    return parsed;
  } finally {
    // PAUSE, don't kill. The conversation lives on this box's filesystem — the
    // session transcript claude just wrote is the thread's memory, and killing
    // the sandbox would throw it away as surely as deleting the messages. A
    // paused sandbox bills no compute and wakes in a couple of seconds, so
    // there is nothing to gain by destroying it.
    //
    // BY ID, never through a fresh connect(): connect() RESUMES a paused box,
    // so a "stop" that connected first would wake a sandbox up in order to put
    // it to sleep. We already hold a live handle here; all we want off it is
    // its id.
    //
    // Skipped when this turn lost the lock — see `busy` above.
    if (!busy) {
      // Don't let a teardown failure mask a real error from the run above.
      await Sandbox.pause(sandbox.sandboxId).catch((err) =>
        console.error("sandbox.pause failed:", err),
      );
    }
  }
}

/**
 * Reads whatever the model left in /tmp/outputs, as bytes, ready to upload to
 * Slack. Over-cap files are skipped (logged) rather than failing the whole run.
 */
async function collectOutputs(sandbox) {
  let entries;
  try {
    entries = await sandbox.files.list(OUTPUT_DIR);
  } catch (err) {
    console.error("listing outputs failed:", err.message);
    return [];
  }

  const files = entries.filter((e) => e.type === "file");
  const out = [];
  for (const entry of files.slice(0, MAX_OUTPUT_FILES)) {
    if (entry.size > MAX_OUTPUT_BYTES) {
      console.warn(`skipping output ${entry.name}: ${entry.size} bytes over cap`);
      continue;
    }
    try {
      const data = await sandbox.files.read(entry.path, { format: "bytes" });
      out.push({ name: entry.name, data: Buffer.from(data) });
    } catch (err) {
      console.error(`reading output ${entry.name} failed:`, err.message);
    }
  }
  if (files.length > MAX_OUTPUT_FILES) {
    console.warn(`outputs: ${files.length} files, only first ${MAX_OUTPUT_FILES} sent`);
  }
  return out;
}

/**
 * `--output-format json` prints a single object whose `result` field holds the
 * final assistant text. Anything else means the CLI failed before it got that
 * far, and its raw output is the most useful thing to surface.
 */
function parseResult(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(`Claude Code returned non-JSON output: ${stdout.slice(0, 500)}`);
  }

  if (payload.is_error) {
    throw new Error(payload.result ?? "Claude Code reported an error");
  }

  return {
    text: payload.result ?? "",
    costUsd: payload.total_cost_usd,
    sessionId: payload.session_id,
  };
}
