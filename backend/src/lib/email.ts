/**
 * Minimal email helper. Uses Resend when RESEND_API_KEY is configured;
 * otherwise no-ops and reports unsent so callers can surface the raw
 * invite link in dev/staging where SMTP isn't wired yet.
 */
import { Resend } from "resend";

const FROM = process.env.EMAIL_FROM ?? "Mike <onboarding@resend.dev>";

export function emailEnabled(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendEmail(opts: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ sent: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, error: "RESEND_API_KEY not configured" };
  try {
    const resend = new Resend(key);
    await resend.emails.send({
      from: FROM,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : "send failed" };
  }
}
