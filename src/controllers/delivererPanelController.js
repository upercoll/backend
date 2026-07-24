const ClaimSession = require("../models/ClaimSession");
const DeliveryRecord = require("../models/DeliveryRecord");
const Deliverer = require("../models/Deliverer");
const Order = require("../models/Order");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

// GET /api/deliverer/claims — pending queue + my active sessions
exports.getClaims = catchAsync(async (req, res) => {
  const delivererId = req.deliverer._id;
  const delivererGames = req.deliverer.games || [];

  // Filter pending queue by assigned games (same logic as claim agent queue)
  const pendingFilter = { status: "pending" };
  if (delivererGames.length > 0) {
    pendingFilter.$or = [
      { game: { $in: delivererGames } },
      { game: null },
      { game: { $exists: false } },
      { game: "" },
    ];
  }

  const [pending, mine, completed] = await Promise.all([
    ClaimSession.find(pendingFilter)
      .sort({ createdAt: 1 })
      .limit(50)
      .select("-messages -__v"),
    ClaimSession.find({ status: "active", "delivererAssigned.delivererId": delivererId })
      .sort({ createdAt: -1 })
      .limit(20)
      .select("-__v"),
    ClaimSession.find({
      status: { $in: ["claimed", "ended"] },
      "delivererAssigned.delivererId": delivererId,
    })
      .sort({ resolvedAt: -1 })
      .limit(30)
      .select("-messages -__v"),
  ]);

  res.json({ success: true, data: { pending, mine, completed } });
});

// GET /api/deliverer/claims/:roomId
exports.getSession = catchAsync(async (req, res, next) => {
  const session = await ClaimSession.findOne({ roomId: req.params.roomId }).select("-__v");
  if (!session) return next(new AppError("Session not found", 404));
  res.json({ success: true, data: { session } });
});

// POST /api/deliverer/claims/:roomId/claim — claim a pending session
exports.claimSession = catchAsync(async (req, res, next) => {
  const session = await ClaimSession.findOne({ roomId: req.params.roomId });
  if (!session) return next(new AppError("Session not found", 404));
  if (session.status !== "pending")
    return next(new AppError("Session is no longer available to claim", 400));

  const deliverer = req.deliverer;
  session.status = "active";
  session.assignedAgent = {
    userId: deliverer._id,
    name: deliverer.name || deliverer.email,
    joinedAt: new Date(),
  };
  session.delivererAssigned = {
    delivererId: deliverer._id,
    name: deliverer.name || deliverer.email,
    claimedAt: new Date(),
  };

  // System message
  session.messages.push({
    sender: "system",
    text: `${deliverer.name || deliverer.email} has joined the chat`,
    senderName: "System",
    timestamp: new Date(),
  });

  await session.save();

  try {
    const { getIO } = require("../config/socket");
    const io = getIO();
    io.to(`claim:${session.roomId}`).emit("claim:agent_joined", {
      agentName: deliverer.name || deliverer.email,
      message: `${deliverer.name || deliverer.email} has joined the chat`,
    });
    io.to("admin-room").emit("admin:claim_update", { roomId: session.roomId, status: "active" });
  } catch {}

  res.json({ success: true, data: { status: session.status } });
});

