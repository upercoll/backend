const Order = require("../models/Order");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const APIFeatures = require("../utils/apiFeatures");

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

exports.getStats = catchAsync(async (req, res) => {
  const [totalOrders, paidOrders, revenueResult, recentOrders] = await Promise.all([
    Order.countDocuments(),
    Order.countDocuments({ status: "paid" }),
    Order.aggregate([
      { $match: { "payment.status": "succeeded" } },
      { $group: { _id: null, total: { $sum: "$pricing.total" } } },
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
