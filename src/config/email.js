const { Resend } = require("resend");
const logger = require("../utils/logger");

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

const FROM = process.env.RESEND_FROM || "RBstars <noreply@rbstars.gg>";

async function sendInviteEmail({ to, inviteUrl, roleName, inviterName }) {
  try {
    const resend = getResend();
    await resend.emails.send({
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
    const resend = getResend();
    await resend.emails.send({
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
    const resend = getResend();
    await resend.emails.send({
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

async function sendOrderConfirmationEmail({ to, orderNumber, items, total, robloxUsername, claimUrl }) {
  if (!process.env.RESEND_API_KEY) {
    logger.warn("RESEND_API_KEY not set — skipping order confirmation email");
    return;
  }
  try {
    const resend = getResend();
    const itemRows = (items || []).map(item => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #1e293b;color:#e2e8f0;font-size:14px">${item.name}</td>
        <td style="padding:10px 0;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:14px;text-align:center">x${item.quantity}</td>
        <td style="padding:10px 0;border-bottom:1px solid #1e293b;color:#60a5fa;font-size:14px;text-align:right">$${(item.unitPrice * item.quantity).toFixed(2)}</td>
      </tr>
    `).join("");

    await resend.emails.send({
      from: FROM,
      to,
      subject: `Order Confirmed — ${orderNumber} | RBstars`,
      html: `
        <div style="font-family:Inter,sans-serif;background:#0f172a;color:#e2e8f0;padding:40px;border-radius:12px;max-width:580px;margin:0 auto">
          <div style="text-align:center;margin-bottom:28px">
            <h1 style="color:#60a5fa;font-size:30px;margin:0 0 4px">RBstars</h1>
            <p style="color:#64748b;margin:0;font-size:13px">Order Confirmation</p>
          </div>

          <div style="background:#16a34a22;border:1.5px solid #16a34a55;border-radius:12px;padding:20px;text-align:center;margin-bottom:28px">
            <div style="width:48px;height:48px;background:linear-gradient(135deg,#16a34a,#15803d);border-radius:50%;display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px">
              <span style="color:white;font-size:22px;font-weight:900">✓</span>
            </div>
            <h2 style="color:#4ade80;font-size:20px;margin:0 0 4px">Payment Successful!</h2>
            <p style="color:#86efac;margin:0;font-size:13px">Your order has been confirmed</p>
          </div>

          <div style="background:#1e293b;border-radius:10px;padding:16px;margin-bottom:20px">
            <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Order Reference</p>
            <p style="margin:0;font-size:18px;font-weight:800;color:#60a5fa">${orderNumber}</p>
          </div>

          <div style="background:#1e293b;border-radius:10px;padding:16px;margin-bottom:20px">
            <p style="margin:0 0 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Items Ordered</p>
            <table style="width:100%;border-collapse:collapse">
              <thead>
                <tr>
                  <th style="text-align:left;font-size:11px;color:#64748b;font-weight:600;padding-bottom:8px">Item</th>
                  <th style="text-align:center;font-size:11px;color:#64748b;font-weight:600;padding-bottom:8px">Qty</th>
                  <th style="text-align:right;font-size:11px;color:#64748b;font-weight:600;padding-bottom:8px">Price</th>
                </tr>
              </thead>
              <tbody>${itemRows}</tbody>
              <tfoot>
                <tr>
                  <td colspan="2" style="padding-top:12px;font-weight:700;color:#e2e8f0;font-size:15px">Total</td>
                  <td style="padding-top:12px;font-weight:800;color:#4ade80;font-size:15px;text-align:right">$${Number(total).toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div style="background:linear-gradient(135deg,#1e293b,#0f172a);border:1.5px solid #334155;border-radius:10px;padding:20px;margin-bottom:24px">
            <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#e2e8f0">📦 Ready to receive your items?</p>
            <p style="margin:0 0 16px;font-size:13px;color:#94a3b8;line-height:1.6">
              Visit the site and click the <strong style="color:#a5b4fc">chat icon</strong> in the bottom corner to open your Claim Chat. Make sure your Roblox username (<strong style="color:#e2e8f0">${robloxUsername}</strong>) is correct and your account allows friend requests.
            </p>
            <div style="text-align:center">
              <a href="${claimUrl}" style="background:linear-gradient(135deg,#4f46e5,#3730a3);color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block">
                Claim Your Items →
              </a>
            </div>
          </div>

          <p style="color:#475569;font-size:12px;text-align:center;margin:0">
            Questions? Open a Claim Chat on the site or reply to this email.<br/>
            Thank you for shopping with RBstars!
          </p>
        </div>
      `,
    });
    logger.info(`Order confirmation email sent to ${to} for order ${orderNumber}`);
  } catch (err) {
    logger.error("Failed to send order confirmation email:", err.message);
  }
}

async function sendAgentReplyNotificationEmail({ to, orderRef, agentName, agentPicture, agentBio, roomId, frontendUrl }) {
  if (!process.env.RESEND_API_KEY) {
    logger.warn("RESEND_API_KEY not set — skipping agent reply email");
    return;
  }
  try {
    const resend = getResend();
    const siteUrl = frontendUrl || "https://rbstars.gg";
    const avatarHtml = agentPicture
      ? `<img src="${agentPicture}" alt="${agentName}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid #4f46e5" />`
      : `<div style="width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#4f46e5,#3730a3);display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:800;color:white">${(agentName || "A")[0].toUpperCase()}</div>`;

    await resend.emails.send({
      from: FROM,
      to,
      subject: `Your claim agent has responded — RBstars`,
      html: `
        <div style="font-family:Inter,sans-serif;background:#0f172a;color:#e2e8f0;padding:40px;border-radius:12px;max-width:560px;margin:0 auto">
          <div style="text-align:center;margin-bottom:28px">
            <h1 style="color:#60a5fa;font-size:30px;margin:0 0 4px">RBstars</h1>
            <p style="color:#64748b;margin:0;font-size:13px">Claim Update</p>
          </div>

          <div style="background:#1e293b;border:1.5px solid #334155;border-radius:12px;padding:24px;margin-bottom:24px">
            <p style="margin:0 0 16px;font-size:13px;color:#94a3b8">Your claim agent has joined your chat${orderRef ? ` for order <strong style="color:#a5b4fc">${orderRef}</strong>` : ""}:</p>
            <div style="display:flex;align-items:center;gap:16px">
              <div style="flex-shrink:0;text-align:center">${avatarHtml}</div>
              <div>
                <p style="margin:0 0 4px;font-size:16px;font-weight:800;color:#e2e8f0">${agentName || "Support Agent"}</p>
                <p style="margin:0;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#4f46e5;font-weight:700">Claim Agent</p>
                ${agentBio ? `<p style="margin:6px 0 0;font-size:13px;color:#94a3b8;line-height:1.5">${agentBio}</p>` : ""}
              </div>
            </div>
          </div>

          <div style="text-align:center;margin-bottom:24px">
            <p style="color:#94a3b8;font-size:13px;margin:0 0 16px">Head back to the site and open your Claim Chat to continue the conversation:</p>
            <a href="${siteUrl}" style="background:linear-gradient(135deg,#dc2626,#9f1239);color:#fff;padding:13px 30px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block">
              Open Claim Chat →
            </a>
          </div>

          <p style="color:#475569;font-size:12px;text-align:center;margin:0">
            Make sure your Roblox account is ready and allows friend requests.<br/>
            Thank you for shopping with RBstars!
          </p>
        </div>
      `,
    });
    logger.info(`Agent reply notification sent to ${to} (agent: ${agentName})`);
  } catch (err) {
    logger.error("Failed to send agent reply notification email:", err.message);
  }
}

async function sendRefundEmail({ to, orderNumber, amount, reason, items, robloxUsername }) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const resend = getResend();
    const itemRows = (items || []).map(item => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #1e293b;color:#e2e8f0;font-size:13px">${item.name}</td>
        <td style="padding:8px 0;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px;text-align:center">x${item.quantity}</td>
      </tr>
    `).join("");
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Refund Processed — ${orderNumber} | RBstars`,
      html: `
        <div style="font-family:Inter,sans-serif;background:#0f172a;color:#e2e8f0;padding:40px;border-radius:12px;max-width:560px;margin:0 auto">
          <div style="text-align:center;margin-bottom:28px">
            <h1 style="color:#60a5fa;font-size:28px;margin:0 0 4px">RBstars</h1>
            <p style="color:#64748b;margin:0;font-size:13px">Refund Confirmation</p>
          </div>
          <div style="background:#7f1d1d22;border:1.5px solid #7f1d1d55;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
            <h2 style="color:#fca5a5;font-size:18px;margin:0 0 4px">Refund Processed</h2>
            <p style="color:#fecaca;margin:0;font-size:13px">Your refund of <strong>$${Number(amount).toFixed(2)}</strong> has been issued</p>
          </div>
          <div style="background:#1e293b;border-radius:10px;padding:16px;margin-bottom:16px">
            <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Order Reference</p>
            <p style="margin:0;font-size:16px;font-weight:800;color:#60a5fa">${orderNumber}</p>
          </div>
          ${reason ? `<div style="background:#1e293b;border-radius:10px;padding:16px;margin-bottom:16px"><p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Reason</p><p style="margin:0;font-size:14px;color:#e2e8f0">${reason}</p></div>` : ""}
          ${itemRows ? `<div style="background:#1e293b;border-radius:10px;padding:16px;margin-bottom:16px"><p style="margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Items</p><table style="width:100%;border-collapse:collapse"><tbody>${itemRows}</tbody></table></div>` : ""}
          <p style="color:#64748b;font-size:12px;text-align:center;margin:0">Refunds typically appear within 5–10 business days depending on your bank.<br/>Thank you for shopping with RBstars.</p>
        </div>
      `,
    });
    logger.info(`Refund email sent to ${to} for order ${orderNumber}`);
  } catch (err) {
    logger.error("Failed to send refund email:", err.message);
  }
}

async function sendCancellationEmail({ to, orderNumber, amount, items, robloxUsername }) {
  if (!process.env.RESEND_API_KEY) return;
  try {
    const resend = getResend();
    const itemRows = (items || []).map(item => `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #1e293b;color:#e2e8f0;font-size:13px">${item.name}</td>
        <td style="padding:8px 0;border-bottom:1px solid #1e293b;color:#94a3b8;font-size:13px;text-align:center">x${item.quantity}</td>
      </tr>
    `).join("");
    await resend.emails.send({
      from: FROM,
      to,
      subject: `Order Cancelled — ${orderNumber} | RBstars`,
      html: `
        <div style="font-family:Inter,sans-serif;background:#0f172a;color:#e2e8f0;padding:40px;border-radius:12px;max-width:560px;margin:0 auto">
          <div style="text-align:center;margin-bottom:28px">
            <h1 style="color:#60a5fa;font-size:28px;margin:0 0 4px">RBstars</h1>
            <p style="color:#64748b;margin:0;font-size:13px">Order Cancellation</p>
          </div>
          <div style="background:#7f1d1d22;border:1.5px solid #7f1d1d55;border-radius:12px;padding:20px;text-align:center;margin-bottom:24px">
            <h2 style="color:#fca5a5;font-size:18px;margin:0 0 4px">Order Cancelled</h2>
            <p style="color:#fecaca;margin:0;font-size:13px">Your order has been cancelled${amount ? ` and a refund of <strong>$${Number(amount).toFixed(2)}</strong> has been issued` : ""}</p>
          </div>
          <div style="background:#1e293b;border-radius:10px;padding:16px;margin-bottom:16px">
            <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Order Reference</p>
            <p style="margin:0;font-size:16px;font-weight:800;color:#60a5fa">${orderNumber}</p>
          </div>
          ${itemRows ? `<div style="background:#1e293b;border-radius:10px;padding:16px;margin-bottom:16px"><p style="margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:0.1em;color:#64748b">Cancelled Items</p><table style="width:100%;border-collapse:collapse"><tbody>${itemRows}</tbody></table></div>` : ""}
          <p style="color:#64748b;font-size:12px;text-align:center;margin:0">${amount ? "Refunds typically appear within 5–10 business days.<br/>" : ""}Questions? Contact us on the site.<br/>Thank you for shopping with RBstars.</p>
        </div>
      `,
    });
    logger.info(`Cancellation email sent to ${to} for order ${orderNumber}`);
  } catch (err) {
    logger.error("Failed to send cancellation email:", err.message);
  }
}

module.exports = {
  sendInviteEmail,
  sendVerificationEmail,
  sendPasswordEmail,
  sendOrderConfirmationEmail,
  sendAgentReplyNotificationEmail,
  sendRefundEmail,
  sendCancellationEmail,
};
