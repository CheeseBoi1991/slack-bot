import crypto from "node:crypto";

import { waitUntil } from "@vercel/functions";

import { runClaude } from "../../lib/claude-sandbox.js";

const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// Slack renders roughly 4k characters before truncating; leave room for the
// note we append when we cut something off.
const MAX_REPLY_CHARS = 3800;

/**
 * Reads the untouched request body. Signature verification hashes the exact
 * bytes Slack sent, so re-serialising a parsed object would not survive.
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Verifies the request actually came from Slack.
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */
function isValidSlackRequest(rawBody, timestamp, signature) {
  if (!timestamp || !signature) return false;

  // Reject anything older than 5 minutes (replay protection).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 * 5) return false;

  const expected =
    "v0=" +
    crypto
      .createHmac("sha256", SIGNING_SECRET)
      .update(`v0:${timestamp}:${rawBody}`)
      .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function slackApi(method, body) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${BOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!data.ok) console.error(`${method} failed:`, data.error);
  return data;
}

/**
 * Turns the raw `app_mention` text into the prompt the user actually typed:
 * drops the `<@BOT>` mentions, unwraps Slack's link markup, and undoes the
 * three entities Slack escapes.
 */
function extractPrompt(text = "") {
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

function truncate(text) {
  if (text.length <= MAX_REPLY_CHARS) return text;
  return `${text.slice(0, MAX_REPLY_CHARS)}\n\n_…truncated._`;
}

/**
 * Everything past the Slack ack. Posts a placeholder immediately so the thread
 * shows progress, then edits it in place with whatever Claude came back with —
 * a sandbox run takes minutes, which is far too long to leave a mention silent.
 */
async function replyWithClaude({ channel, threadTs, prompt }) {
  const placeholder = await slackApi("chat.postMessage", {
    channel,
    thread_ts: threadTs,
    text: "🧠 Thinking…",
  });

  const update = (text) =>
    placeholder.ok
      ? slackApi("chat.update", { channel, ts: placeholder.ts, text })
      : slackApi("chat.postMessage", { channel, thread_ts: threadTs, text });

  try {
    const { text } = await runClaude(prompt);
    await update(truncate(text || "_Claude returned an empty response._"));
  } catch (err) {
    console.error("Claude run failed:", err);
    await update(`:warning: ${truncate(err.message)}`);
  }
}

function send(res, status, body) {
  res.statusCode = status;
  if (body === undefined) return res.end();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405);

  if (!SIGNING_SECRET || !BOT_TOKEN) {
    console.error("Missing SLACK_SIGNING_SECRET or SLACK_BOT_TOKEN");
    return send(res, 500);
  }

  const rawBody = await readRawBody(req);

  if (
    !isValidSlackRequest(
      rawBody,
      req.headers["x-slack-request-timestamp"],
      req.headers["x-slack-signature"],
    )
  ) {
    return send(res, 401);
  }

  const payload = JSON.parse(rawBody);

  // One-time URL verification when you point Slack at this endpoint.
  if (payload.type === "url_verification") {
    return send(res, 200, { challenge: payload.challenge });
  }

  // Slack retries if we're slow, and a Claude run is always slower than its
  // 3s patience. Without this every mention would start a second sandbox.
  if (req.headers["x-slack-retry-num"]) return send(res, 200);

  const event = payload.event;

  if (event?.type === "app_mention" && !event.bot_id) {
    const prompt = extractPrompt(event.text);
    const channel = event.channel;
    const threadTs = event.thread_ts ?? event.ts;

    // Ack first, work second. Slack gives us 3 seconds; the sandbox needs
    // minutes, so the run has to outlive the response.
    send(res, 200);

    waitUntil(
      prompt
        ? replyWithClaude({ channel, threadTs, prompt })
        : slackApi("chat.postMessage", {
            channel,
            thread_ts: threadTs,
            text: "Tag me with a prompt and I'll run it, e.g. `@Joestar explain what a monad is`.",
          }),
    );

    return;
  }

  return send(res, 200);
}
