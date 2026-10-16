import { Template } from "e2b";

/**
 * The sandbox image Joestar runs prompts in.
 *
 * E2B has no public "claude-code" template — this definition is the template,
 * and `npm run template:build` is what publishes it to your E2B team under the
 * name below. Until that build runs, `Sandbox.create(TEMPLATE_NAME)` 404s.
 */
export const TEMPLATE_NAME = "claude-code";

export const template = Template()
  .fromNodeImage("24")
  // git + ripgrep aren't strictly required, but Claude Code reaches for them
  // constantly and the failure mode without them is a confusing tool error.
  .aptInstall(["curl", "git", "ripgrep"])
  // The GitHub CLI isn't in the base image's default apt sources, so
  // `aptInstall(["gh"])` may not resolve. This adds GitHub's own apt repo, as
  // root, then installs from it. Rebuild the template (`npm run template:build`)
  // for any of this to take effect — a stale template of the same name silently
  // shadows the new one.
  .runCmd(
    [
      "mkdir -p -m 755 /etc/apt/keyrings",
      "curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg",
      "chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg",
      'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list',
      "apt-get update",
      "apt-get install -y gh",
    ],
    { user: "root" },
  )
  // Installed globally so the sandbox exposes it simply as `claude`.
  .npmInstall("@anthropic-ai/claude-code@latest", { g: true });
