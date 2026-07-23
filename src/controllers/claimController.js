const { v4: uuidv4 } = require("uuid");
const ClaimSession = require("../models/ClaimSession");
const Order = require("../models/Order");
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

  // Resolve item names up front: prefer what the frontend sent, then fall back to the
  // customer's most recent paid Order in the database (covers the case where the
  // customer is on a different device and has no localStorage, AND covers backfilling
  // an existing/duplicate session below that was created before item info was ready).
  let resolvedItems = Array.isArray(items) ? items : [];
  let resolvedItemName = (() => {
    if (itemName?.trim() && !isGenericName(itemName)) return itemName.trim();
    const real = resolvedItems.find(i => i?.name?.trim() && !isGenericName(i.name));
    return real?.name?.trim() || null;
  })();
  let resolvedOrderRef = orderRef?.trim() || null;

  if (!resolvedItemName || resolvedItems.length === 0) {
    try {
      const orderQuery = { "customer.email": emailLower, "payment.status": "succeeded" };
      if (resolvedOrderRef) orderQuery.orderNumber = resolvedOrderRef;
      const order = await Order.findOne(orderQuery)
        .sort({ createdAt: -1 })
        .select("items orderNumber")
        .lean();
      if (order?.items?.length) {
        const dbItems = order.items
          .map(i => ({ name: i.productSnapshot?.name || "", quantity: i.quantity || 1 }))
          .filter(i => i.name && !isGenericName(i.name));
        if (dbItems.length) {
          if (resolvedItems.length === 0) resolvedItems = dbItems;
          if (!resolvedItemName) resolvedItemName = dbItems[0].name;
          if (!resolvedOrderRef && order.orderNumber) resolvedOrderRef = order.orderNumber;
        }
      }
    } catch (e) {
      logger.warn(`Order lookup failed for ${emailLower}: ${e.message}`);
    }
  }

  // First try: exact match by email + orderRef (if provided) + active status
  let existingSession = null;
  if (resolvedOrderRef) {
    existingSession = await ClaimSession.findOne({
      contactEmail: emailLower,
      orderRef: resolvedOrderRef,
      status: { $in: ["pending", "active"] },
    }).sort({ createdAt: -1 });
  }

  // Fallback: catch double-submits where orderRef differs or is missing on one call
  // (e.g. page submits before product info loads, then again after).
  // Only applies when BOTH sides have no orderRef, or they share the same one —
  // a request carrying a different orderRef is a new purchase and must get a fresh session.
  if (!existingSession) {
    const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000);
    const recentActive = await ClaimSession.findOne({
      contactEmail: emailLower,
      status: { $in: ["pending", "active"] },
      createdAt: { $gte: twoMinAgo },
    }).sort({ createdAt: -1 });

    if (recentActive) {
      const sameOrder =
        !resolvedOrderRef ||
        !recentActive.orderRef ||
        recentActive.orderRef === resolvedOrderRef;
      if (sameOrder) existingSession = recentActive;
    }
  }

  // Permanent block: if this specific orderRef was already delivered/ended,
  // never allow a new session to be created for it regardless of time passed.
  if (!existingSession && resolvedOrderRef) {
    const completedForOrder = await ClaimSession.findOne({
      contactEmail: emailLower,
      orderRef: resolvedOrderRef,
      status: { $in: ["claimed", "ended"] },
    }).sort({ updatedAt: -1 });
    if (completedForOrder) existingSession = completedForOrder;
  }

  // Also return recently closed/ended/claimed sessions so the customer
  // cannot immediately re-create a new session after an agent closes theirs.
  // Only blocks re-creation when the order ref matches (or neither side has one) —
  // a new purchase with a different orderRef must be allowed through as a fresh claim.
  if (!existingSession) {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
    const recentClosed = await ClaimSession.findOne({
      contactEmail: emailLower,
      status: { $in: ["closed", "ended", "claimed"] },
      updatedAt: { $gte: thirtyMinAgo },
    }).sort({ updatedAt: -1 });

    if (recentClosed) {
      const sameOrder =
        !resolvedOrderRef ||
        !recentClosed.orderRef ||
        recentClosed.orderRef === resolvedOrderRef;
      if (sameOrder) existingSession = recentClosed;
    }
  }

  // ── Payment guard ────────────────────────────────────────────────────────────
  // Only allow a NEW claim session to be created when at least one successfully
  // paid Stripe order exists for this customer.  Existing sessions are returned
  // as-is (no disruption to live chats), but creating a fresh session requires a
  // confirmed payment.status === "succeeded" order in the database.
  if (!existingSession) {
    const paymentQuery = { "customer.email": emailLower, "payment.status": "succeeded" };
    if (resolvedOrderRef) paymentQuery.orderNumber = resolvedOrderRef;
    const paidOrder = await Order.findOne(paymentQuery).select("_id orderNumber").lean();
    if (!paidOrder) {
      const msg = resolvedOrderRef
        ? `No successful payment found for order ${resolvedOrderRef}. Claim chats can only be opened for orders whose payment reached Stripe successfully.`
        : "No successful payment found for this email address. Claim chats can only be opened after a payment has been confirmed by Stripe.";
      return next(new AppError(msg, 402));
    }
    // Pin orderRef to the confirmed paid order when none was supplied by the client.
    if (!resolvedOrderRef && paidOrder.orderNumber) {
      resolvedOrderRef = paidOrder.orderNumber;
    }
  }
  // ── End payment guard ─────────────────────────────────────────────────────────

  if (existingSession) {
    // Backfill item/order/game info onto the existing session if it's missing it and
    // this request resolved real data — covers the case where an earlier attempt
    // created the session as a generic/itemless claim (e.g. before checkout finished
    // confirming, or before the widget had refreshed its local order data) and this
    // later attempt has the real info available.
    let changed = false;
    if ((!existingSession.items || existingSession.items.length === 0) && resolvedItems.length > 0) {
      existingSession.items = resolvedItems;
      changed = true;
    }
    if (isGenericName(existingSession.itemName) && resolvedItemName) {
      existingSession.itemName = resolvedItemName;
      changed = true;
    }
    if (!existingSession.orderRef && resolvedOrderRef) {
      existingSession.orderRef = resolvedOrderRef;
      changed = true;
    }
    if (!existingSession.game && game?.trim()) {
      existingSession.game = game.trim();
      changed = true;
    }
    if (changed) {
      await existingSession.save();
      logger.info(`Backfilled item/order info on existing claim session ${existingSession.roomId}`);
    }

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
  let nextSlotAt = null;
  if (game?.trim()) {
    try {
      const gameDoc = await Game.findOne({ slug: game.trim().toLowerCase() }).select("name claimTime claimSchedule");
      if (gameDoc) {
        const gmt3 = new Date(Date.now() + 3 * 60 * 60 * 1000);
        const hhmm = `${String(gmt3.getUTCHours()).padStart(2, "0")}:${String(gmt3.getUTCMinutes()).padStart(2, "0")}`;
        let inActiveSlot = false;
        if (gameDoc.claimSchedule?.length) {
          const slot = gameDoc.claimSchedule.find(s => {
            if (!s.from || !s.to || !s.minutes) return false;
            return s.from <= s.to ? (hhmm >= s.from && hhmm <= s.to) : (hhmm >= s.from || hhmm <= s.to);
          });
          if (slot) inActiveSlot = true;
          if (!inActiveSlot) {
            const future = gameDoc.claimSchedule
              .filter(s => s.from && s.from > hhmm)
              .sort((a, b) => a.from.localeCompare(b.from))[0];
            if (future) {
              nextSlotAt = future.from;
            } else {
              // No future slot today — wrap to earliest slot (next day, same schedule)
              const earliest = gameDoc.claimSchedule
                .filter(s => s.from)
                .sort((a, b) => a.from.localeCompare(b.from))[0];
              if (earliest) nextSlotAt = earliest.from;
            }
          }
        } else if ((gameDoc.claimTime || 0) > 0) {
          inActiveSlot = true;
        }
        if (!inActiveSlot && ((gameDoc.claimSchedule?.length || 0) > 0 || (gameDoc.claimTime || 0) > 0)) {
          claimTimeMsg = nextSlotAt
            ? `\u23F1 Claim time for ${gameDoc.name} is currently closed. Next available: ${nextSlotAt} (GMT+3).`
            : `\u23F1 Claim time for ${gameDoc.name} is currently unavailable. Our team will respond when available.`;
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
    contactEmail: emailLower,
    orderRef: resolvedOrderRef,
    game: game?.trim() || null,
    itemName: resolvedItemName,
    items: resolvedItems,
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

  logger.info(`New claim session: ${roomId} for ${robloxUsername} — item: ${resolvedItemName || "general"}`);

  res.status(201).json({
    success: true,
    data: {
      roomId: session.roomId,
      status: session.status,
      messages: session.messages,
      nextSlotAt,
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
  const allowed = ["active", "claimed", "ended", "closed"];
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

const GENERIC_ITEM_NAMES = ["general claim", "claim chat"];
function isGenericName(name) {
  return !name || GENERIC_ITEM_NAMES.includes(name.trim().toLowerCase());
}

function sanitizeSession(s) {
  const obj = s.toObject ? s.toObject() : { ...s };
  if (isGenericName(obj.itemName)) obj.itemName = null;
  if (Array.isArray(obj.items)) {
    obj.items = obj.items.filter(i => i.name && !isGenericName(i.name));
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

  const [pending, mine, completed, closed] = await Promise.all([
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
    ClaimSession.find({
      status: "closed",
      "assignedAgent.userId": agentId,
    })
      .sort({ closedAt: -1 })
      .limit(30)
      .select("-messages -__v"),
  ]);

  res.json({
    success: true,
    data: {
      pending:   pending.map(sanitizeSession),
      mine:      mine.map(sanitizeSession),
      completed: completed.map(sanitizeSession),
      closed:    closed.map(sanitizeSession),
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
