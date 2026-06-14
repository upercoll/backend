const crypto = require("crypto");
const User = require("../models/User");
const TeamMember = require("../models/TeamMember");
const AdminProfile = require("../models/AdminProfile");
const AgentStats = require("../models/AgentStats");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { signPanelToken } = require("../middleware/panelAuth");
const { sendVerificationEmail, sendPasswordEmail } = require("../config/email");

exports.ownerLogin = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) return next(new AppError("Email and password required", 400));

  const user = await User.findOne({ email: String(email).toLowerCase(), role: "admin" }).select("+password +active");
  if (!user || !user.active) return next(new AppError("Invalid credentials", 401));
  if (!(await user.comparePassword(password))) return next(new AppError("Invalid credentials", 401));

  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false });

  let profile = await AdminProfile.findOne({ memberId: user._id, memberType: "User" });
  if (!profile) {
    profile = await AdminProfile.create({ memberId: user._id, memberType: "User", isOwner: true });
  }

  const token = signPanelToken({ id: user._id, type: "owner", email: user.email });

  res.json({
    success: true,
    token,
    data: {
      user: { id: user._id, email: user.email, type: "owner", isOwner: true },
      profile: profile.toObject(),
      profileComplete: profile.profileComplete,
    },
  });
});

exports.memberLogin = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) return next(new AppError("Email and password required", 400));

  const member = await TeamMember.findOne({ email: String(email).toLowerCase() })
    .select("+password")
    .populate({ path: "role", select: "name permissions color active" });

  if (!member || !member.active || member.status !== "active") {
    return next(new AppError("Invalid credentials or account not activated", 401));
  }
  if (!member.password) return next(new AppError("Please use the invite link to set up your account", 400));
  if (!(await member.comparePassword(password))) return next(new AppError("Invalid credentials", 401));
  if (!member.role?.active) return next(new AppError("Your role has been deactivated", 403));

  member.lastLogin = new Date();
  await member.save({ validateBeforeSave: false });

  let profile = await AdminProfile.findOne({ memberId: member._id, memberType: "TeamMember" });
  if (!profile) {
    profile = await AdminProfile.create({ memberId: member._id, memberType: "TeamMember" });
  }

  await AgentStats.findOneAndUpdate(
    { agentId: member._id },
    { isOnline: true, currentSessionStart: new Date(), lastSeen: new Date() },
    { upsert: true }
  );

  const token = signPanelToken({
    id: member._id,
    type: "team_member",
    email: member.email,
    permissions: member.role.permissions,
  });

  res.json({
    success: true,
    token,
    data: {
      user: { id: member._id, email: member.email, type: "team_member", isOwner: false },
      role: member.role,
      permissions: member.role.permissions,
      claimGames: member.claimGames,
      profile: profile.toObject(),
      profileComplete: profile.profileComplete,
    },
  });
});

exports.validateInviteToken = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const hashed = crypto.createHash("sha256").update(token).digest("hex");

  const member = await TeamMember.findOne({
    inviteToken: hashed,
    inviteExpiry: { $gt: new Date() },
    status: "invited",
  }).populate({ path: "role", select: "name permissions color" });

  if (!member) return next(new AppError("Invite link is invalid or has expired", 400));

  res.json({
    success: true,
    data: { email: member.email, role: member.role, memberId: member._id },
  });
});

exports.sendVerificationCode = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const hashed = crypto.createHash("sha256").update(token).digest("hex");

  const member = await TeamMember.findOne({
    inviteToken: hashed,
    inviteExpiry: { $gt: new Date() },
    status: "invited",
  });
  if (!member) return next(new AppError("Invite expired or invalid", 400));

  const code = member.generateVerificationCode();
  await member.save({ validateBeforeSave: false });

  await sendVerificationEmail({ to: member.email, code });

  res.json({ success: true, message: "Verification code sent to your email" });
});

exports.verifyCodeAndActivate = catchAsync(async (req, res, next) => {
  const { token } = req.params;
  const { code, password, displayName, username } = req.body;

  if (!code || !password) return next(new AppError("Code and password are required", 400));
  if (password.length < 8) return next(new AppError("Password must be at least 8 characters", 400));

  const hashed = crypto.createHash("sha256").update(token).digest("hex");

  const member = await TeamMember.findOne({
    inviteToken: hashed,
    inviteExpiry: { $gt: new Date() },
    status: "invited",
  }).select("+verificationCode");

  if (!member) return next(new AppError("Invite expired or invalid", 400));
  if (member.verificationCode !== code) return next(new AppError("Invalid verification code", 400));
  if (!member.verificationExpiry || member.verificationExpiry < new Date()) {
    return next(new AppError("Verification code expired", 400));
  }

  if (username) {
    const exists = await AdminProfile.findOne({ username: username.toLowerCase() });
    if (exists) return next(new AppError("Username already taken", 400));
  }

  member.password = password;
  member.status = "active";
  member.inviteToken = undefined;
  member.inviteExpiry = undefined;
  member.verificationCode = undefined;
  member.verificationExpiry = undefined;
  await member.save();

  const profile = await AdminProfile.create({
    memberId: member._id,
    memberType: "TeamMember",
    displayName: displayName || "",
    username: username?.toLowerCase() || "",
    profileComplete: !!(displayName && username),
  });

  await AgentStats.create({ agentId: member._id });

  const populatedMember = await TeamMember.findById(member._id).populate({ path: "role", select: "name permissions color" });
  const panelToken = signPanelToken({
    id: member._id,
    type: "team_member",
    email: member.email,
    permissions: populatedMember.role.permissions,
  });

  res.json({
    success: true,
    token: panelToken,
    data: {
      user: { id: member._id, email: member.email, type: "team_member" },
      role: populatedMember.role,
      permissions: populatedMember.role.permissions,
      profile: profile.toObject(),
      profileComplete: profile.profileComplete,
    },
  });
});

exports.me = catchAsync(async (req, res) => {
  const { panelUser } = req;

  let profile;
  if (panelUser.isOwner) {
    profile = await AdminProfile.findOne({ memberId: panelUser.id, memberType: "User" });
  } else {
    profile = await AdminProfile.findOne({ memberId: panelUser.id, memberType: "TeamMember" });
  }

  res.json({
    success: true,
    data: {
      user: {
        id: panelUser.id,
        email: panelUser.email,
        type: panelUser.type,
        isOwner: panelUser.isOwner,
        permissions: panelUser.permissions,
        claimGames: panelUser.claimGames || [],
        role: panelUser.role || null,
      },
      profile: profile?.toObject() || null,
    },
  });
});

exports.logout = catchAsync(async (req, res) => {
  if (req.panelUser?.type === "team_member") {
    const stats = await AgentStats.findOne({ agentId: req.panelUser.id });
    if (stats?.isOnline && stats.currentSessionStart) {
      const onlineMs = Date.now() - stats.currentSessionStart.getTime();
      stats.totalOnlineMs += onlineMs;
      stats.isOnline = false;
      stats.currentSessionStart = undefined;
      stats.lastSeen = new Date();
      await stats.save();
    }
  }
  res.json({ success: true, message: "Logged out" });
});
