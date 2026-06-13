/**
 * Bash permission policy regexes, extracted into their own module so they can
 * be imported by unit tests without triggering the SDK / DB side-effects in
 * agent.ts.
 */

/** Read-only commands with no shell metacharacters: auto-allowed.
 *  tmux list-panes is included (pane inventory is harmless); peek/send are
 *  not — terminal contents can show secrets and send-keys types on the owner's
 *  keyboard, so both stay behind approval.
 *
 *  Security: the negated character classes exclude control characters
 *  (\n \r \t and the full \x00–\x1f range) in addition to shell metacharacters,
 *  so a newline-injected second command can never sneak through as "safe". */
export const SAFE_BASH_RE =
  /^(ls|pwd|cat|head|tail|wc|grep|rg|date|whoami|which|file|stat|du|df|tree|node --version|npm --version|tmux list-(panes|sessions|windows)\b[^|;&><`$\\\n\r\t\x00-\x1f]*|\S*\/term\.sh list)$|^(ls|pwd|cat|head|tail|wc|grep|rg|date|whoami|which|file|stat|du|df|tree)\b[^|;&><`$\\\n\r\t\x00-\x1f]*$/;

/** Commands that can move data off the machine. Automode never auto-approves
 *  these — exfiltration keeps a one-tap human confirm even when everything
 *  else is auto (sandbox blocks secret reads, but workspace contents are
 *  fair game to a poisoned instruction).
 *
 *  Covers: classic network tools, language-level network invocations
 *  (python/python3 -c/-m, node -e), DNS lookup tools (dig, nslookup, host),
 *  and raw socket tools (socat). */
export const NETWORK_BASH_RE =
  /\b(curl|wget|nc|ncat|netcat|telnet|ssh|scp|sftp|rsync|ftp)\b|\bgit\s+(push|pull|fetch|clone)\b|\bnpm\s+(publish|install|ci|i)\b|\bpip3?\s+install\b|\bbrew\s+(install|upgrade)\b|\bopenssl\s+s_client\b|\bpython3?\s+(-c|-m)\b|\bnode\s+-e\b|\b(dig|nslookup|host|socat)\b/i;
