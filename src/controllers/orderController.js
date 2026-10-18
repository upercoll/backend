const Order = require("../models/Order");
const ClaimSession = require("../models/ClaimSession");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const APIFeatures = require("../utils/apiFeatures");
const { NET_REVENUE } = require("../utils/revenue");

/* The signed-in buyer's own orders — the only order listing a customer can
   see. Matched on the email the order was placed with (orders carry no user
   id), and joined to the buyer's claim session by orderRef so the storefront
   can show delivery progress and link the claim chat. */
exports.getMyOrders = catchAsync(async (req, res) => {
  const email = String(req.customer?.email || "").toLowerCase().trim();
  if (!email) return res.status(400).json({ success: false, message: "This account has no email on file" });

  const orders = await Order.find({ "customer.email": email })
    .sort({ createdAt: -1 })
    .limit(60)
    .populate("items.product", "imageUrl")
    .lean();

  const refs = orders.map((o) => o.orderNumber).filter(Boolean);
  const sessions = refs.length
    ? await ClaimSession.find({ orderRef: { $in: refs } }).sort({ createdAt: -1 }).lean()
    : [];
  const byRef = new Map();
  for (const s of sessions) if (s.orderRef && !byRef.has(s.orderRef)) byRef.set(s.orderRef, s);

  const shaped = orders.map((o) => {
    const claim = byRef.get(o.orderNumber) || null;
    const claimed = claim ? claim.items.reduce((n, it) => n + (it.delivered || 0), 0) : 0;
    const claimTotal = claim ? claim.items.reduce((n, it) => n + (it.quantity || 0), 0) : 0;
    return {
      orderNumber: o.orderNumber,
      createdAt: o.createdAt,
      status: o.status,
      total: o.pricing?.total ?? o.totalPrice ?? 0,
      robloxUsername: o.customer?.robloxUsername || "",
      items: (o.items || []).map((it) => ({
        name: it.productSnapshot?.name || it.product?.name || "Item",
        quantity: it.quantity,
        unitPrice: it.unitPrice,
        imageUrl: it.product?.imageUrl || null,
        game: it.productSnapshot?.game || null,
      })),
      claim: claim
        ? { roomId: claim.roomId, status: claim.status, mode: claim.mode, claimed, total: claimTotal }
        : null,
    };
  });

  const isActive = (o) =>
    ["pending", "paid", "delivering"].includes(o.status) ||
    (o.claim && ["pending", "active"].includes(o.claim.status));
  const isDone = (o) => o.status === "completed" || o.claim?.status === "claimed";

  res.status(200).json({
    success: true,
    data: {
      orders: shaped,
      summary: {
        active: shaped.filter(isActive).length,
        completed: shaped.filter(isDone).length,
        total: shaped.length,
      },
    },
  });
});

exports.getByOrderNumber = catchAsync(async (req, res, next) => {
  const order = await Order.findOne({
    orderNumber: req.params.orderNumber,
  }).populate("items.product", "name slug gradient");

  if (!order) return next(new AppError("Order not found", 404));

  const safe = {
    orderNumber: order.orderNumber,
    status: order.status,
    delivery: order.delivery,
    pricing: order.pricing,
    customer: { robloxUsername: order.customer.robloxUsername },
    items: order.items.map((i) => ({
      name: i.productSnapshot.name,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      totalPrice: i.totalPrice,
      gradient: i.productSnapshot.gradient,
    })),
    createdAt: order.createdAt,
  };

  res.json({ success: true, data: safe });
});

exports.getAll = catchAsync(async (req, res) => {
  const features = new APIFeatures(Order.find(), req.query)
    .filter()
    .sort()
    .paginate();

  const [orders, total] = await Promise.all([
    features.query
      .populate("items.product", "name slug")
      .select("-__v"),
    Order.countDocuments(),
  ]);

  res.json({ success: true, total, count: orders.length, data: orders });
});

exports.getOne = catchAsync(async (req, res, next) => {
  const order = await Order.findById(req.params.id).populate(
    "items.product",
    "name slug price gradient imageUrl"
  );
  if (!order) return next(new AppError("Order not found", 404));
  res.json({ success: true, data: order });
});

// Find order by orderNumber (used by profile panels to resolve session.orderRef → order data with product images)
exports.getByRef = catchAsync(async (req, res, next) => {
  const order = await Order.findOne({ orderNumber: req.params.orderNumber }).populate(
    "items.product",
    "name slug price gradient imageUrl"
  );
  if (!order) return next(new AppError("Order not found", 404));
  res.json({ success: true, data: order });
});

exports.updateStatus = catchAsync(async (req, res, next) => {
  const { status, deliveryStatus, adminNotes, refundReason } = req.body;

  const update = {};
  if (status) update.status = status;
  if (deliveryStatus) update["delivery.status"] = deliveryStatus;
  if (deliveryStatus === "delivered") update["delivery.deliveredAt"] = new Date();
  if (adminNotes) update.adminNotes = adminNotes;
  if (refundReason) update.refundReason = refundReason;

  const order = await Order.findByIdAndUpdate(req.params.id, update, { new: true });
  if (!order) return next(new AppError("Order not found", 404));
  res.json({ success: true, data: order });
});

// Same as updateStatus, but looked up by orderNumber — used by claim-chat sidebars
// (Queue/OpenChats) which only carry session.orderRef (a human-readable orderNumber),
// not the order's Mongo _id.
exports.updateStatusByRef = catchAsync(async (req, res, next) => {
  const { status, deliveryStatus, adminNotes, refundReason } = req.body;

  const update = {};
  if (status) update.status = status;
  if (deliveryStatus) update["delivery.status"] = deliveryStatus;
  if (deliveryStatus === "delivered") update["delivery.deliveredAt"] = new Date();
  if (adminNotes) update.adminNotes = adminNotes;
  if (refundReason) update.refundReason = refundReason;

  const order = await Order.findOneAndUpdate(
    { orderNumber: req.params.orderNumber },
    update,
    { new: true }
  );
  if (!order) return next(new AppError("Order not found", 404));
  res.json({ success: true, data: order });
});

exports.getStats = catchAsync(async (req, res) => {
  const [totalOrders, paidOrders, revenueResult, recentOrders] = await Promise.all([
    Order.countDocuments(),
    Order.countDocuments({ status: "paid" }),
    Order.aggregate([
      { $match: { "payment.status": "succeeded", status: { $ne: "refunded" } } },
      { $group: { _id: null, total: { $sum: NET_REVENUE } } },
    ]),
    Order.find()
      .sort("-createdAt")
      .limit(5)
      .select("orderNumber status pricing.total customer.email createdAt"),
  ]);

  res.json({
    success: true,
    data: {
      totalOrders,
      paidOrders,
      totalRevenue: revenueResult[0]?.total || 0,
      recentOrders,
    },
  });
});
