import sgMail from '@sendgrid/mail';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SYSTEM_FROM_EMAIL = process.env.SYSTEM_FROM_EMAIL;

// If you ever change this, keep it in one place.
const PLACEHOLDER_EMAIL = 'placeholder@domain.com';

// Simple, pragmatic email validator.
// We don't need to be perfect here—just catch obvious garbage so we don't trip SendGrid.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;

interface Project {
  project_uuid: string;
  name: string;
}

/**
 * Normalize, filter, and de-duplicate a list of email addresses.
 * - trims and lowercases
 * - removes empty/invalid
 * - removes our placeholder address
 * - de-dupes
 */
function sanitizeEmails(emails: string[] = []): string[] {
  const seen = new Set<string>();
  for (const raw of emails) {
    const e = (raw || '').trim().toLowerCase();

    if (!e) continue;
    if (e === PLACEHOLDER_EMAIL) continue;
    if (!EMAIL_RE.test(e)) continue;

    if (!seen.has(e)) seen.add(e);
  }
  return Array.from(seen);
}

/**
 * Initializes SendGrid if possible. Returns false if not configured.
 * We log and keep going instead of throwing to avoid crashing the server.
 */
function ensureSendGridConfigured(): boolean {
  if (!SENDGRID_API_KEY) {
    console.error('[email] SENDGRID_API_KEY not set in environment variables');
    return false;
  }
  if (!SYSTEM_FROM_EMAIL) {
    console.error('[email] SYSTEM_FROM_EMAIL not set in environment variables');
    return false;
  }
  try {
    sgMail.setApiKey(SENDGRID_API_KEY);
  } catch (err) {
    console.error('[email] Failed to set SendGrid API key:', err);
    return false;
  }
  return true;
}

/**
 * Core send helper that:
 * - sanitizes recipients
 * - no-ops if none left
 * - never throws (logs instead)
 */
async function sendSafe(toList: string[], subject: string, body: string): Promise<void> {
  const to = sanitizeEmails(toList);

  if (to.length === 0) {
    // Nothing to send to; fail quietly per requirements.
    console.info('[email] No valid recipients after filtering; skipping send.');
    return;
  }

  if (!ensureSendGridConfigured()) {
    // Misconfiguration: log and return without throwing.
    return;
  }

  const msg = {
    to,
    from: SYSTEM_FROM_EMAIL as string,
    subject,
    text: body,
  };

  try {
    // Use the standard send API. We already de-duped the "to" list, so we won't trip personalization errors.
    await sgMail.send(msg, false);
  } catch (err: any) {
    // Never crash the server—log enough context to debug.
    const code = err?.code;
    const resp = err?.response;
    console.error('[email] SendGrid send failed', {
      code,
      errors: resp?.body?.errors,
      headers: resp?.headers,
    });
    // Swallow the error to keep the app resilient.
  }
}

export async function sendEmailToAdmins(
  emails: string[],
  _project: Project, // kept for API parity; not used directly here
  body: string,
  subject: string
): Promise<void> {
  await sendSafe(emails, subject, body);
}

/**
 * Send a billing alert email at a certain threshold crossing.
 */
export async function sendThresholdEmail(
  emails: string[],
  project: Project,
  newBalance: number,
  threshold: number
): Promise<void> {
  const subject = `Billing Alert for Project: ${project.name}`;
  let level: 'Notice' | 'Urgent' = 'Notice';
  if (newBalance < 10_000_000) level = 'Urgent';

  const body = `Hello,

Your project "${project.name}" (ID: ${project.project_uuid}) has a balance of ${newBalance} satoshis, crossing below the threshold of ${threshold} satoshis.

The level of this billing alert is: ${level}.

Please consider adding funds to prevent service interruptions. Once balance falls below zero, your ingress may be disabled until payment is made.

Thank you,
CARS System`;

  await sendSafe(emails, subject, body);
}

/**
 * Send a generic admin notification email (e.g. admin added/removed, domain changed)
 */
export async function sendAdminNotificationEmail(
  emails: string[],
  _project: Project,
  body: string,
  subject: string
): Promise<void> {
  await sendSafe(emails, subject, body);
}

/**
 * Send a welcome email to a newly added admin
 */
export async function sendWelcomeEmail(
  newAdminEmail: string,
  _project: Project,
  body: string,
  subject: string
): Promise<void> {
  await sendSafe([newAdminEmail], subject, body);
}

/**
 * Send deployment failure email
 */
export async function sendDeploymentFailureEmail(
  emails: string[],
  _project: Project,
  body: string,
  subject: string
): Promise<void> {
  await sendSafe(emails, subject, body);
}

/**
 * Send domain change notification
 */
export async function sendDomainChangeEmail(
  emails: string[],
  _project: Project,
  body: string,
  subject: string
): Promise<void> {
  await sendSafe(emails, subject, body);
}
