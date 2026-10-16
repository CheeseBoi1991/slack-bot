import { Sandbox } from "e2b";

const TEMPLATE = process.env.E2B_TEMPLATE ?? "claude-code";

// Bound the run so we always have time left to post the answer back to Slack
// before Vercel terminates the function at maxDuration (300s on Hobby).
const RUN_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS ?? 4 * 60 * 1000);

// Keep the sandbox alive a little past the run itself so a slow start doesn't
// kill it mid-answer. E2B bills for the lifetime, so we still kill it eagerly.
const SANDBOX_TIMEOUT_MS = RUN_TIMEOUT_MS + 60_000;

// Convention shared with the model: read attachments from INPUT_DIR, drop
// anything to send back to Slack into OUTPUT_DIR.
export const INPUT_DIR = "/tmp/inputs";
export const OUTPUT_DIR = "/tmp/outputs";

// Caps on what we pull back out of the sandbox for upload to Slack.
const MAX_OUTPUT_FILES = 5;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;

const OUTPUT_INSTRUCTIONS = `Output convention: if the user wants a file, image or document sent back to them, write it into ${OUTPUT_DIR}/ (it already exists) and mention it in your reply. Everything in that directory is uploaded to the Slack thread automatically. Do not paste file contents into your reply when you have written them to a file.`;

/**
 * Runs one prompt through Claude Code inside a throwaway E2B sandbox.
 *
 * `inputs` are files ({ name, data }) written to INPUT_DIR before the run; the
 * caller has already put their paths in the prompt. Whatever the model leaves
 * in OUTPUT_DIR comes back as `outputs` ({ name, data }), read before the
 * sandbox is killed.
 *
 * Auth note: we pass CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY, so the run
 * bills against a Claude subscription instead of API credit. That token is also
 * why `--bare` is absent below — bare mode deliberately skips OAuth and would
 * leave the CLI unauthenticated.
 */
export async function runClaude(prompt, { inputs = [] } = {}) {
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN is not set");

  const sandbox = await Sandbox.create(TEMPLATE, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });

  try {
    // The prompt is untrusted Slack input, so it never touches the command
    // line. Writing it to a file and piping it in means the shell only ever
    // sees a fixed string, and Claude reads the prompt from stdin.
    await sandbox.files.write("/tmp/prompt.txt", `${OUTPUT_INSTRUCTIONS}

${prompt}`);

    await sandbox.commands.run(`mkdir -p ${INPUT_DIR} ${OUTPUT_DIR}`);
    if (inputs.length) {
      await sandbox.files.writeFiles(
        inputs.map(({ name, data }) => ({
          path: `${INPUT_DIR}/${name}`,
          data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        })),
      );
    }

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
        "cat /tmp/prompt.txt | claude -p --output-format json --dangerously-skip-permissions",
        {
          envs: { CLAUDE_CODE_OAUTH_TOKEN: token },
          timeoutMs: RUN_TIMEOUT_MS,
          requestTimeoutMs: 0,
        },
      );
    } catch (err) {
      const detail = (err.stderr || err.stdout || "").trim();
      console.error("claude exited non-zero:", {
        exitCode: err.exitCode,
        stderr: err.stderr,
        stdout: err.stdout,
      });
      throw new Error(detail ? detail.slice(0, 1500) : err.message);
    }

    return { ...parseResult(result.stdout), outputs: await collectOutputs(sandbox) };
  } finally {
    // Don't let a teardown failure mask a real error from the run above.
    await sandbox.kill().catch((err) => console.error("sandbox.kill failed:", err));
  }
}

/**
 * Reads the files the model left in OUTPUT_DIR (top level only), skipping
 * anything over the size cap. Must run before the sandbox is killed.
 */
async function collectOutputs(sandbox) {
  try {
    const entries = await sandbox.files.list(OUTPUT_DIR);
    const outputs = [];
    for (const entry of entries) {
      if (outputs.length >= MAX_OUTPUT_FILES) break;
      if (entry.type !== "file" || entry.size === 0 || entry.size > MAX_OUTPUT_BYTES) continue;
      const data = await sandbox.files.read(entry.path, { format: "bytes" });
      outputs.push({ name: entry.name, data });
    }
    return outputs;
  } catch (err) {
    // A failed collection shouldn't discard an answer we already have.
    console.error("collecting outputs failed:", err);
    return [];
  }
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
