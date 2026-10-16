import { WebClient } from "@slack/web-api";

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// One shared client. It handles rate limits and retries for us, and is the
// only thing in this repo that talks to the Slack Web API.
export const web = new WebClient(BOT_TOKEN);

// The placeholder we post while Claude works. Also the string renderTranscript
// filters out, so an in-flight "thinking" bubble never leaks into context.
export const THINKING_TEXT = "🧠 Thinking…";

/**
 * The bot's own user id, from `auth.test`, cached for the lifetime of the warm
 * function instance. We need it to recognise (and ignore) our own posts once we
 * subscribe to `message.*`, and to decide whether a thread is ours.
 */
let cachedBotUserId;
export async function getBotUserId() {
  if (cachedBotUserId) return cachedBotUserId;
  const res = await web.auth.test();
  cachedBotUserId = res.user_id;
  return cachedBotUserId;
}

/**
 * Turns raw Slack text into what the user actually typed: drops `<@BOT>`
 * mentions, unwraps Slack's `<url|label>` link markup, and undoes the three
 * entities Slack escapes.
 */
export function extractPrompt(text = "") {
  return text
    .replace(/<@[A-Z0-9]+>/gi, " ")
    .replace(/<(https?:[^|>]+)\|[^>]*>/gi, "$1")
    .replace(/<(https?:[^>]+)>/gi, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export async function postMessage({ channel, threadTs, text }) {
  return web.chat.postMessage({ channel, thread_ts: threadTs, text });
}

/**
 * Posts the "thinking" placeholder and returns its `ts` so the caller can edit
 * it in place with the final answer. Returns null if the post failed — the
 * caller falls back to a fresh message.
 */
export async function postThinking({ channel, threadTs }) {
  try {
    const res = await web.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: THINKING_TEXT,
    });
    return res.ts;
  } catch (err) {
    console.error("postThinking failed:", err.data?.error || err.message);
    return null;
  }
}

/**
 * Edits the placeholder in place if we have its `ts`; otherwise posts a fresh
 * message into the thread.
 */
export async function finalize({ channel, threadTs, ts, text }) {
  if (ts) return web.chat.update({ channel, ts, text });
  return web.chat.postMessage({ channel, thread_ts: threadTs, text });
}

/**
 * Adds a reaction, swallowing `already_reacted` (which just means we (or a
 * retry) got there first). Every other failure is logged, never thrown — a
 * missing emoji must not sink the actual run.
 */
export async function addReaction({ channel, timestamp, name }) {
  try {
    await web.reactions.add({ channel, timestamp, name });
  } catch (err) {
    const code = err.data?.error;
    if (code === "already_reacted") return;
    console.error(`reactions.add ${name} failed:`, code || err.message);
  }
}

export async function fetchThreadReplies({ channel, threadTs, limit = 20 }) {
  try {
    const res = await web.conversations.replies({
      channel,
      ts: threadTs,
      limit,
    });
    return res.messages || [];
  } catch (err) {
    console.error("conversations.replies failed:", err.data?.error || err.message);
    return [];
  }
}

/**
 * True if the bot has already posted in this set of thread messages. A message
 * we posted via `chat.postMessage` comes back with `user` set to our own user
 * id, so that's the reliable tell that the thread is ours to continue.
 */
export function botOwnsThread(messages, botUserId) {
  return messages.some((m) => m.user === botUserId);
}

/**
 * Renders prior thread messages as `speaker: text` lines for transcript replay.
 * Skips the triggering message (that's the new prompt), Slack's structural
 * subtypes (joins, edits…), and our own "thinking" placeholder.
 */
export function renderTranscript(messages, { botUserId, excludeTs }) {
  const lines = [];
  for (const m of messages) {
    if (m.ts === excludeTs) continue;
    if (m.subtype && m.subtype !== "file_share") continue;

    const isBot = m.user === botUserId || Boolean(m.bot_id);
    const text = extractPrompt(m.text || "");
    const fileCount = Array.isArray(m.files) ? m.files.length : 0;

    if (isBot && (text === THINKING_TEXT || text === "")) continue;
    if (!text && !fileCount) continue;

    const speaker = isBot ? "Joestar" : `User ${m.user || "unknown"}`;
    const suffix = fileCount ? ` [attached ${fileCount} file(s)]` : "";
    lines.push(`${speaker}: ${text}${suffix}`.trim());
  }
  return lines.join("\n");
}

/**
 * Downloads a Slack-hosted file with the bot token.
 *
 * The load-bearing gotcha: a `url_private` fetch with a missing or insufficient
 * token returns HTTP 200 with an HTML sign-in page, NOT a 401. So a naive
 * `res.ok` check hands you a chunk of HTML believing it's the file. We sniff
 * `content-type` and treat any `text/html` body as failure.
 *
 * Returns `{ name, data, mimetype }` or null (logged) on any failure.
 */
export async function downloadSlackFile(file, { maxBytes } = {}) {
  const url = file.url_private_download || file.url_private;
  if (!url) return null;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    });
    if (!res.ok) {
      console.error(`download ${file.name} failed: HTTP ${res.status}`);
      return null;
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      console.error(
        `download ${file.name}: got HTML, not bytes — missing files:read or bot not in channel`,
      );
      return null;
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (maxBytes && data.length > maxBytes) {
      console.error(`download ${file.name}: ${data.length} bytes over ${maxBytes} cap`);
      return null;
    }
    return { name: file.name, data, mimetype: file.mimetype };
  } catch (err) {
    console.error(`download ${file.name} threw:`, err.message);
    return null;
  }
}

/**
 * Uploads one file into a thread via the modern external-upload flow.
 * `files.uploadV2` runs `getUploadURLExternal` → PUT bytes →
 * `completeUploadExternal` internally, which is the only supported path since
 * Slack retired v1 `files.upload` in March 2025.
 */
export async function uploadFile({ channel, threadTs, filename, data, title, initialComment }) {
  return web.files.uploadV2({
    channel_id: channel,
    thread_ts: threadTs,
    filename,
    title: title || filename,
    file: Buffer.isBuffer(data) ? data : Buffer.from(data),
    initial_comment: initialComment,
  });
}
