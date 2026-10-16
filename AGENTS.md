# joestar-agent

<important if="you just added or changed a brand-new feature and want to confirm it works end-to-end">
Run the **Slack round-trip verification** — it exercises the full path (agent receives a
Slack event → processes it → replies), so a green result means the feature is live, not just
that the code compiled.

Steps (use the **claude.ai Slack MCP** tools, not the slackbot-message skill):

1. Post a message to **`#joestar-test`** (`C0BLB5BNS9W`) that tags the bot with a **real
   mention** — `<@U0BKB9RGYGZ>`, not the literal text `@joestar`. A plain `@joestar` string
   is not a functional mention and the bot will not react to it.
2. Wait a few seconds, then read the channel / the parent message's thread and confirm the
   **Joestar** bot (`U0BKB9RGYGZ`) replied. It answers **in a thread** off your message.
3. A reply within a few seconds = the round trip works. No reply = investigate.

Gotchas that have bitten this test before:

- The bot must already be a **member of the channel**; if it isn't, it never sees the message.
  (`slack_list_channel_members` with `include_bots:true` to check.)
- Real mention only — resolve the ID (`<@U0BKB9RGYGZ>`); literal `@joestar` text is ignored.
- The response lands as a **threaded reply**, so read the thread (`slack_read_thread` on your
  message's `ts`), not just the top-level channel feed.
</important>
