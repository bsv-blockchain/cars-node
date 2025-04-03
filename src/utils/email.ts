import sgMail from '@sendgrid/mail';

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const SYSTEM_FROM_EMAIL = process.env.SYSTEM_FROM_EMAIL;

// Additional helper interfaces
interface Project {
    project_uuid: string;
    name: string;
}

export async function sendEmailToAdmins(emails: string[], project: Project, body: string, subject: string) {
    if (!SENDGRID_API_KEY) {
        throw new Error('SENDGRID_API_KEY not set in environment variables');
    }
    if (!SYSTEM_FROM_EMAIL) {
        throw new Error('FROM_EMAIL is not set in environment variables');
    }

    sgMail.setApiKey(SENDGRID_API_KEY);

    const msg = {
        to: emails,
        from: SYSTEM_FROM_EMAIL,
        subject,
        text: body
    };

    await sgMail.send(msg, false);
}

/**
 * Send a billing alert email at a certain threshold crossing.
 * @param emails
 * @param project
 * @param newBalance
 * @param threshold
 */
export async function sendThresholdEmail(emails: string[], project: Project, newBalance: number, threshold: number) {
    const subject = `Billing Alert for Project: ${project.name}`;
    let level = 'Notice';
    if (newBalance < 10000000) level = 'Urgent';

    const body = `Hello,

Your project "${project.name}" (ID: ${project.project_uuid}) has a balance of ${newBalance} satoshis, crossing below the threshold of ${threshold} satoshis.

The level of this billing alret is: ${level}.

Please consider adding funds to prevent service interruptions. Once balance falls below zero, your ingress may be disabled until payment is made.

Thank you,
CARS System`;

    await sendEmailToAdmins(emails, project, body, subject);
}

/**
 * Send a generic admin notification email (e.g. admin added/removed, domain changed)
 */
export async function sendAdminNotificationEmail(emails: string[], project: Project, body: string, subject: string) {
    await sendEmailToAdmins(emails, project, body, subject);
}

/**
 * Send a welcome email to a newly added admin
 */
export async function sendWelcomeEmail(newAdminEmail: string, project: Project, body: string, subject: string) {
    await sendEmailToAdmins([newAdminEmail], project, body, subject);
}

/**
 * Send deployment failure email
 */
export async function sendDeploymentFailureEmail(emails: string[], project: Project, body: string, subject: string) {
    await sendEmailToAdmins(emails, project, body, subject);
}

/**
 * Send domain change notification
 */
export async function sendDomainChangeEmail(emails: string[], project: Project, body: string, subject: string) {
    await sendEmailToAdmins(emails, project, body, subject);
}
