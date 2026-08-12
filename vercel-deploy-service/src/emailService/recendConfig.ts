import { Resend } from 'resend';
import dotenv from 'dotenv';

dotenv.config();

// Lazy-init: don't crash the entire service if RESEND_API_KEY is missing
let resend: Resend | null = null;

function getResendClient(): Resend | null {
  if (resend) return resend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[Email] RESEND_API_KEY not set — email notifications disabled.');
    return null;
  }
  resend = new Resend(apiKey);
  return resend;
}

export async function sendDeploySuccessEmail(
  toEmail: string,
  deploymentId: string,
  deployedUrl: string
) {
  const client = getResendClient();
  if (!client) return;

  try {
    const { data, error } = await client.emails.send({
      from: 'SnapDeploy <onboarding@resend.dev>',
      to: [toEmail],
      subject: `Build Successful — ${deploymentId}`,
      html: `
        <div>
          <p>
            Your project <strong>${deploymentId}</strong>
            has been deployed successfully.
          </p>
          <p>Your live URL:</p>
          <a href="${deployedUrl}">${deployedUrl}</a>
        </div>
      `,
    });

    if (error) {
      console.error(
        `[${deploymentId}] Failed to send success email:`,
        error
      );
    } else {
      console.log(
        `[${deploymentId}] Success email sent to ${toEmail} (ID: ${data?.id})`
      );
    }
  } catch (err) {
    console.error(`[${deploymentId}] Email service error:`, err);
  }
}

export async function sendDeployFailureEmail(
  toEmail: string,
  deploymentId: string
) {
  const client = getResendClient();
  if (!client) return;

  try {
    const { data, error } = await client.emails.send({
      from: 'SnapDeploy <onboarding@resend.dev>',
      to: [toEmail],
      subject: `Build Failed — ${deploymentId}`,
      html: `
        <div>
          <p>
            Your project <strong>${deploymentId}</strong>
            failed to deploy.
          </p>
          <p>Please try deploying again.</p>
        </div>
      `,
    });

    if (error) {
      console.error(
        `[${deploymentId}] Failed to send failure email:`,
        error
      );
    } else {
      console.log(
        `[${deploymentId}] Failure email sent to ${toEmail} (ID: ${data?.id})`
      );
    }
  } catch (err) {
    console.error(`[${deploymentId}] Email service error:`, err);
  }
}