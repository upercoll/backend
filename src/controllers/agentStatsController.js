const AgentStats = require("../models/AgentStats");
const TeamMember = require("../models/TeamMember");
const AdminProfile = require("../models/AdminProfile");
const ClaimSession = require("../models/ClaimSession");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.getAllAgentStats = catchAsync(async (req, res) => {
  const { game, online } = req.query;

  let memberFilter = { active: true, status: "active" };
  if (game) memberFilter.claimGames = game;

  const members = await TeamMember.find(memberFilter)
    .populate({ path: "role", select: "name color" })
    .select("email claimGames status");

  const enriched = await Promise.all(
    members.map(async (m) => {
      const stats = await AgentStats.findOne({ agentId: m._id });
      const profile = await AdminProfile.findOne({ memberId: m._id, memberType: "TeamMember" });

      if (online !== undefined && stats?.isOnline !== (online === "true")) return null;

      return {
        member: { ...m.toObject() },
        profile: profile ? { displayName: profile.displayName, username: profile.username, profilePicture: profile.profilePicture } : null,
        stats: stats
          ? {
              totalClaims: stats.totalClaims,
              completedClaims: stats.completedClaims,
              declinedClaims: stats.declinedClaims,
              timedOutClaims: stats.timedOutClaims,
              avgResponseTimeMs: stats.avgResponseTimeMs,
              totalOnlineMs: stats.totalOnlineMs,
              isOnline: stats.isOnline,
              lastSeen: stats.lastSeen,
              gamesHandled: stats.gamesHandled,
              rating: stats.rating,
              monthlyStats: stats.monthlyStats.slice(-3),
              completionRate: stats.totalClaims > 0 ? Math.round((stats.completedClaims / stats.totalClaims) * 100) : 0,
            }
          : {
              totalClaims: 0, completedClaims: 0, declinedClaims: 0,
              isOnline: false, completionRate: 0,
            },
      };
    })
  );

  const filtered = enriched.filter(Boolean);
  res.json({ success: true, data: { agents: filtered } });
});

exports.getMyStats = catchAsync(async (req, res) => {
  const agentId = req.panelUser.id;
  const stats = await AgentStats.findOne({ agentId });
  const recentSessions = await ClaimSession.find({ "assignedAgent.userId": agentId })
    .sort({ createdAt: -1 })
    .limit(10)
    .select("roomId status game robloxUsername createdAt resolvedAt");

  res.json({
    success: true,
    data: {
      stats: stats || { totalClaims: 0, completedClaims: 0 },
      recentSessions,
      completionRate:
        stats && stats.totalClaims > 0 ? Math.round((stats.completedClaims / stats.totalClaims) * 100) : 0,
    },
  });
});

exports.getAgentDetail = catchAsync(async (req, res, next) => {
  const member = await TeamMember.findById(req.params.id)
    .populate({ path: "role", select: "name color" })
    .select("email claimGames status createdAt lastLogin");
  if (!member) return next(new AppError("Agent not found", 404));

  const [stats, profile, recentSessions] = await Promise.all([
    AgentStats.findOne({ agentId: member._id }),
    AdminProfile.findOne({ memberId: member._id, memberType: "TeamMember" }),
    ClaimSession.find({ "assignedAgent.userId": member._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("roomId status game robloxUsername createdAt resolvedAt firstAgentReplyAt feedback"),
  ]);

  res.json({
    success: true,
    data: { member: member.toObject(), profile: profile?.toObject(), stats, recentSessions },
  });
});
