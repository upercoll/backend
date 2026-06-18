const { v4: uuidv4 } = require("uuid");
const ClaimSession = require("../models/ClaimSession");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");

function tryGetIO() {
  try {
    return require("../config/socket").getIO();
  } catch {
    return null;
  }
}

exports.createClaim = catchAsync(async (req, res, next) => {
  const { robloxUsername, contactEmail, orderRef, game, items, itemName } = req.body;

  if (!robloxUsername?.trim()) return next(new AppError("Roblox username is required", 400));
  if (!contactEmail?.includes("@")) return next(new AppError("Valid contact email is required", 400));

  const emailLower = contactEmail.trim().toLowerCase();

  const existingQuery = {
    contactEmail: emailLower,
    status: { $in: ["pending", "active"] },
  };
  if (orderRef?.trim()) {
    existingQuery.orderRef = orderRef.trim();
  }

  const existingSession = await ClaimSession.findOne(existingQuery).sort({ createdAt: -1 });
  if (existingSession) {
    logger.info(`Returning existing claim session ${existingSession.roomId} for ${robloxUsername} (status: ${existingSession.status})`);
    return res.status(200).json({
      success: true,
      data: {
        roomId: existingSession.roomId,
        status: existingSession.status,
        assignedAgent: existingSession.assignedAgent || null,
        messages: existingSession.messages,
      },
    });
  }

  const roomId = uuidv4();

  const Game = require("../models/Game");
  let claimTimeMsg = null;
  if (game?.trim()) {
    try {
      const gameDoc = await Game.findOne({ slug: game.trim().toLowerCase() }).select("name claimTime claimSchedule");
      if (gameDoc) {
        let effectiveMins = gameDoc.claimTime || 0;
        if (gameDoc.claimSchedule?.length) {
          const now = new Date();
          const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
          const slot = gameDoc.claimSchedule.find(s => {
            if (!s.from || !s.to || !s.minutes) return false;
            return s.from <= s.to ? (hhmm >= s.from && hhmm <= s.to) : (hhmm >= s.from || hhmm <= s.to);
          });
          if (slot) effectiveMins = slot.minutes;
        }
        if (effectiveMins > 0) {
          claimTimeMsg = `\u23F1 Claim time for ${gameDoc.name}: up to ${effectiveMins} minute${effectiveMins !== 1 ? "s" : ""}. An agent will join you shortly!`;
        }
      }
    } catch {}
  }

  const initMessages = [
    { sender: "system", text: `${robloxUsername.trim()} has joined the chat`, senderName: "System" },
  ];
  if (claimTimeMsg) {
    initMessages.push({ sender: "system", text: claimTimeMsg, senderName: "System" });
  }

  const session = await ClaimSession.create({
    roomId,
    robloxUsername: robloxUsername.trim(),
    contactEmail: contactEmail.trim().toLowerCase(),
    orderRef: orderRef?.trim() || null,
    game: game?.trim() || null,
    itemName: (itemName?.trim() && itemName.trim().toLowerCase() !== "general claim")
      ? itemName.trim()
      : (Array.isArray(items) && items[0]?.name?.trim() && items[0].name.trim().toLowerCase() !== "general claim")
        ? items[0].name.trim()
        : null,
    items: Array.isArray(items) ? items : [],
    messages: initMessages,
  });

  try {
    const { notifyNewClaim } = require("../config/socket");
    notifyNewClaim({
      roomId: session.roomId,
      robloxUsername: session.robloxUsername,
      contactEmail: session.contactEmail,
      game: session.game,
      orderRef: session.orderRef,
      itemName: session.itemName,
      items: session.items,
      createdAt: session.createdAt,
    });
  } catch {}

  logger.info(`New claim session: ${roomId} for ${robloxUsername} — item: ${itemName || "general"}`);

  res.status(201).json({
    success: true,
    data: {
      roomId: session.roomId,
      status: session.status,
      messages: session.messages,
    },
  });
});

