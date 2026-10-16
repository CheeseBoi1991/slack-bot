// A single PreToolUse hook for the sandboxed Claude Code: refuse destructive
// `git push` forms. It is a NUDGE, not a boundary.
//
// Why this one guard and no other: the branch ruleset protects the default
// branch only, so a token with `contents: write` can still force-push over, or
// delete, any OTHER branch. That is the one destructive capability GitHub
// permits and nobody wants. Everything else is either already refused by GitHub
// (a protected default branch, `.github/workflows/`) or cannot be enforced by
// matching strings — `X=$GH_TOKEN` alone defeats every exfiltration pattern
// you could write. There is deliberately no general denylist: the sandbox is a
// throwaway container, `rm -rf` in it costs nothing, and a list that catches
// the obvious cases while missing the others reads as protection it isn't.
//
// What it does NOT stop: it parses the command text, so an alias, a shell
// function, indirection (`G=push; git $G --force`), `sh -c "git push -f"`, a
// `gh api` call that deletes a ref, or invoking `git-receive-pack` directly all
// walk straight past it. It prevents an agent's bad decision, not an
// attacker's. Anyone who can @mention the bot can run arbitrary code in the
// sandbox with the token, and the only thing that holds against that is what
// GitHub itself refuses.
//
// The hook source lives in this module as a string, not a file read at
// runtime, so Vercel's bundler can't leave it behind. It is written to the
// sandbox each turn alongside a settings file that contains ONLY the `hooks`
// key — a baked-in `apiKeyHelper` in that same file once overrode
// CLAUDE_CODE_OAUTH_TOKEN, so nothing else goes in it.
//
// Mechanism: exit code 2 blocks the tool call and feeds stderr back to the
// model. (An exit-0-plus-JSON form also exists; JSON is ignored on exit 2, so
// we use exactly one.) There is no `jq` in the image, but there is Node.

// Under /tmp/joestar, not /tmp itself: see RUN_DIR in claude-sandbox.js for why
// the file API cannot rewrite files directly in /tmp on a resumed sandbox.
export const GIT_GUARD_PATH = "/tmp/joestar/git-guard.js";
export const GIT_GUARD_SETTINGS_PATH = "/tmp/joestar/claude-hooks-settings.json";

export const GIT_GUARD_SETTINGS = JSON.stringify(
  {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: `node ${GIT_GUARD_PATH}` }],
        },
      ],
    },
  },
  null,
  2,
);

// String.raw keeps the regex backslashes literal. The script itself must not
// contain a backtick or a ${ — they would end this template literal.
export const GIT_GUARD_SOURCE = String.raw`
const MESSAGE =
  "Force-push and branch deletion are disabled. Push a new branch and open a PR instead.";

// Splits a shell command into segments (at ; & | ( ) { } newline and backtick)
// of tokens, honouring quotes so that a commit message that merely MENTIONS
// "git push --force" is one quoted token and not a push.
function segments(command) {
  const BACKTICK = String.fromCharCode(96);
  const out = [];
  let tokens = [];
  let cur = "";
  let has = false;
  let quote = null;

  const endToken = () => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  const endSegment = () => {
    endToken();
    if (tokens.length) out.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      cur += command[++i];
      has = true;
    } else if (ch === "\n") {
      endSegment();
    } else if (/\s/.test(ch)) {
      endToken();
    } else if (";&|(){}".includes(ch) || ch === BACKTICK) {
      endSegment();
    } else {
      cur += ch;
      has = true;
    }
  }
  endSegment();
  return out;
}

const WRAPPERS = new Set(["command", "exec", "sudo", "env", "time", "nohup", "builtin"]);
const OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const DESTRUCTIVE_LONG = new Set([
  "--force",
  "--force-with-lease",
  "--delete",
  "--mirror",
  "--prune",
]);

// The arguments after "push" in this segment, or null if it isn't a git push.
function pushArgs(tokens) {
  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || WRAPPERS.has(tokens[i]))) i++;
  if (i >= tokens.length || tokens[i].split("/").pop() !== "git") return null;
  i++;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    i += OPTIONS_WITH_VALUE.has(tokens[i]) ? 2 : 1;
  }
  return tokens[i] === "push" ? tokens.slice(i + 1) : null;
}

function isDestructive(args) {
  for (const arg of args) {
    if (arg.startsWith("--")) {
      if (DESTRUCTIVE_LONG.has(arg.split("=")[0])) return true;
    } else if (/^-[fnuvqd46]+$/.test(arg)) {
      if (/[fd]/.test(arg)) return true; // -f, -d, or a cluster like -fu
    } else if (arg.startsWith("+")) {
      return true; // +src:dst forces just that ref
    } else if (/^:./.test(arg)) {
      return true; // :branch deletes the remote branch
    }
  }
  return false;
}

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0); // not ours to block on a payload we can't read
  }

  const command = input && input.tool_input && input.tool_input.command;
  if (input.tool_name !== "Bash" || typeof command !== "string") process.exit(0);

  for (const tokens of segments(command)) {
    const args = pushArgs(tokens);
    if (args && isDestructive(args)) {
      process.stderr.write(MESSAGE + "\n");
      process.exit(2);
    }
  }
  process.exit(0);
});
`;
