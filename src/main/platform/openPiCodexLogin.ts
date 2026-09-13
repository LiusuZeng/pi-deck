import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Shell-quote a value that is already selected by main-process configuration. */
export function shellQuoteForTerminal(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function piCodexLoginTerminalCommand(options: {
  piBinary: string;
  agentDir: string;
}): string {
  return [
    "printf '%s\\n' 'Pi Deck detected that Pi OpenAI Codex authentication needs attention.'",
    "printf '%s\\n' 'In Pi, run: /login openai-codex'",
    "printf '%s\\n' 'Finish the ChatGPT subscription login, then return to Pi Deck and choose Check again / Resume.'",
    `export PI_CODING_AGENT_DIR=${shellQuoteForTerminal(options.agentDir)}`,
    `exec ${shellQuoteForTerminal(options.piBinary)}`,
  ].join("; ");
}

export function piCodexLoginAppleScript(options: {
  piBinary: string;
  agentDir: string;
}): string {
  // JSON string escaping is also valid for this AppleScript string literal.
  return `tell application "Terminal"\nactivate\ndo script ${JSON.stringify(piCodexLoginTerminalCommand(options))}\nend tell`;
}

/** Opens Pi's own interactive login surface; this does not inspect credentials. */
export async function openPiCodexLoginTerminal(options: {
  piBinary: string;
  agentDir: string;
  run?: (file: string, args: string[]) => Promise<unknown>;
}): Promise<void> {
  const run = options.run ?? ((file, args) => execFileAsync(file, args));
  await run("/usr/bin/osascript", ["-e", piCodexLoginAppleScript(options)]);
}
