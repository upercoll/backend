const crypto = require("crypto");
const Stocker = require("../models/Stocker");
const AdminProfile = require("../models/AdminProfile");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { signPanelToken } = require("../middleware/panelAuth");
const { sendVerificationEmail } = require("../config/email");

function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) return next(new AppError("Email and password are required", 400));

  const stocker = await Stocker.findOne({ email: email.toLowerCase(), active: true }).select("+password");
  if (!stocker || stocker.status !== "active") {
    return next(new AppError("Invalid credentials", 401));
  }

  const isMatch = await stocker.comparePassword(password);
  if (!isMatch) return next(new AppError("Invalid credentials", 401));

  stocker.lastLogin = new Date();
  await stocker.save();

  const token = signPanelToken({ id: stocker._id, type: "stocker" });

  let profile = await AdminProfile.findOne({ memberId: stocker._id, memberType: "Stocker" });
  if (!profile) {
    profile = await AdminProfile.create({
      memberId: stocker._id,
      memberType: "Stocker",
      displayName: stocker.name || stocker.email.split("@")[0],
      username: stocker.email.split("@")[0],
      profileComplete: true,
    });
  }

  res.json({
    success: true,
    token,
    data: {
      user: {
        id: stocker._id,
        email: stocker.email,
        name: stocker.name,
        type: "stocker",
        isOwner: false,
        isStocker: true,
        permissions: [],
        games: stocker.games,
        commissionRate: stocker.commissionRate,
      },
      profile,
    },
  });
});

exports.validateInvite = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const hashed = crypto.createHash("sha256").update(token).digest("hex");

  const stocker = await Stocker.findOne({
    inviteToken: hashed,
    inviteExpiry: { $gt: new Date() },
    status: "invited",
  });

  if (!stocker) return next(new AppError("Invalid or expired invite link", 400));

  res.json({ success: true, data: { email: stocker.email, stockerId: stocker._id } });
});

exports.sendVerificationCode = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const hashed = crypto.createHash("sha256").update(token).digest("hex");

  const stocker = await Stocker.findOne({
    inviteToken: hashed,
    inviteExpiry: { $gt: new Date() },
    status: "invited",
  });

  if (!stocker) return next(new AppError("Invalid or expired invite link", 400));

  const code = generateCode();
  stocker.verificationCode = code;
  stocker.verificationExpiry = new Date(Date.now() + 15 * 60 * 1000);
  await stocker.save();

  try {
    await sendVerificationEmail({ to: stocker.email, code });
  } catch (err) {
    console.error("Failed to send verification email:", err.message);
  }

  res.json({ success: true, message: "Verification code sent to your email" });
});

exports.verifyAndActivate = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const { code, password, displayName, username } = req.body;

  const hashed = crypto.createHash("sha256").update(token).digest("hex");

  const stocker = await Stocker.findOne({
    inviteToken: hashed,
    inviteExpiry: { $gt: new Date() },
    status: "invited",
  }).select("+verificationCode");

  if (!stocker) return next(new AppError("Invalid or expired invite link", 400));
  if (!stocker.verificationCode || stocker.verificationCode !== code) {
    return next(new AppError("Invalid verification code", 400));
  }
  if (stocker.verificationExpiry < new Date()) {
    return next(new AppError("Verification code expired", 400));
  }
  if (!password || password.length < 8) {
    return next(new AppError("Password must be at least 8 characters", 400));
  }

  stocker.password = password;
  stocker.status = "active";
  stocker.name = displayName || stocker.email.split("@")[0];
  stocker.inviteToken = undefined;
  stocker.inviteExpiry = undefined;
  stocker.verificationCode = undefined;
  stocker.verificationExpiry = undefined;
  stocker.lastLogin = new Date();
  await stocker.save();

  let profile = await AdminProfile.findOne({ memberId: stocker._id, memberType: "Stocker" });
  if (!profile) {
    const usernameToUse = username || (displayName || stocker.email.split("@")[0]).toLowerCase().replace(/\s+/g, "_");
    profile = await AdminProfile.create({
      memberId: stocker._id,
      memberType: "Stocker",
      displayName: displayName || stocker.name,
      username: usernameToUse,
      profileComplete: true,
    });
  }

  const jwtToken = signPanelToken({ id: stocker._id, type: "stocker" });

  res.json({
    success: true,
    token: jwtToken,
    data: {
      user: {
        id: stocker._id,
        email: stocker.email,
        name: stocker.name,
        type: "stocker",
        isOwner: false,
        isStocker: true,
        permissions: [],
        games: stocker.games,
        commissionRate: stocker.commissionRate,
      },
      profile,
    },
  });
});

exports.me = catchAsync(async (req, res, next) => {
  const stocker = req.panelUser.stocker;
  let profile = await AdminProfile.findOne({ memberId: stocker._id, memberType: "Stocker" });
  if (!profile) {
    profile = await AdminProfile.create({
      memberId: stocker._id,
      memberType: "Stocker",
      displayName: stocker.name || stocker.email.split("@")[0],
      username: stocker.email.split("@")[0],
      profileComplete: true,
    });
  }

  res.json({
    success: true,
    data: {
      user: {
        id: stocker._id,
        email: stocker.email,
        name: stocker.name,
        type: "stocker",
        isOwner: false,
        isStocker: true,
        permissions: [],
        games: stocker.games,
        commissionRate: stocker.commissionRate,
      },
      profile,
    },
  });
});
