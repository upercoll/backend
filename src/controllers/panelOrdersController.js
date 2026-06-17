const Order = require("../models/Order");
const ClaimSession = require("../models/ClaimSession");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const stripe = require("../config/stripe");
const { sendCancellationEmail, sendRefundEmail } = require("../config/email");

const VALID_STATUSES = ["pending", "paid", "delivering", "completed", "cancelled", "refunded", "partially_refunded"];

function addTimeline(order, action, by, details) {
  if (!order.timeline) order.timeline = [];
  order.timeline.push({ action, by: by || "Admin", details, timestamp: new Date() });
}

exports.listOrders = catchAsync(async (req, res) => {
  const { status, payment, page = 1, limit = 20, search, game } = req.query;
  const filter = {};

  if (status) filter.status = status;
  if (payment) filter["payment.status"] = payment;
  if (!status && !payment && !search) {
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
    filter.$or = [
      { "payment.status": "succeeded" },
      { "payment.status": { $nin: ["failed", "pending"] } },
      { "payment.status": "pending", createdAt: { $gte: thirtyMinsAgo } },
    ];
  }
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

  const isPaid = order.payment && order.payment.status === "succeeded";

  if (status === "refunded" && !isPaid) {
    return next(new AppError("Cannot refund an order that has not been paid.", 400));
  }

  let stripeRefundAmount = null;
  if (status === "cancelled" && isPaid && order.payment.stripePaymentIntentId) {
    try {
      const refund = await stripe.refunds.create({
        payment_intent: order.payment.stripePaymentIntentId,
      });
      stripeRefundAmount = refund.amount / 100;
    } catch (stripeErr) {
      console.error("Stripe refund failed during cancellation:", stripeErr.message);
    }
  }

  const prevStatus = order.status;
  order.status = status;
  if (adminNotes !== undefined) order.adminNotes = adminNotes;

  if (status === "cancelled" && isPaid && stripeRefundAmount !== null) {
    order.payment.status = "refunded";
    order.refundAmount = stripeRefundAmount;
    order.refundedAt = new Date();
  }

  if (status === "completed" && prevStatus !== "completed") {
    order.fulfilledAt = new Date();
    order.fulfilledBy = req.panelUser?.email || "Admin";
  }

  const by = req.panelUser?.email || "Admin";
  const timelineDetails = status === "cancelled" && stripeRefundAmount !== null
    ? `Full refund of $${stripeRefundAmount.toFixed(2)} issued to customer`
    : undefined;
  addTimeline(order, `Status changed from "${prevStatus}" to "${status}"`, by, timelineDetails);

  await order.save();

  if (status === "cancelled") {
    try {
      await sendCancellationEmail({
        to: order.customer.email,
        orderNumber: order.orderNumber,
        amount: stripeRefundAmount,
        items: (order.items || []).map(item => ({
          name: item.productSnapshot?.name || "Item",
          quantity: item.quantity,
        })),
        robloxUsername: order.customer.robloxUsername,
      });
    } catch (emailErr) {
      console.error("Failed to send cancellation email:", emailErr.message);
    }
  }

  res.json({ success: true, data: { order } });
});

exports.fulfillOrder = catchAsync(async (req, res, next) => {
  const { trackingNumber, carrier, notes } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError("Order not found", 404));

  order.status = "completed";
  order.fulfilledAt = new Date();
  order.fulfilledBy = req.panelUser?.email || "Admin";

  if (trackingNumber) order.delivery.trackingNumber = trackingNumber;
  if (carrier) order.delivery.carrier = carrier;
  if (notes) order.delivery.notes = notes;
  order.delivery.status = "delivered";
  order.delivery.deliveredAt = new Date();

  const by = req.panelUser?.email || "Admin";
  addTimeline(order, `Order marked as completed`, by, trackingNumber ? `Tracking: ${trackingNumber}` : undefined);

  await order.save();

  res.json({ success: true, data: { order } });
});

exports.refundOrder = catchAsync(async (req, res, next) => {
  const { amount, reason, partial, restockItems } = req.body;
  const order = await Order.findById(req.params.id);
  if (!order) return next(new AppError("Order not found", 404));

  const isPaid = order.payment && order.payment.status === "succeeded";
  if (!isPaid) {
    return next(new AppError("Cannot refund an unpaid order. Only paid orders can be refunded.", 400));
  }

  if (!amount || amount <= 0) return next(new AppError("Refund amount must be greater than 0", 400));
  if (amount > order.pricing.total) return next(new AppError("Refund amount cannot exceed order total", 400));

  const isPartial = partial || amount < order.pricing.total;

  if (order.payment.stripePaymentIntentId) {
    try {
      await stripe.refunds.create({
        payment_intent: order.payment.stripePaymentIntentId,
        amount: Math.round(amount * 100),
      });
    } catch (stripeErr) {
      return next(new AppError(`Stripe refund failed: ${stripeErr.message}`, 500));
    }
  }

  const prevStatus = order.status;
  order.status = isPartial ? "partially_refunded" : "refunded";
  order.payment.status = "refunded";
  order.refundAmount = (order.refundAmount || 0) + amount;
  order.refundReason = reason || "";
  order.refundedAt = new Date();

  const by = req.panelUser?.email || "Admin";
  const details = `$${amount.toFixed(2)} refunded via Stripe${reason ? ` — Reason: ${reason}` : ""}${restockItems ? " — Inventory restocked" : ""}`;
  addTimeline(order, isPartial ? "Partial refund issued" : "Order refunded", by, details);

  await order.save();

  try {
    await sendRefundEmail({
      to: order.customer.email,
      orderNumber: order.orderNumber,
      amount,
      reason: reason || "",
      items: (order.items || []).map(item => ({
        name: item.productSnapshot?.name || "Item",
        quantity: item.quantity,
      })),
      robloxUsername: order.customer.robloxUsername,
    });
  } catch (emailErr) {
    console.error("Failed to send refund email:", emailErr.message);
  }

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

  if (status === "refunded" || status === "partially_refunded") {
    const unpaidOrders = await Order.find({ _id: { $in: idList }, "payment.status": { $ne: "succeeded" } }).countDocuments();
    if (unpaidOrders > 0) {
      return next(new AppError(`Cannot bulk ${status} orders that haven't been paid. Please filter to paid orders only.`, 400));
    }
  }

  const result = await Order.updateMany(
    { _id: { $in: idList } },
    {
      $set: { status },
      $push: { timeline: { action: `Bulk status update to "${status}"`, by: req.panelUser?.email || "Admin", timestamp: new Date() } },
    }
  );

  if (status === "cancelled") {
    try {
      const updatedOrders = await Order.find({ _id: { $in: idList } });
      for (const order of updatedOrders) {
        await sendCancellationEmail({
          to: order.customer.email,
          orderNumber: order.orderNumber,
          items: (order.items || []).map(item => ({
            name: item.productSnapshot?.name || "Item",
            quantity: item.quantity,
          })),
          robloxUsername: order.customer.robloxUsername,
        });
      }
    } catch (emailErr) {
      console.error("Failed to send bulk cancellation emails:", emailErr.message);
    }
  }

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
