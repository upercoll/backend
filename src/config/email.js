const nodemailer = require("nodemailer");
const logger = require("../utils/logger");

let transporter;

function getTransporter() {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return transporter;
}

const FROM = process.env.SMTP_FROM || process.env.SMTP_USER;

async function sendInviteEmail({ to, inviteUrl, roleName, inviterName }) {
  try {
    await getTransporter().sendMail({
      from: FROM,
      to,
      subject: `You've been invited to join RBstars Admin Panel`,
      html: `
        <div style="font-family:Inter,sans-serif;background:#0f172a;color:#e2e8f0;padding:40px;border-radius:12px;max-width:560px;margin:0 auto">
          <div style="text-align:center;margin-bottom:32px">
            <h1 style="color:#60a5fa;font-size:28px;margin:0">RBstars</h1>
            <p style="color:#94a3b8;margin:4px 0 0">Admin Panel Invitation</p>
          </div>
          <h2 style="color:#f1f5f9;font-size:20px">You've been invited!</h2>
          <p style="color:#94a3b8;line-height:1.6">
            ${inviterName || "The site owner"} has invited you to join the RBstars admin panel as <strong style="color:#60a5fa">${roleName}</strong>.
          </p>
          <div style="text-align:center;margin:32px 0">
            <a href="${inviteUrl}" style="background:linear-gradient(135deg,#1e40af,#1d4ed8);color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
              Accept Invitation
            </a>
          </div>
          <p style="color:#64748b;font-size:13px;text-align:center">
            This invitation expires in 72 hours. If you didn't expect this, ignore this email.
          </p>
        </div>
      `,
    });
    logger.info(`Invite email sent to ${to}`);
  } catch (err) {
    logger.error("Failed to send invite email:", err.message);
    throw err;
  }
}

async function sendVerificationEmail({ to, code }) {
  try {
    await getTransporter().sendMail({
      from: FROM,
      to,
      subject: `RBstars Panel — Verification Code: ${code}`,
      html: `
        <div style="font-family:Inter,sans-serif;background:#0f172a;color:#e2e8f0;padding:40px;border-radius:12px;max-width:560px;margin:0 auto">
          <div style="text-align:center;margin-bottom:32px">
            <h1 style="color:#60a5fa;font-size:28px;margin:0">RBstars</h1>
          </div>
          <h2 style="color:#f1f5f9;font-size:20px;text-align:center">Identity Verification</h2>
          <p style="color:#94a3b8;text-align:center">Enter this code in the panel to verify your identity:</p>
          <div style="background:#1e293b;border:2px solid #334155;border-radius:12px;padding:24px;text-align:center;margin:24px 0">
            <span style="font-size:40px;font-weight:800;color:#60a5fa;letter-spacing:12px">${code}</span>
          </div>
          <p style="color:#64748b;font-size:13px;text-align:center">
            This code expires in 15 minutes. Never share this with anyone.
          </p>
        </div>
      `,
    });
    logger.info(`Verification code sent to ${to}`);
  } catch (err) {
    logger.error("Failed to send verification email:", err.message);
    throw err;
  }
}

async function sendPasswordEmail({ to, password, panelUrl }) {
  try {
    await getTransporter().sendMail({
      from: FROM,
      to,
      subject: `RBstars Panel — Your Temporary Password`,
      html: `
        <div style="font-family:Inter,sans-serif;background:#0f172a;color:#e2e8f0;padding:40px;border-radius:12px;max-width:560px;margin:0 auto">
          <div style="text-align:center;margin-bottom:32px">
            <h1 style="color:#60a5fa;font-size:28px;margin:0">RBstars</h1>
          </div>
          <h2 style="color:#f1f5f9;font-size:20px">Your temporary password</h2>
          <p style="color:#94a3b8">Use this to log in, then change your password from your profile settings.</p>
          <div style="background:#1e293b;border:2px solid #334155;border-radius:8px;padding:16px;margin:16px 0;font-family:monospace;font-size:18px;color:#60a5fa;text-align:center">
            ${password}
          </div>
          <div style="text-align:center;margin:24px 0">
            <a href="${panelUrl}" style="background:linear-gradient(135deg,#1e40af,#1d4ed8);color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
              Go to Panel
            </a>
          </div>
        </div>
      `,
    });
  } catch (err) {
    logger.error("Failed to send password email:", err.message);
  }
}

module.exports = { sendInviteEmail, sendVerificationEmail, sendPasswordEmail };
