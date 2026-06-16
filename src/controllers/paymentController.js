const Order = require("../models/Order");
const ClaimSession = require("../models/ClaimSession");
const Product = require("../models/Product");
const stripe = require("../config/stripe");
const { sendRefundEmail, sendCancellationEmail } = require("../config/email");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

const VALID_STATUSES = ["pending", "paid", "delivering", "completed", "cancelled", "refunded", "fulfilled", "partially_refunded"];

function addTimeline(order, action, by, details) {
  if (!order.timeline) order.timeline = [];
  order.timeline.push({ action, by: by || "Admin", details, timestamp: new Date() });
}

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

  const Customer = require("../models/Customer");
  let customerOrderCount = 1;
  try {
    const allOrders = await Order.countDocuments({ "customer.email": order.customer.email });
    customerOrderCount = allOrders;
  } catch {}

  const orderObj = order.toObject();
  orderObj.customerOrderCount = customerOrderCount;

  res.json({ success: true, data: { order: orderObj, claimSession: claim?.toObject() || null } });
});

exports.updateOrderStatus = catchAsync(async (req, res, next) => {
  const { status, adminNotes } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError("Order not found", 404));

  if (!VALID_STATUSES.includes(status)) return next(new AppError("Invalid status", 400));

  const prevStatus = order.status;
  const by = req.panelUser?.email || "Admin";

  if (status === "cancelled" && ["paid", "delivering", "fulfilled"].includes(prevStatus)) {
    if (order.payment?.stripePaymentIntentId) {
      try {
        await stripe.refunds.create({
          payment_intent: order.payment.stripePaymentIntentId,
          amount: Math.round(order.pricing.total * 100),
        });
        order.payment.status = "refunded";
        order.refundAmount = order.pricing.total;
        order.refundedAt = new Date();
        addTimeline(order, "Auto-refund issued on cancellation", by, `$${order.pricing.total.toFixed(2)} refunded via Stripe`);
      } catch (stripeErr) {
        addTimeline(order, "Cancellation refund failed — manual refund required", "System", stripeErr.message);
      }
    }
    sendCancellationEmail({
      to: order.customer.email,
      orderNumber: order.orderNumber,
      amount: order.payment?.status === "refunded" ? order.pricing.total : null,
      items: order.items.map(i => ({ name: i.productSnapshot?.name || "Item", quantity: i.quantity })),
      robloxUsername: order.customer.robloxUsername,
    }).catch(() => {});
  }

  order.status = status;
  if (adminNotes !== undefined) order.adminNotes = adminNotes;

  if (status === "fulfilled" && prevStatus !== "fulfilled") {
    order.fulfillmentStatus = "fulfilled";
    order.fulfilledAt = new Date();
    order.fulfilledBy = by;
  }

  addTimeline(order, `Status changed from "${prevStatus}" to "${status}"`, by);

  await order.save();

  res.json({ success: true, data: { order } });
});

exports.fulfillOrder = catchAsync(async (req, res, next) => {
  const { trackingNumber, carrier, notes } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError("Order not found", 404));

  const prevStatus = order.status;
  order.status = "fulfilled";
  order.fulfillmentStatus = "fulfilled";
  order.fulfilledAt = new Date();
  order.fulfilledBy = req.panelUser?.email || "Admin";

  if (trackingNumber) order.delivery.trackingNumber = trackingNumber;
  if (carrier) order.delivery.carrier = carrier;
  if (notes) order.delivery.notes = notes;
  order.delivery.status = "delivered";
  order.delivery.deliveredAt = new Date();

  const by = req.panelUser?.email || "Admin";
  addTimeline(order, `Order marked as fulfilled`, by, trackingNumber ? `Tracking: ${trackingNumber}` : undefined);

  await order.save();

  res.json({ success: true, data: { order } });
});

exports.refundOrder = catchAsync(async (req, res, next) => {
  const { amount, reason, partial, restockItems } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError("Order not found", 404));

  if (!amount || amount <= 0) return next(new AppError("Refund amount must be greater than 0", 400));
  if (amount > order.pricing.total) return next(new AppError("Refund amount cannot exceed order total", 400));

  if (order.payment?.stripePaymentIntentId) {
    try {
      await stripe.refunds.create({
        payment_intent: order.payment.stripePaymentIntentId,
        amount: Math.round(amount * 100),
      });
    } catch (stripeErr) {
      return next(new AppError(`Stripe refund failed: ${stripeErr.message}`, 400));
    }
  }

  const isPartial = partial || amount < order.pricing.total;

  order.status = isPartial ? "partially_refunded" : "refunded";
  order.payment.status = "refunded";
  order.refundAmount = (order.refundAmount || 0) + amount;
  order.refundReason = reason || "";
  order.refundedAt = new Date();

  if (restockItems) {
    for (const item of order.items) {
      if (item.product) {
        await Product.findOneAndUpdate(
          { _id: item.product, stock: { $gte: 0 } },
          { $inc: { stock: item.quantity }, outOfStock: false }
        );
      }
    }
  }

  const by = req.panelUser?.email || "Admin";
  const details = `$${amount.toFixed(2)} refunded via Stripe${reason ? ` — Reason: ${reason}` : ""}${restockItems ? " — Inventory restocked" : ""}`;
  addTimeline(order, isPartial ? "Partial refund issued" : "Order refunded", by, details);

  await order.save();

  sendRefundEmail({
    to: order.customer.email,
    orderNumber: order.orderNumber,
    amount,
    reason: reason || "",
    items: order.items.map(i => ({ name: i.productSnapshot?.name || "Item", quantity: i.quantity })),
    robloxUsername: order.customer.robloxUsername,
  }).catch(() => {});

  res.json({
    success: true,
    data: {
      order,
      refundAmount: amount,
      isPartial,
      message: `Refund of $${amount.toFixed(2)} processed successfully`,
    },
  });
});

exports.addTimeline = catchAsync(async (req, res, next) => {
  const { action, details } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError("Order not found", 404));

  const by = req.panelUser?.email || "Admin";
  addTimeline(order, action || "Note added", by, details);
  await order.save();

  res.json({ success: true, data: { order } });
});

exports.updateTags = catchAsync(async (req, res, next) => {
  const { tags } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError("Order not found", 404));

  order.tags = Array.isArray(tags) ? tags : [];
  await order.save();

  res.json({ success: true, data: { order } });
});

exports.bulkUpdateStatus = catchAsync(async (req, res, next) => {
  const { orderIds, ids, status } = req.body;
  const idList = orderIds || ids;
  if (!Array.isArray(idList) || idList.length === 0) return next(new AppError("orderIds must be a non-empty array", 400));

  if (!VALID_STATUSES.includes(status)) return next(new AppError("Invalid status", 400));

  const result = await Order.updateMany(
    { _id: { $in: idList } },
    {
      $set: { status },
      $push: { timeline: { action: `Bulk status update to "${status}"`, by: req.panelUser?.email || "Admin", timestamp: new Date() } },
    }
  );

  res.json({ success: true, message: `Updated ${result.modifiedCount} orders`, data: { modified: result.modifiedCount } });
});

exports.getClaimChat = catchAsync(async (req, res, next) => {
  const { orderId } = req.params;
  const order = await Order.findById(orderId).select("orderNumber");
  if (!order) return next(new AppError("Order not found", 404));

  const claim = await ClaimSession.findOne({ orderRef: order.orderNumber });
  if (!claim) return next(new AppError("No claim session found for this order", 404));

  res.json({ success: true, data: { claimSession: claim } });
});