exports.updateUserInfo = catchAsync(async (req, res, next) => {
  const { robloxUsername, contactEmail } = req.body;
  const session = await ClaimSession.findOne({ roomId: req.params.roomId });

  if (!session) return next(new AppError("Session not found", 404));
  if (session.status !== "pending") {
    return next(new AppError("Cannot update info after agent has joined", 400));
  }

  const changes = [];

  if (robloxUsername?.trim() && robloxUsername.trim() !== session.robloxUsername) {
    const oldName = session.robloxUsername;
    const newName = robloxUsername.trim();
    session.robloxUsername = newName;
    changes.push(`${oldName} changed their Roblox username to ${newName}`);
  }

  if (
    contactEmail?.trim() &&
    contactEmail.includes("@") &&
    contactEmail.trim().toLowerCase() !== session.contactEmail
  ) {
    const newEmail = contactEmail.trim().toLowerCase();
    session.contactEmail = newEmail;
    changes.push(`User updated their contact email to ${newEmail}`);
  }

  if (changes.length === 0) {
    return res.json({ success: true, message: "No changes made" });
  }

  for (const text of changes) {
    session.messages.push({ sender: "system", text, senderName: "System" });
  }

  await session.save();

  const io = tryGetIO();
  if (io) {
    for (const text of changes) {
      io.to(`claim:${session.roomId}`).emit("claim:new_message", {
        sender: "system",
        text,
        senderName: "System",
        timestamp: new Date(),
        roomId: session.roomId,
      });
    }
    io.to("admin-room").emit("admin:claim_user_info_updated", {
      roomId: session.roomId,
      robloxUsername: session.robloxUsername,
      contactEmail: session.contactEmail,
    });
  }

  res.json({
    success: true,
    data: {
      robloxUsername: session.robloxUsername,
      contactEmail: session.contactEmail,
    },
  });
});

exports.getSession = catchAsync(async (req, res, next) => {
  const session = await ClaimSession.findOne({ roomId: req.params.roomId }).select("-__v");
  if (!session) return next(new AppError("Session not found", 404));

  const isMonitor = req.panelUser.isOwner || req.panelUser.permissions?.includes("monitor_agents");
  if (!isMonitor) {
    const agentGames = req.panelUser.claimGames || [];
    if (agentGames.length > 0 && session.game && !agentGames.includes(session.game)) {
      return next(new AppError("You are not authorized to view this claim session", 403));
    }
  }

  res.json({
    success: true,
    data: {
      roomId: session.roomId,
      status: session.status,
      assignedAgent: session.assignedAgent,
      messages: session.messages,
    },
  });
});

exports.listClaims = catchAsync(async (req, res) => {
  const { status, page = 1, limit = 30 } = req.query;
  const filter = {};
  if (status) filter.status = status;

  const sessions = await ClaimSession.find(filter)
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(Number(limit))
    .select("-messages -__v");

  const total = await ClaimSession.countDocuments(filter);
  res.json({ success: true, total, data: sessions });
});

exports.getFullSession = catchAsync(async (req, res, next) => {
  const session = await ClaimSession.findOne({ roomId: req.params.roomId });
  if (!session) return next(new AppError("Session not found", 404));

  const isMonitor = req.panelUser.isOwner || req.panelUser.permissions?.includes("monitor_agents");
  if (!isMonitor) {
    const agentGames = req.panelUser.claimGames || [];
    if (agentGames.length > 0 && session.game && !agentGames.includes(session.game)) {
      return next(new AppError("You are not authorized to view this claim session", 403));
    }
  }

  res.json({ success: true, data: sanitizeSession(session) });
});

exports.updateStatus = catchAsync(async (req, res, next) => {
  const { status, agentName } = req.body;
  const allowed = ["active", "claimed", "ended"];
  if (!allowed.includes(status)) return next(new AppError(`Status must be one of: ${allowed.join(", ")}`, 400));

  const session = await ClaimSession.findOne({ roomId: req.params.roomId });
  if (!session) return next(new AppError("Session not found", 404));

  session.status = status;
  if (status === "active" && agentName) {
    session.assignedAgent = {
      userId: req.user?._id || null,
      name: agentName || req.user?.name || "Support Agent",
      joinedAt: new Date(),
    };
  }
  if (status === "claimed" || status === "ended") {
    session.resolvedAt = new Date();
  }

  await session.save();

  const io = tryGetIO();
  if (io) {
    if (status === "active") {
      const n = agentName || req.user?.name || "Support Agent";
      io.to(`claim:${session.roomId}`).emit("claim:agent_joined", {
        agentName: n,
        message: `${n} has joined the chat`,
      });
    }
    if (status === "ended") {
      io.to(`claim:${session.roomId}`).emit("claim:ended", {
        message: "The support agent has ended the chat. Thank you!",
      });
    }
    if (status === "claimed") {
      io.to(`claim:${session.roomId}`).emit("claim:marked_claimed", {
        message: "Your order has been delivered!",
      });
    }
  }

  res.json({ success: true, data: { status: session.status, assignedAgent: session.assignedAgent } });
});

