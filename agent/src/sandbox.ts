/**
 * OS-level Bash containment (security research #2 — blocklist ≠ boundary).
 *
 * Three layers, outermost first:
 *  1. scrubbedSubprocessEnv(): the Claude Code subprocess that executes Bash
 *     never receives the Telegram token, database URL, or OpenAI key — only
 *     the Anthropic key it needs for its own LLM calls.
 *  2. envScrubbedBash(): every sandboxed command runs under `env -i` with a
 *     minimal allowlisted environment and HOME pointed at the workspace, so
 *     `env` / `printenv` / `process.env` dumps see nothing — including the
 *     Anthropic key that layer 1 has to leave in the subprocess env.
 *  3. sandboxSettings(): the SDK's OS sandbox (Seatbelt on macOS, bubblewrap
 *     on Linux) confines the filesystem — writes only inside the workspace,
 *     reads denied on key/credential paths. failIfUnavailable means a broken
 *     sandbox stops Bash entirely instead of silently running unconfined.
 *
 * The legacy SENSITIVE_PATH_RE blocklist in agent.ts stays as a cheap
 * pre-filter, but these layers are the actual boundary.
 */
import os from "node:os";
import path from "node:path";
import type { SandboxSettings } from "@anthropic-ai/claude-agent-sdk";

/** Secrets the Bash-executing subprocess must never inherit. The brain MCP
 *  child still gets DATABASE_URL/OPENAI_API_KEY via its own scoped env. */
const SECRET_ENV_VARS = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USER_ID",
  "DATABASE_URL",
  "DB_PASSWORD",
  "OPENAI_API_KEY",
  "APPROVAL_SIGNING_SECRET",
];

export function scrubbedSubprocessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of SECRET_ENV_VARS) delete env[key];
  return env;
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Wrap a command so it runs with an empty, allowlisted environment. HOME is
 *  the workspace: `~` stops resolving to the real home directory, so
 *  `~/.ssh/...` and friends point at paths that don't exist even before the
 *  OS sandbox denies them. */
export function envScrubbedBash(command: string, workspaceDir: string): string {
  const vars = [
    `HOME=${shellQuote(workspaceDir)}`,
    "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    "TMPDIR=/tmp",
    "LANG=en_US.UTF-8",
    "TERM=dumb",
  ].join(" ");
  return `/usr/bin/env -i ${vars} /bin/bash -c ${shellQuote(command)}`;
}

/** SDK sandbox config. `enabled` is off only in the locked-down-container
 *  deployment (BASH_AUTO_APPROVE), where the container is the boundary. */
export function sandboxSettings(workspaceDir: string, enabled: boolean): SandboxSettings {
  const home = os.homedir();
  const projectRoot = path.resolve(import.meta.dirname, "../..");
  return {
    enabled,
    // Missing deps / unsupported platform → hard error, never a silent
    // fallback to unsandboxed execution.
    failIfUnavailable: true,
    // Required so decidePermission can set dangerouslyDisableSandbox for the
    // host tools (term.sh / cc.sh / tmux). Every other command has the flag
    // forcibly stripped, so only the human-gated host path can use it.
    allowUnsandboxedCommands: true,
    filesystem: {
      allowWrite: [workspaceDir],
      denyRead: [
        path.join(home, ".ssh"),
        path.join(home, ".aws"),
        path.join(home, ".gnupg"),
        path.join(home, ".netrc"),
        path.join(home, ".claude"),
        path.join(home, ".claude.json"),
        path.join(home, ".config", "gh"),
        path.join(home, ".config", "gcloud"),
        path.join(home, ".docker"),
        path.join(projectRoot, ".env"),
      ],
    },
  };
}
