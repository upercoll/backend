const stripe = require("../config/stripe");
const Order = require("../models/Order");
const Product = require("../models/Product");
const PromoCode = require("../models/PromoCode");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");
const { sendOrderConfirmationEmail } = require("../config/email");

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

    if (product.stock !== -1 && qty > product.stock) {
      if (product.stock <= 0) throw new AppError(`"${product.name}" is out of stock`, 400);
      throw new AppError(`Only ${product.stock} unit(s) of "${product.name}" available`, 400);
    }
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

  return { resolvedItems, subtotal };
}

async function applyPromoCode(code, subtotal, email) {
  if (!code) {
    return { discount: 0, discountPercent: 0, total: subtotal, promoCode: null };
  }

  const promo = await PromoCode.findOne({ code: code.toString().toUpperCase().trim(), active: true });
  if (!promo) throw new AppError("Invalid or expired promo code", 400);
  if (promo.isExpired) throw new AppError("This promo code has expired", 400);
  if (promo.isExhausted) throw new AppError("This promo code has reached its usage limit", 400);
  if (subtotal < (promo.minOrderValue || 0)) {
    throw new AppError(`Minimum order value for this promo code is $${promo.minOrderValue}`, 400);
  }
  if (promo.maxUsesPerUser) {
    const timesUsed = (promo.usedBy || []).filter(
      (u) => u.email && u.email.toLowerCase() === email.toLowerCase()
    ).length;
    if (timesUsed >= promo.maxUsesPerUser) {
      throw new AppError("You have already used this promo code", 400);
    }
  }

  let discount = 0;
  let discountPercent = 0;

  if (promo.discountType === "percent") {
    discountPercent = promo.discountValue;
    discount = Math.round(subtotal * (discountPercent / 100) * 100) / 100;
  } else {
    discount = Math.min(promo.discountValue, subtotal);
  }

  const total = Math.round((subtotal - discount) * 100) / 100;
  return { discount, discountPercent, total, promoCode: promo.code, promoId: promo._id };
}

async function markPromoUsed(promoCode, email, orderId) {
  if (!promoCode) return;
  try {
    await PromoCode.findOneAndUpdate(
      { code: promoCode.toUpperCase() },
      {
        $inc: { usedCount: 1 },
        $push: { usedBy: { email, orderId, usedAt: new Date() } },
      }
    );
  } catch (err) {
    logger.warn(`Failed to mark promo ${promoCode} as used: ${err.message}`);
  }
}

function fireOrderConfirmationEmail(order) {
  const frontendUrl = process.env.FRONTEND_URL || "https://rbstars.gg";
  sendOrderConfirmationEmail({
    to: order.customer.email,
    orderNumber: order.orderNumber,
    items: order.items.map((i) => ({
      name: i.productSnapshot?.name || "Item",
      quantity: i.quantity,
      unitPrice: i.unitPrice,
    })),
    total: order.pricing.total,
    robloxUsername: order.customer.robloxUsername,
    claimUrl: frontendUrl,
  }).catch((err) => logger.warn("Order confirmation email failed:", err.message));
}

