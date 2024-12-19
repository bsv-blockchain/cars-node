import sgMail from '@sendgrid/mail';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SYSTEM_FROM_EMAIL = process.env.SYSTEM_FROM_EMAIL;

interface Project {
    project_uuid: string;
    name: string;
}

/**
 * Send a billing alert email to project admins.
 * @param emails Array of admin emails
 * @param project Project info
 * @param newBalance Current project balance in satoshis
 */
export async function sendEmailToAdmins(emails: string[], project: Project, newBalance: number) {
    if (!SENDGRID_API_KEY) {
        throw new Error('SENDGRID_API_KEY not set in environment variables');
    }
    if (!SYSTEM_FROM_EMAIL) {
        throw new Error('FROM_EMAIL is not set in environment variables')
    }

    sgMail.setApiKey(SENDGRID_API_KEY);

    const subject = `Billing Alert for Project: ${project.name}`;
    const body = `Hello,

Your project "${project.name}" (ID: ${project.project_uuid}) now has a balance of ${newBalance} satoshis, which is below our recommended threshold.

Please consider adding funds with CARS CLI to prevent service interruptions.

Thank you,
CARS System`;

    const msg = {
        to: emails, // can be multiple recipients
        from: SYSTEM_FROM_EMAIL,
        subject: subject,
        text: body
    };

    await sgMail.send(msg, false);
}
