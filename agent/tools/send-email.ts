import { defineTool } from "eve/tools";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import nodemailer from "nodemailer";

const LOG_DIR  = join(process.env["HOME"] ?? "/tmp", "dazl-agent", "workspace");
const LOG_FILE = join(LOG_DIR, "outreach-log.jsonl");

function buildTransport() {
  // Option A: Gmail app password (recommended — 500 emails/day free)
  const gUser = process.env["GMAIL_USER"];
  const gPass = process.env["GMAIL_APP_PASSWORD"];
  if (gUser && gPass) {
    return nodemailer.createTransport({
      host: "smtp.gmail.com", port: 587, secure: false,
      auth: { user: gUser, pass: gPass },
    });
  }
  // Option B: Generic SMTP
  const host = process.env["SMTP_HOST"];
  const user = process.env["SMTP_USER"];
  const pass = process.env["SMTP_PASS"];
  if (host && user && pass) {
    return nodemailer.createTransport({
      host, port: parseInt(process.env["SMTP_PORT"] ?? "587", 10),
      secure: process.env["SMTP_SECURE"] === "true",
      auth: { user, pass },
    });
  }
  return null;
}

export default defineTool({
  description:
    "Send an outreach email via Gmail SMTP (GMAIL_USER + GMAIL_APP_PASSWORD, free 500/day) or generic SMTP (SMTP_HOST/USER/PASS). Logs every attempt to ~/dazl-agent/workspace/outreach-log.jsonl. Returns null with explanation if no provider configured.",
  inputSchema: z.object({
    to: z.string().email().describe("Recipient email address"),
    subject: z.string().min(1).describe("Email subject line"),
    html: z.string().min(1).describe("Email body HTML"),
    lead_id: z.string().optional().describe("Lead ID for tracking"),
    sequence_day: z.number().int().min(1).optional().describe("Sequence day: 1, 3, 7, or 14"),
  }),
  async execute({ to, subject, html, lead_id, sequence_day }) {
    const id = randomUUID();
    const transport = buildTransport();
    let sent = false;
    let method = "none";
    let error: string | null = null;

    if (!transport) {
      error = "No email provider configured. Set GMAIL_USER + GMAIL_APP_PASSWORD (Gmail app password) or SMTP_HOST + SMTP_USER + SMTP_PASS.";
    } else {
      const from = process.env["GMAIL_USER"] ?? process.env["SMTP_USER"] ?? "outreach@dazl.ai";
      method = process.env["GMAIL_USER"] ? "gmail_smtp" : "smtp";
      try {
        await transport.sendMail({ from, to, subject, html });
        sent = true;
      } catch (e) {
        error = e instanceof Error ? e.message.slice(0, 300) : String(e);
      }
    }

    const record = { id, to, subject, lead_id, sequence_day, method, sent, error, sent_at: new Date().toISOString() };
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_FILE, JSON.stringify(record) + "\n", "utf8");
    return record;
  },
});