exports.createPaymentIntent = catchAsync(async (req, res, next) => {
  const { cartItems, customer, paymentMethodId, promoCode } = req.body;

  if (!customer?.email || !customer?.robloxUsername) {
    return next(new AppError("Email and Roblox username are required", 400));
  }

  const { resolvedItems, subtotal } = await resolveCartItems(cartItems);
  const { discount, discountPercent, total, promoCode: validatedCode } = await applyPromoCode(
    promoCode,
    subtotal,
    customer.email
  );

  const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000);
  const recentDupe = await Order.findOne({
    "customer.email": customer.email.toLowerCase().trim(),
    "payment.status": "pending",
    "pricing.total": total,
    createdAt: { $gte: fifteenMinAgo },
  }).sort({ createdAt: -1 });

  if (recentDupe && recentDupe.payment.stripePaymentIntentId) {
    try {
      const existingIntent = await stripe.paymentIntents.retrieve(recentDupe.payment.stripePaymentIntentId);
      if (["requires_payment_method", "requires_confirmation", "requires_action"].includes(existingIntent.status)) {
        return res.json({
          success: true,
          data: {
            clientSecret: existingIntent.client_secret,
            orderId: recentDupe._id,
            orderNumber: recentDupe.orderNumber,
            total,
          },
        });
      }
    } catch {}
  }

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

  const intentParams = {
    amount: Math.round(total * 100),
    currency: "usd",
    confirm: false,
    metadata: {
      orderId: order._id.toString(),
      orderNumber: order.orderNumber,
      robloxUsername: customer.robloxUsername,
      email: customer.email,
    },
    receipt_email: customer.email,
    description: `RBstars order ${order.orderNumber}`,
  };

  if (paymentMethodId) {
    intentParams.payment_method = paymentMethodId;
    intentParams.automatic_payment_methods = { enabled: false };
    intentParams.payment_method_types = ["card"];
  } else {
    intentParams.automatic_payment_methods = { enabled: true };
  }

  const intent = await stripe.paymentIntents.create(intentParams);

  order.payment.stripePaymentIntentId = intent.id;
  await order.save();

  if (validatedCode) {
    await markPromoUsed(validatedCode, customer.email, order._id);
  }

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
    if (order.payment.status === "succeeded") {
      return res.json({
        success: true,
        data: { orderNumber: order.orderNumber, status: "succeeded", alreadyProcessed: true },
      });
    }

    order.payment.status = "succeeded";
    order.payment.paidAt = new Date();
    order.status = "paid";
    order.set("delivery.status", "in_progress");
    await order.save();

    order.items.forEach(({ product, quantity }) => {
      Product.findByIdAndUpdate(product, { $inc: { salesCount: quantity } }).catch(() => {});
      // Only decrement finite stock (stock !== -1) and only if enough remains (atomic guard)
      Product.findOneAndUpdate(
        { _id: product, stock: { $gte: quantity } },
        { $inc: { stock: -quantity } },
        { new: true }
      ).then(p => {
        if (p && p.stock <= 0) Product.findByIdAndUpdate(p._id, { outOfStock: true }).catch(() => {});
      }).catch(() => {});
    });

    fireOrderConfirmationEmail(order);

    return res.json({
      success: true,
      data: { orderNumber: order.orderNumber, status: "succeeded" },
    });
  }

  res.json({ success: true, data: { status: intent.status, orderNumber: order.orderNumber } });
});

exports.createPaypalPaymentIntent = catchAsync(async (req, res, next) => {
  const { cartItems, customer, promoCode } = req.body;

  if (!customer?.email || !customer?.robloxUsername) {
    return next(new AppError("Email and Roblox username are required", 400));
  }

  const { resolvedItems, subtotal } = await resolveCartItems(cartItems);
  const { discount, discountPercent, total, promoCode: validatedCode } = await applyPromoCode(
    promoCode,
    subtotal,
    customer.email
  );

  const order = await Order.create({
    customer: { email: customer.email, robloxUsername: customer.robloxUsername },
    items: resolvedItems,
    pricing: { subtotal, discount, discountPercent, total },
    payment: { method: "paypal", status: "pending" },
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });

  const intent = await stripe.paymentIntents.create({
    amount: Math.round(total * 100),
    currency: "usd",
    payment_method_types: ["paypal"],
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

  if (validatedCode) {
    await markPromoUsed(validatedCode, customer.email, order._id);
  }

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
        order.set("delivery.status", "in_progress");
        await order.save();
        order.items.forEach(({ product, quantity }) => {
          Product.findByIdAndUpdate(product, { $inc: { salesCount: quantity } }).catch(() => {});
          // Only decrement finite stock (stock !== -1) and only if enough remains (atomic guard)
          Product.findOneAndUpdate(
            { _id: product, stock: { $gte: quantity } },
            { $inc: { stock: -quantity } },
            { new: true }
          ).then(p => {
            if (p && p.stock <= 0) Product.findByIdAndUpdate(p._id, { outOfStock: true }).catch(() => {});
          }).catch(() => {});
        });
        logger.info(`Order paid via webhook: ${order.orderNumber}`);
        fireOrderConfirmationEmail(order);
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
