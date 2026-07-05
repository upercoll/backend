const crypto = require("crypto");
const Deliverer = require("../models/Deliverer");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { signPanelToken } = require("../middleware/panelAuth");
const { sendVerificationEmail } = require("../config/email");

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function safeUser(d) {
  return {
    id: d._id,
    email: d.email,
    name: d.name,
    type: "deliverer",
    isOwner: false,
    isDeliverer: true,
    permissions: [],
    commissionRate: d.commissionRate,
  };
}

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) return next(new AppError("Email and password are required", 400));

  const deliverer = await Deliverer.findOne({ email: email.toLowerCase(), active: true }).select("+password");
  if (!deliverer || deliverer.status !== "active") return next(new AppError("Invalid credentials", 401));

  const isMatch = await deliverer.comparePassword(password);
  if (!isMatch) return next(new AppError("Invalid credentials", 401));

  deliverer.lastLogin = new Date();
  await deliverer.save();

  const token = signPanelToken({ id: deliverer._id, type: "deliverer" });
  res.json({ success: true, token, data: { user: safeUser(deliverer) } });
});

exports.validateInvite = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const hashed = crypto.createHash("sha256").update(token).digest("hex");
  const deliverer = await Deliverer.findOne({ inviteToken: hashed, inviteExpiry: { $gt: new Date() }, status: "invited" });
  if (!deliverer) return next(new AppError("Invalid or expired invite link", 400));
  res.json({ success: true, data: { email: deliverer.email, delivererId: deliverer._id } });
});

exports.sendVerificationCode = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const hashed = crypto.createHash("sha256").update(token).digest("hex");
  const deliverer = await Deliverer.findOne({ inviteToken: hashed, inviteExpiry: { $gt: new Date() }, status: "invited" });
  if (!deliverer) return next(new AppError("Invalid or expired invite link", 400));

  const code = generateCode();
  deliverer.verificationCode = code;
  deliverer.verificationExpiry = new Date(Date.now() + 15 * 60 * 1000);
  await deliverer.save();

  try {
    await sendVerificationEmail({ to: deliverer.email, code });
  } catch (err) {
    console.error("Failed to send verification email:", err.message);
  }

  res.json({ success: true, message: "Verification code sent to your email" });
});

exports.verifyAndActivate = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const { code, password, displayName } = req.body;
  const hashed = crypto.createHash("sha256").update(token).digest("hex");

  const deliverer = await Deliverer.findOne({
    inviteToken: hashed,
    inviteExpiry: { $gt: new Date() },
    status: "invited",
  }).select("+verificationCode");

  if (!deliverer) return next(new AppError("Invalid or expired invite link", 400));
  if (!deliverer.verificationCode || deliverer.verificationCode !== code)
    return next(new AppError("Invalid verification code", 400));
  if (deliverer.verificationExpiry < new Date())
    return next(new AppError("Verification code expired", 400));
  if (!password || password.length < 8)
    return next(new AppError("Password must be at least 8 characters", 400));

  deliverer.password = password;
  deliverer.status = "active";
  deliverer.name = displayName || deliverer.email.split("@")[0];
  deliverer.inviteToken = undefined;
  deliverer.inviteExpiry = undefined;
  deliverer.verificationCode = undefined;
  deliverer.verificationExpiry = undefined;
  deliverer.lastLogin = new Date();
  await deliverer.save();

  const jwtToken = signPanelToken({ id: deliverer._id, type: "deliverer" });
  res.json({ success: true, token: jwtToken, data: { user: safeUser(deliverer) } });
});

exports.me = catchAsync(async (req, res) => {
  res.json({ success: true, data: { user: safeUser(req.deliverer) } });
});
