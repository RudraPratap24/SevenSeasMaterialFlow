/**
 * Email for the Purchase System (indent notice, PO approval notice, PO to vendor, daily digest) — SMTP from .env:
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE (true for 465), SMTP_USER, SMTP_PASS, SMTP_FROM (e.g. purchase@…)
 * Not set up → every send throws "Email is not set up …" (the indent is still saved; its Email Status = Email Failed).
 */
import nodemailer, { type Transporter } from "nodemailer";

let transport: Transporter | null = null;

export function mailReady(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

export async function sendMail(m: {
  to: string;
  cc?: string;
  subject: string;
  html?: string;
  text?: string;
  replyTo?: string;
  fromName?: string;
  attachments?: { filename: string; content: Buffer }[];
}): Promise<void> {
  if (!mailReady()) throw new Error("Email is not set up on the server (SMTP settings in .env).");
  transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || "" } : undefined,
  });
  await transport.sendMail({
    from: m.fromName ? { name: m.fromName, address: process.env.SMTP_FROM! } : process.env.SMTP_FROM,
    to: m.to,
    cc: m.cc || undefined,
    subject: m.subject,
    html: m.html,
    text: m.text,
    replyTo: m.replyTo,
    attachments: m.attachments,
  });
}
