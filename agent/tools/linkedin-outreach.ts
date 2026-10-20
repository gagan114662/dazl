import { defineTool } from "eve/tools";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function hasCli(): Promise<boolean> {
  try { await exec("agent-browser", ["--version"], { timeout: 4000 }); return true; }
  catch { return false; }
}

type BrowserResult = { success: boolean; output?: string; error?: string };

async function browserRun(args: string[], timeoutMs = 90000): Promise<BrowserResult> {
  try {
    const { stdout, stderr } = await exec("agent-browser", args, { timeout: timeoutMs });
    return { success: true, output: stdout.slice(0, 800), error: stderr.slice(0, 200) || undefined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg.slice(0, 400) };
  }
}

export default defineTool({
  description:
    "Send a LinkedIn connection request with a personalised note using agent-browser CLI. Reuses the user's existing LinkedIn browser session (no new login required). Falls back gracefully if agent-browser is not installed. The first run may prompt the user to log into LinkedIn once.",
  inputSchema: z.object({
    profile_url: z.string().url().describe("LinkedIn profile URL e.g. https://linkedin.com/in/johndoe"),
    note: z.string().max(300).describe("Personalised connection note (max 300 chars)"),
    prospect_name: z.string().min(1).describe("Prospect name for logging"),
    action: z.enum(["connect", "message", "view"]).default("connect").describe("Action to take on the profile"),
  }),
  async execute({ profile_url, note, prospect_name, action }) {
    const installed = await hasCli();
    if (!installed) {
      return { sent: false, method: "not_installed",
        note: "agent-browser not found. Install: npm install -g @agent-browser/cli. Then re-run to reuse your existing LinkedIn session." };
    }

    if (action === "view") {
      const r = await browserRun(["open", profile_url, "--snapshot"]);
      return { sent: false, action: "view", profile_url, prospect_name, ...r };
    }

    if (action === "connect") {
      // agent-browser navigates to the profile, finds Connect button, adds note, sends
      const r = await browserRun([
        "linkedin", "connect",
        "--url", profile_url,
        "--note", note,
      ]);
      return { sent: r.success, action: "connect", method: "agent_browser", profile_url, prospect_name, ...r };
    }

    if (action === "message") {
      const r = await browserRun([
        "linkedin", "message",
        "--url", profile_url,
        "--message", note,
      ]);
      return { sent: r.success, action: "message", method: "agent_browser", profile_url, prospect_name, ...r };
    }

    return { sent: false, error: "Unknown action" };
  },
});