exports.getActiveClaims = catchAsync(async (req, res) => {
  const sessions = await ClaimSession.find({ status: { $in: ["pending", "active"] } })
    .sort({ createdAt: -1 })
    .limit(50)
    .select("-messages -__v");
  res.json({ success: true, data: { sessions } });
});

function sanitizeSession(s) {
  const obj = s.toObject ? s.toObject() : { ...s };
  if (obj.itemName && obj.itemName.trim().toLowerCase() === "general claim") obj.itemName = null;
  if (Array.isArray(obj.items)) {
    obj.items = obj.items.filter(
      i => i.name && i.name.trim().toLowerCase() !== "general claim"
    );
  }
  return obj;
}

exports.getAgentQueue = catchAsync(async (req, res) => {
  const panelUser = req.panelUser;
  const agentId = panelUser?._id || panelUser?.id;
  const agentGames = panelUser?.claimGames || [];

  const pendingFilter = { status: "pending" };
  if (agentGames.length > 0) {
    pendingFilter.$or = [
      { game: { $in: agentGames } },
      { game: null },
      { game: { $exists: false } },
      { game: "" },
    ];
  }

  const [pending, mine, completed] = await Promise.all([
    ClaimSession.find(pendingFilter)
      .sort({ createdAt: 1 })
      .limit(50)
      .select("-__v"),
    ClaimSession.find({
      status: "active",
      "assignedAgent.userId": agentId,
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("-__v"),
    ClaimSession.find({
      status: { $in: ["claimed", "ended"] },
      "assignedAgent.userId": agentId,
    })
      .sort({ resolvedAt: -1 })
      .limit(30)
      .select("-messages -__v"),
  ]);

  res.json({
    success: true,
    data: {
      pending:   pending.map(sanitizeSession),
      mine:      mine.map(sanitizeSession),
      completed: completed.map(sanitizeSession),
    },
  });
});

exports.submitFeedback = catchAsync(async (req, res, next) => {
  const { rating, comment } = req.body;
  const parsedRating = Number(rating);
  if (!parsedRating || parsedRating < 1 || parsedRating > 5) {
    return next(new AppError("Rating must be 1-5", 400));
  }

  let proofImageUrl = null;
  if (req.file) {
    try {
      const { uploadToCloudinary } = require("../config/cloudinary");
      const result = await uploadToCloudinary(req.file.buffer, { folder: "rbstars/reviews" });
      proofImageUrl = result.secure_url;
    } catch (err) {
      logger.error("Failed to upload review proof image:", err);
    }
  }

  const feedbackData = {
    rating: parsedRating,
    comment: comment ? String(comment).slice(0, 500) : undefined,
    proofImageUrl: proofImageUrl || undefined,
    submittedAt: new Date(),
  };

  const session = await ClaimSession.findOneAndUpdate(
    { roomId: req.params.roomId, status: { $in: ["claimed", "ended"] } },
    { feedback: feedbackData },
    { new: true }
  );

  if (!session) return next(new AppError("Session not found or not yet ended", 400));
  res.json({ success: true, message: "Feedback submitted. Thank you!" });
});

exports.getPublicReviews = catchAsync(async (req, res) => {
  const { limit = 30 } = req.query;

  const sessions = await ClaimSession.find({
    "feedback.rating": { $exists: true, $ne: null },
    "feedback.comment": { $exists: true, $ne: "" },
  })
    .sort({ "feedback.submittedAt": -1 })
    .limit(Math.min(Number(limit), 50))
    .select("robloxUsername feedback");

  const reviews = sessions.map(s => ({
    id: s._id,
    name: s.robloxUsername,
    rating: s.feedback.rating,
    comment: s.feedback.comment,
    proofImageUrl: s.feedback.proofImageUrl || null,
    submittedAt: s.feedback.submittedAt,
  }));

  const total = await ClaimSession.countDocuments({
    "feedback.rating": { $exists: true, $ne: null },
  });

  const avgRating =
    reviews.length > 0
      ? Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10) / 10
      : 0;

  res.json({
    success: true,
    data: {
      reviews,
      total,
      averageRating: avgRating,
    },
  });
});
