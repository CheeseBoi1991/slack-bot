/**
 * Markdown → Slack mrkdwn.
 *
 * Claude emits GitHub-flavoured Markdown no matter how firmly the prompt asks
 * for Slack formatting, so we convert in code instead of trusting the model.
 * Slack's mrkdwn is a different dialect: single `*` is bold (not `**`), links
 * are `<url|text>`, there are no `#` headings, and bullets want a real `•`.
 *
 * Code is sacred: fenced blocks and inline spans are pulled out first and
 * restored last, so a `**` or `[x](y)` *inside* code survives untouched.
 */

// A private-use codepoint pair fences each stashed span. It never appears in
// real prose and none of the conversions below match it, so the placeholder is
// inert — unlike a space-delimited number, which would collide with " 3 " text.
const OPEN = "\uE000";
const CLOSE = "\uE001";

export function toMrkdwn(md = "") {
  if (!md) return "";

  const stash = [];
  const keep = (match) => {
    stash.push(match);
    return `${OPEN}${stash.length - 1}${CLOSE}`;
  };

  let text = md
    // Fenced code blocks first (they can contain inline-code backticks).
    .replace(/```[\s\S]*?```/g, keep)
    // Then inline code spans.
    .replace(/`[^`\n]+`/g, keep);

  text = text
    // Links: [label](url) → <url|label>. Before bold, so a bold label is
    // converted inside the resulting mrkdwn link.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "<$2|$1>")
    // Headings: leading #'s on a line → that line, bold, on its own.
    .replace(/^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/gm, "*$1*")
    // Bold: **text** or __text__ → *text*.
    .replace(/\*\*([^\n]+?)\*\*/g, "*$1*")
    .replace(/__([^\n]+?)__/g, "*$1*")
    // Bullets: -, * or + at the start of a line → • (keep the indent).
    .replace(/^(\s*)[-*+]\s+/gm, "$1• ");

  // Restore code exactly as it came in.
  return text.replace(
    new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g"),
    (_, i) => stash[Number(i)],
  );
}
