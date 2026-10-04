const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { Resend } = require("resend");
const Customer = require("../models/Customer");
const AppError = require("../utils/AppError");

const FROM = process.env.RESEND_FROM || "RBstars <noreply@rbstars.gg>";

function getResend() {
  return new Resend(process.env.RESEND_API_KEY);
}

function generate6DigitCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendVerificationEmail(email, displayName, code) {
  // No Resend key means the platform cannot send mail. We deliberately do NOT
  // print the code to the server log — that used to leak a live auth code into
  // production logs. Surface a loud warning instead and let the send fail
  // visibly rather than silently "succeeding".
  if (!process.env.RESEND_API_KEY) {
    console.error(
      "[config] RESEND_API_KEY is not set — verification emails cannot be sent. " +
        "Set it before going live."
    );
    throw new Error("Email delivery is not configured");
  }
  const resend = getResend();
  await resend.emails.send({
    from: FROM,
    to: email,
    subject: "Verify your RBstars account",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#07000f;color:#fff;border-radius:16px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px;">
          <div style="width:32px;height:32px;border-radius:50%;background:#7c3aed;display:flex;align-items:center;justify-content:center;">
            <span style="color:white;font-size:18px;">★</span>
          </div>
          <span style="font-size:20px;font-weight:800;color:#fff;">RB<span style="color:#c4b5fd;">stars</span></span>
        </div>
        <h2 style="color:#fff;font-size:22px;margin:0 0 8px;">Hey ${displayName}! 👋</h2>
        <p style="color:#a78bfa;margin:0 0 24px;">Enter this code to verify your email address:</p>
        <div style="background:rgba(124,58,237,0.15);border:1.5px solid rgba(124,58,237,0.4);border-radius:12px;padding:24px;text-align:center;margin-bottom:24px;">
          <span style="font-size:42px;font-weight:900;letter-spacing:0.25em;color:#fff;">${code}</span>
        </div>
        <p style="color:#6b5c8a;font-size:12px;margin:0;">This code expires in 15 minutes. If you didn't create an RBstars account, you can safely ignore this email.</p>
      </div>
    `,
  });
}

function signToken(id, type = "customer") {
  return jwt.sign({ id, type }, process.env.JWT_SECRET, {
    expiresIn: process.env.CUSTOMER_JWT_EXPIRES_IN || "30d",
  });
}

exports.register = async (req, res, next) => {
  try {
    const { email, password, displayName, robloxUsername } = req.body;

    if (!email || !password || !displayName || !robloxUsername) {
      return next(new AppError("All fields are required", 400));
    }
    if (password.length < 8) {
      return next(new AppError("Password must be at least 8 characters", 400));
    }

    const existing = await Customer.findOne({ email: String(email).toLowerCase() });
    if (existing) {
      return next(new AppError("An account with this email already exists", 409));
    }

    const code = generate6DigitCode();
    const expiry = new Date(Date.now() + 15 * 60 * 1000);
    const emailConfigured = Boolean(process.env.RESEND_API_KEY);

    // Deliver the code BEFORE creating the account. It used to be the other
    // way round, so any delivery failure (missing RESEND_API_KEY, Resend
    // outage) left an orphaned account behind: the user saw "Registration
    // failed", then every retry answered "email already exists" and they
    // could never finish signing up. Now a send failure throws while there
    // is still nothing to clean up, so retrying simply works.
    if (emailConfigured) {
      await sendVerificationEmail(String(email).toLowerCase(), displayName, code);
    } else {
      // No mail transport configured at all. Rather than trap the account in
      // a verification step nobody can complete, activate it immediately and
      // shout about it in the logs so the key gets set.
      console.error(
        "[config] RESEND_API_KEY is not set — registering WITHOUT email verification. " +
          "Set the key before going live so broadcasts only reach real inboxes."
      );
    }

    const customer = await Customer.create({
      email,
      password,
      displayName,
      robloxUsername,
      ...(emailConfigured
        ? { emailVerificationCode: code, emailVerificationExpiry: expiry }
        : { emailVerified: true }),
    });

    const token = signToken(customer._id);
    res.status(201).json({
      success: true,
      token,
      customer: customer.toSafeObject(),
      requiresVerification: emailConfigured,
    });
  } catch (err) {
    next(err);
  }
};

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return next(new AppError("Email and password are required", 400));
    }

    const customer = await Customer.findOne({ email: String(email).toLowerCase() }).select("+password");
    if (!customer || !(await customer.comparePassword(password))) {
      return next(new AppError("Invalid email or password", 401));
    }
    if (!customer.active) {
      return next(new AppError("This account has been deactivated", 401));
    }

    customer.lastLogin = new Date();
    await customer.save({ validateBeforeSave: false });

    const token = signToken(customer._id);
    res.json({
      success: true,
      token,
      customer: customer.toSafeObject(),
    });
  } catch (err) {
    next(err);
  }
};

exports.verifyEmail = async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) return next(new AppError("Verification code is required", 400));

    const customer = await Customer.findById(req.customer._id)
      .select("+emailVerificationCode +emailVerificationExpiry");

    if (!customer.emailVerificationCode) {
      return next(new AppError("No pending verification found", 400));
    }
    if (new Date() > customer.emailVerificationExpiry) {
      return next(new AppError("Verification code has expired — please request a new one", 400));
    }
    if (customer.emailVerificationCode !== String(code).trim()) {
      return next(new AppError("Incorrect verification code", 400));
    }

    customer.emailVerified = true;
    customer.emailVerificationCode = undefined;
    customer.emailVerificationExpiry = undefined;
    await customer.save({ validateBeforeSave: false });

    res.json({ success: true, customer: customer.toSafeObject() });
  } catch (err) {
    next(err);
  }
};

exports.resendVerification = async (req, res, next) => {
  try {
    const customer = await Customer.findById(req.customer._id)
      .select("+emailVerificationCode +emailVerificationExpiry");

    if (customer.emailVerified) {
      return next(new AppError("Email is already verified", 400));
    }

    const code = generate6DigitCode();
    customer.emailVerificationCode = code;
    customer.emailVerificationExpiry = new Date(Date.now() + 15 * 60 * 1000);
    await customer.save({ validateBeforeSave: false });

    await sendVerificationEmail(customer.email, customer.displayName, code);
    res.json({ success: true, message: "Verification code sent" });
  } catch (err) {
    next(err);
  }
};

exports.me = async (req, res) => {
  res.json({ success: true, customer: req.customer.toSafeObject() });
};

exports.updateProfile = async (req, res, next) => {
  try {
    const allowed = ["displayName", "robloxUsername", "robloxAvatarUrl"];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    if (Object.keys(updates).length === 0) {
      return next(new AppError("No valid fields to update", 400));
    }

    const customer = await Customer.findByIdAndUpdate(
      req.customer._id,
      updates,
      { new: true, runValidators: true }
    );

    res.json({ success: true, customer: customer.toSafeObject() });
  } catch (err) {
    next(err);
  }
};
