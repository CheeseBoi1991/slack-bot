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
  // Installed globally so the sandbox exposes it simply as `claude`.
  .npmInstall("@anthropic-ai/claude-code@latest", { g: true });
