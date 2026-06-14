const Order = require("../models/Order");
const ClaimSession = require("../models/ClaimSession");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.listOrders = catchAsync(async (req, res) => {
  const { status, payment, page = 1, limit = 20, search, game } = req.query;
  const filter = {};

  if (status) filter.status = status;
  if (payment) filter["payment.status"] = payment;
  if (game) filter["items.productSnapshot.game"] = game;
  if (search) {
    filter.$or = [
      { orderNumber: { $regex: search, $options: "i" } },
      { "customer.email": { $regex: search, $options: "i" } },
      { "customer.robloxUsername": { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [orders, total] = await Promise.all([
    Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    Order.countDocuments(filter),
  ]);

  const enriched = await Promise.all(
    orders.map(async (o) => {
      const claim = await ClaimSession.findOne({ orderRef: o.orderNumber }).select("status assignedAgent roomId");
      return { ...o.toObject(), claimSession: claim?.toObject() || null };
    })
  );

  res.json({
    success: true,
    data: { orders: enriched, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
  });
});

exports.getOrder = catchAsync(async (req, res, next) => {
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError("Order not found", 404));

  const claim = await ClaimSession.findOne({ orderRef: order.orderNumber });
  res.json({ success: true, data: { order, claimSession: claim?.toObject() || null } });
});

exports.updateOrderStatus = catchAsync(async (req, res, next) => {
  const { status, adminNotes } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError("Order not found", 404));

  const valid = ["pending", "paid", "delivering", "completed", "cancelled", "refunded"];
  if (!valid.includes(status)) return next(new AppError("Invalid status", 400));

  order.status = status;
  if (adminNotes !== undefined) order.adminNotes = adminNotes;
  await order.save();

  res.json({ success: true, data: { order } });
});

exports.getClaimChat = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;
  const order = await Order.findById(orderId).select("orderNumber");
  if (!order) return next(new AppError("Order not found", 404));

  const claim = await ClaimSession.findOne({ orderRef: order.orderNumber });
  if (!claim) return next(new AppError("No claim session found for this order", 404));

  res.json({ success: true, data: { claimSession: claim } });
});
