const stripe = require("../config/stripe");
const Order = require("../models/Order");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");

async function resolveCartItems(cartItems) {
  if (!Array.isArray(cartItems) || cartItems.length === 0) {
    throw new AppError("Cart is empty", 400);
  }

  const ids = cartItems.map((i) => i.id);
  const products = await Product.find({
    $or: [{ _id: { $in: ids } }, { slug: { $in: ids } }],
    active: true,
  });

  const resolvedItems = [];
  let subtotal = 0;

  for (const cartItem of cartItems) {
    const product = products.find(
      (p) => p._id.toString() === cartItem.id || p.slug === cartItem.id
    );

    if (!product) throw new AppError(`Product not found: ${cartItem.id}`, 400);
    if (product.outOfStock) throw new AppError(`"${product.name}" is out of stock`, 400);

    const qty = Math.max(1, parseInt(cartItem.quantity) || 1);
    const unitPrice = product.price;
    const lineTotal = unitPrice * qty;
    subtotal += lineTotal;

    resolvedItems.push({
      product: product._id,
      productSnapshot: {
        name: product.name,
        price: product.price,
        originalPrice: product.originalPrice,
        game: product.game,
        gradient: product.gradient,
      },
      quantity: qty,
      unitPrice,
      totalPrice: lineTotal,
    });
  }

  const discountPercent = 10;
  const discount = Math.round(subtotal * (discountPercent / 100) * 100) / 100;
  const total = Math.round((subtotal - discount) * 100) / 100;

  return { resolvedItems, subtotal, discount, discountPercent, total };
}

exports.createPaymentIntent = catchAsync(async (req, res, next) => {
  const { cartItems, customer, paymentMethodId } = req.body;

  if (!customer?.email || !customer?.robloxUsername) {
    return next(new AppError("Email and Roblox username are required", 400));
  }

  const { resolvedItems, subtotal, discount, discountPercent, total } =
    await resolveCartItems(cartItems);

  const order = await Order.create({
    customer: {
      email: customer.email,
      robloxUsername: customer.robloxUsername,
    },
    items: resolvedItems,
    pricing: { subtotal, discount, discountPercent, total },
    payment: { method: "card", status: "pending" },
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  const intent = await stripe.paymentIntents.create({
    amount: Math.round(total * 100),
    currency: "usd",
    payment_method: paymentMethodId,
    confirm: false,
    automatic_payment_methods: { enabled: false },
    payment_method_types: ["card"],
    metadata: {
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      robloxUsername: customer.robloxUsername,
      email: customer.email,
    },
    receipt_email: customer.email,
    description: `RBstars order ${order.orderNumber}`,
  });

  order.payment.stripePaymentIntentId = intent.id;
  await order.save();

  res.json({
    success: true,
    data: {
      clientSecret: intent.client_secret,
      orderId: order._id,
      orderNumber: order.orderNumber,
      total,
    },
  });
});

exports.confirmPayment = catchAsync(async (req, res, next) => {
  const { paymentIntentId } = req.body;
  if (!paymentIntentId) return next(new AppError("paymentIntentId is required", 400));

  const intent = await stripe.paymentIntents.retrieve(paymentIntentId);
  const order = await Order.findOne({ "payment.stripePaymentIntentId": paymentIntentId });

  if (!order) return next(new AppError("Order not found", 404));

  if (intent.status === "succeeded") {
    order.payment.status = "succeeded";
    order.payment.paidAt = new Date();
    order.status = "paid";
    order.delivery.status = "in_progress";
    await order.save();

    order.items.forEach(({ product, quantity }) => {
      Product.findByIdAndUpdate(product, { $inc: { salesCount: quantity } }).catch(() => {});
    });

    return res.json({
      success: true,
      data: { orderNumber: order.orderNumber, status: "succeeded" },
    });
  }

  res.json({ success: true, data: { status: intent.status, orderNumber: order.orderNumber } });
});

exports.createPaypalOrder = catchAsync(async (req, res, next) => {
  const { cartItems, customer } = req.body;

  if (!customer?.email || !customer?.robloxUsername) {
    return next(new AppError("Email and Roblox username are required", 400));
  }

  const { resolvedItems, subtotal, discount, discountPercent, total } =
    await resolveCartItems(cartItems);

  const order = await Order.create({
    customer: { email: customer.email, robloxUsername: customer.robloxUsername },
    items: resolvedItems,
    pricing: { subtotal, discount, discountPercent, total },
    payment: { method: "paypal", status: "pending" },
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  res.json({
    success: true,
    data: {
      orderId: order._id,
      orderNumber: order.orderNumber,
      total,

    },
  });
});

exports.capturePaypalPayment = catchAsync(async (req, res, next) => {
  const { orderId, paypalOrderId } = req.body;

  const order = await Order.findById(orderId);
  if (!order) return next(new AppError("Order not found", 404));

  order.payment.status = "succeeded";
  order.payment.paypalOrderId = paypalOrderId;
  order.payment.paidAt = new Date();
  order.status = "paid";
  order.delivery.status = "in_progress";
  await order.save();

  res.json({
    success: true,
    data: { orderNumber: order.orderNumber, status: "succeeded" },
  });
});

exports.webhook = catchAsync(async (req, res, next) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    logger.warn(`Webhook signature failed: ${err.message}`);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  const intent = event.data.object;

  switch (event.type) {
    case "payment_intent.succeeded": {
      const order = await Order.findOne({ "payment.stripePaymentIntentId": intent.id });
      if (order && order.payment.status !== "succeeded") {
        order.payment.status = "succeeded";
        order.payment.paidAt = new Date();
        order.status = "paid";
        order.delivery.status = "in_progress";
        await order.save();
        logger.info(`Order paid via webhook: ${order.orderNumber}`);
      }
      break;
    }
    case "payment_intent.payment_failed": {
      const order = await Order.findOne({ "payment.stripePaymentIntentId": intent.id });
      if (order) {
        order.payment.status = "failed";
        order.payment.failureReason = intent.last_payment_error?.message;
        order.status = "cancelled";
        await order.save();
        logger.warn(`Payment failed: ${order.orderNumber}`);
      }
      break;
    }
    default:
      logger.debug(`Unhandled webhook event: ${event.type}`);
  }

  res.json({ received: true });
});
