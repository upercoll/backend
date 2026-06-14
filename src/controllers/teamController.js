const crypto = require("crypto");
const TeamMember = require("../models/TeamMember");
const Role = require("../models/Role");
const AdminProfile = require("../models/AdminProfile");
const AgentStats = require("../models/AgentStats");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { sendInviteEmail } = require("../config/email");

exports.listMembers = catchAsync(async (req, res) => {
  const { role, status, game } = req.query;
  const filter = {};
  if (role) filter.role = role;
  if (status) filter.status = status;
  if (game) filter.claimGames = game;

  const members = await TeamMember.find(filter)
    .populate({ path: "role", select: "name color permissions" })
    .sort({ createdAt: -1 });

  const enriched = await Promise.all(
    members.map(async (m) => {
      const profile = await AdminProfile.findOne({ memberId: m._id, memberType: "TeamMember" });
      const stats = await AgentStats.findOne({ agentId: m._id });
      return {
        ...m.toSafeObject(),
        profile: profile?.toObject() || null,
        stats: stats
          ? {
              totalClaims: stats.totalClaims,
              completedClaims: stats.completedClaims,
              isOnline: stats.isOnline,
              lastSeen: stats.lastSeen,
              rating: stats.rating,
            }
          : null,
      };
    })
  );

  res.json({ success: true, data: { members: enriched } });
});

exports.getMember = catchAsync(async (req, res, next) => {
  const member = await TeamMember.findById(req.params.id).populate({ path: "role", select: "name color permissions" });
  if (!member) return next(new AppError("Member not found", 404));

  const profile = await AdminProfile.findOne({ memberId: member._id, memberType: "TeamMember" });
  const stats = await AgentStats.findOne({ agentId: member._id });

  res.json({
    success: true,
    data: { member: member.toSafeObject(), profile: profile?.toObject() || null, stats },
  });
});

exports.inviteMember = catchAsync(async (req, res, next) => {
  const { email, roleId, claimGames } = req.body;
  if (!email || !roleId) return next(new AppError("Email and role are required", 400));

  const role = await Role.findById(roleId);
  if (!role || !role.active) return next(new AppError("Role not found", 404));

  const existing = await TeamMember.findOne({ email: email.toLowerCase() });
  if (existing) {
    if (existing.status === "active") return next(new AppError("This email is already an active team member", 400));
    const rawToken = existing.generateInviteToken();
    await existing.save({ validateBeforeSave: false });

    const inviteUrl = `${process.env.FRONTEND_URL}/admin/invite/${rawToken}`;
    const inviterName = req.panelUser.isOwner ? "The site owner" : req.panelUser.email;
    await sendInviteEmail({ to: email, inviteUrl, roleName: role.name, inviterName });

    return res.json({ success: true, message: "Re-invite sent", data: { member: existing.toSafeObject() } });
  }

  const member = new TeamMember({
    email: email.toLowerCase(),
    role: roleId,
    claimGames: claimGames || [],
    invitedBy: req.panelUser.isOwner ? req.panelUser.id : undefined,
  });

  const rawToken = member.generateInviteToken();
  await member.save();

  const inviteUrl = `${process.env.FRONTEND_URL}/admin/invite/${rawToken}`;
  const inviterName = req.panelUser.isOwner ? "The site owner" : req.panelUser.email;
  await sendInviteEmail({ to: email, inviteUrl, roleName: role.name, inviterName });

  res.status(201).json({
    success: true,
    message: "Invitation sent",
    data: { member: member.toSafeObject() },
  });
});

exports.updateMember = catchAsync(async (req, res, next) => {
  const member = await TeamMember.findById(req.params.id);
  if (!member) return next(new AppError("Member not found", 404));

  const { roleId, claimGames, claimCategories, active } = req.body;

  if (roleId) {
    const role = await Role.findById(roleId);
    if (!role || !role.active) return next(new AppError("Role not found", 404));
    member.role = roleId;
  }
  if (claimGames !== undefined) member.claimGames = claimGames;
  if (claimCategories !== undefined) member.claimCategories = claimCategories;
  if (active !== undefined) {
    member.active = active;
    if (!active) member.status = "disabled";
    else if (member.status === "disabled") member.status = "active";
  }

  await member.save({ validateBeforeSave: false });

  const updated = await TeamMember.findById(member._id).populate({ path: "role", select: "name color permissions" });
  res.json({ success: true, data: { member: updated.toSafeObject() } });
});

exports.removeMember = catchAsync(async (req, res, next) => {
  const member = await TeamMember.findById(req.params.id);
  if (!member) return next(new AppError("Member not found", 404));

  member.active = false;
  member.status = "disabled";
  await member.save({ validateBeforeSave: false });

  res.json({ success: true, message: "Member removed from team" });
});

exports.resendInvite = catchAsync(async (req, res, next) => {
  const member = await TeamMember.findById(req.params.id).populate({ path: "role", select: "name" });
  if (!member) return next(new AppError("Member not found", 404));
  if (member.status === "active") return next(new AppError("Member is already active", 400));

  const rawToken = member.generateInviteToken();
  await member.save({ validateBeforeSave: false });

  const inviteUrl = `${process.env.FRONTEND_URL}/admin/invite/${rawToken}`;
  const inviterName = req.panelUser.isOwner ? "The site owner" : req.panelUser.email;
  await sendInviteEmail({ to: member.email, inviteUrl, roleName: member.role.name, inviterName });

  res.json({ success: true, message: "Invite resent" });
});