// POST /api/deliverer/claims/:roomId/deliver — mark as delivered and record revenue
exports.markDelivered = catchAsync(async (req, res, next) => {
  const deliverer = req.deliverer;
  const session = await ClaimSession.findOne({
    roomId: req.params.roomId,
    "delivererAssigned.delivererId": deliverer._id,
  });
  if (!session) return next(new AppError("Session not found or not assigned to you", 404));
  if (!["active", "pending"].includes(session.status))
    return next(new AppError("Session is not active", 400));

  // Upload any proof screenshots to Cloudinary
  let proofImageUrls = [];
  if (req.files && req.files.length > 0) {
    try {
      const { uploadToCloudinary } = require("../config/cloudinary");
      const uploads = await Promise.all(
        req.files.map(f => uploadToCloudinary(f.buffer, { folder: "rbstars/deliverer-proofs" }))
      );
      proofImageUrls = uploads.map(u => u.secure_url);
    } catch (err) {
      const logger = require("../utils/logger");
      logger.error("Deliverer proof upload failed:", err);
    }
  }

  const podNotes = req.body?.notes || "";

  session.status = "claimed";
  session.resolvedAt = new Date();
  session.messages.push({
    sender: "system",
    text: "Your order has been delivered! Items should be in your inventory.",
    senderName: "System",
    timestamp: new Date(),
  });
  await session.save();

  // Look up order total for commission calculation
  let orderTotal = 0;
  if (session.orderRef) {
    try {
      const order = await Order.findOne({ orderNumber: session.orderRef }).select("pricing.total");
      if (order?.pricing?.total) orderTotal = order.pricing.total;
    } catch {}
  }

  const commission = (orderTotal * (deliverer.commissionRate || 20)) / 100;

  // Auto-complete the linked order (same as claim:mark_claimed socket handler)
  if (session.orderRef) {
    try {
      const linkedOrder = await Order.findOne({ orderNumber: session.orderRef });
      const terminal = ["completed", "cancelled", "refunded", "partially_refunded"];
      if (linkedOrder && !terminal.includes(linkedOrder.status)) {
        linkedOrder.status = "completed";
        linkedOrder.fulfilledAt = new Date();
        linkedOrder.fulfilledBy = deliverer.name || deliverer.email;
        linkedOrder.delivery.status = "delivered";
        linkedOrder.delivery.deliveredAt = new Date();
        if (!linkedOrder.timeline) linkedOrder.timeline = [];
        linkedOrder.timeline.push({
          action: "Order auto-completed via deliverer panel",
          by: deliverer.name || deliverer.email,
          details: `Claim session ${session.roomId} marked delivered by deliverer`,
          timestamp: new Date(),
        });
        await linkedOrder.save();
      }
    } catch {}
  }

  // Record delivery (with optional proof)
  await DeliveryRecord.create({
    deliverer: deliverer._id,
    sessionId: session.roomId,
    orderNumber: session.orderRef || null,
    robloxUsername: session.robloxUsername,
    game: session.game || null,
    items: session.items || [],
    orderTotal,
    commissionRate: deliverer.commissionRate || 20,
    commission,
    deliveredAt: new Date(),
    ...(proofImageUrls.length > 0 && { proofImages: proofImageUrls }),
    ...(podNotes && { notes: podNotes }),
  });

  // Update deliverer stats
  await Deliverer.findByIdAndUpdate(deliverer._id, {
    $inc: {
      totalRevenue: orderTotal,
      totalCommission: commission,
      totalDelivered: 1,
      lifetimeRevenue: orderTotal,
      lifetimeCommission: commission,
    },
  });

  try {
    const { getIO } = require("../config/socket");
    const io = getIO();
    io.to(`claim:${session.roomId}`).emit("claim:marked_claimed", {
      message: "Your order has been delivered!",
    });
    io.to("admin-room").emit("admin:claim_update", { roomId: session.roomId, status: "claimed" });
  } catch {}

  res.json({ success: true, data: { commission, orderTotal } });
});

// POST /api/deliverer/claims/:roomId/message — send a chat message
exports.sendMessage = catchAsync(async (req, res, next) => {
  const { text } = req.body;
  if (!text?.trim()) return next(new AppError("Message text required", 400));

  const deliverer = req.deliverer;
  const session = await ClaimSession.findOne({
    roomId: req.params.roomId,
    "delivererAssigned.delivererId": deliverer._id,
  });
  if (!session) return next(new AppError("Session not found or not assigned to you", 404));
  if (session.status !== "active") return next(new AppError("Session is not active", 400));

  const msg = {
    sender: "agent",
    text: text.trim().slice(0, 2000),
    senderName: deliverer.name || deliverer.email,
    timestamp: new Date(),
  };
  session.messages.push(msg);
  await session.save();

  try {
    const { getIO } = require("../config/socket");
    const io = getIO();
    io.to(`claim:${session.roomId}`).emit("claim:new_message", {
      ...msg,
      roomId: session.roomId,
    });
  } catch {}

  res.json({ success: true, data: { message: msg } });
});

// GET /api/deliverer/orders — list of paid/completed orders visible to deliverers
exports.getOrders = catchAsync(async (req, res) => {
  const { page = 1, limit = 25, search = "", status = "" } = req.query;

  const filter = { "payment.status": "succeeded" };
  if (status && ["paid", "delivering", "completed", "cancelled"].includes(status)) {
    filter.status = status;
  }
  if (search) {
    filter.$or = [
      { orderNumber: { $regex: search, $options: "i" } },
      { "customer.email": { $regex: search, $options: "i" } },
      { "customer.robloxUsername": { $regex: search, $options: "i" } },
    ];
  }

  const skip = (Number(page) - 1) * Number(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
    Order.countDocuments(filter),
  ]);

  res.json({ success: true, data: { orders, total, pages: Math.ceil(total / Number(limit)) } });
});

// GET /api/deliverer/orders/by-ref/:orderNumber — fetch an order by number for the sidebar
exports.getOrderByRef = catchAsync(async (req, res, next) => {
  const order = await Order.findOne({ orderNumber: req.params.orderNumber }).lean();
  if (!order) return next(new AppError("Order not found", 404));
  res.json({ success: true, data: order });
});

// GET /api/deliverer/stats
exports.getStats = catchAsync(async (req, res) => {
  const deliverer = req.deliverer;
  const records = await DeliveryRecord.find({ deliverer: deliverer._id }).sort({ deliveredAt: -1 }).limit(50);

  res.json({
    success: true,
    data: {
      deliverer: {
        name: deliverer.name,
        email: deliverer.email,
        commissionRate: deliverer.commissionRate,
        totalRevenue: deliverer.totalRevenue,
        totalCommission: deliverer.totalCommission,
        totalDelivered: deliverer.totalDelivered,
        lifetimeRevenue: deliverer.lifetimeRevenue,
        lifetimeCommission: deliverer.lifetimeCommission,
        lastPayoutAt: deliverer.lastPayoutAt,
      },
      recentDeliveries: records,
    },
  });
});
