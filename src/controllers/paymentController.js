const stripe = require("../config/stripe");
const Order = require("../models/Order");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const PromoCode = require("../models/PromoCode");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const logger = require("../utils/logger");
const { money, getTaxSettings, buildPricing } = require("../utils/tax");
const { sendOrderConfirmationEmail } = require("../config/email");
const {
  removeStock,
  addStock,
  allocateStockedBatches,
  rollbackStockedBatchAllocations,
} = require("../services/stockService");

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

    /* onHand is the live physical count: services/stockService.js decrements
       it when a sale is finalised and stockers refill it. `stock` is the
       older field — also auto-maintained, but still editable by hand in
       admin, so it drifts (some products sit at stock=0 with onHand=14).
       Checking `stock` alone refused orders the product page had just
       offered as available. Same rule the stocker panel already uses. */
    const available =
      typeof product.onHand === "number" && product.onHand >= 0 ? product.onHand : product.stock;

    if (typeof available === "number" && available !== -1 && qty > available) {
      if (available <= 0) throw new AppError(`"${product.name}" is out of stock`, 400);
      throw new AppError(`Only ${available} unit(s) of "${product.name}" available`, 400);
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

// ---------------------------------------------------------------------------
// Promo usage accounting.
//
// `usedCount` is INCREMENTED ATOMICALLY (a conditional findOneAndUpdate) the
// moment a checkout is created, NOT when the payment succeeds. Without this
// two concurrent checkouts both reading usedCount=0 on a maxUses=1 code would
// both pass `isExhausted` and both receive the discount — the owner hands out
// unlimited uses of a capped code.
//
// The reservation carries a unique id so it can be rolled back if the order or
// the Stripe intent fails, and so `markPromoUsed` can flip exactly that entry
// to "used" without counting it twice.
// ---------------------------------------------------------------------------
async function reservePromoUse(code, email) {
  const upper = String(code).toUpperCase().trim();
  const emailLower = String(email || "").toLowerCase();
  const now = new Date();
  const reservationId = require("crypto").randomUUID();

  let promo;
  try {
    promo = await PromoCode.findOneAndUpdate(
      {
        code: upper,
        active: true,
        $and: [
          { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
          { $or: [{ expiresAt: null }, { expiresAt: { $gte: now } }] },
          // global cap: usedCount must still be below maxUses (null = unlimited)
          { $or: [{ maxUses: null }, { $expr: { $lt: ["$usedCount", "$maxUses"] } }] },
          // per-customer cap: only entries already on THIS reservation count
          {
            $or: [
              { maxUsesPerUser: null },
              {
                $expr: {
                  $lt: [
                    {
                      $size: {
                        $filter: {
                          input: { $ifNull: ["$usedBy", []] },
                          as: "u",
                          cond: { $eq: [{ $toLower: { $ifNull: ["$$u.email", ""] } }, emailLower] },
                        },
                      },
                    },
                    "$maxUsesPerUser",
                  ],
                },
              },
            ],
          },
        ],
      },
      {
        $inc: { usedCount: 1 },
        $push: { usedBy: { email: emailLower, usedAt: now, reservationId, reserved: true } },
      },
      { new: true }
    );
  } catch (err) {
    // Never let a Mongo query-shape problem take checkout down. Returning null
    // means "no reservation" — markPromoUsed then falls back to the legacy
    // deferred counting path.
    logger.warn(`Promo reservation unavailable for ${upper}: ${err.message} — deferring count`);
    return null;
  }

  if (!promo) throw new AppError("This promo code has reached its usage limit", 400);
  return reservationId;
}

// Give a reserved use back (checkout failed after the promo was counted).
async function releasePromoUse(code, reservationId) {
  if (!code || !reservationId) return;
  try {
    await PromoCode.updateOne(
      { code: String(code).toUpperCase().trim(), usedCount: { $gt: 0 } },
      { $inc: { usedCount: -1 }, $pull: { usedBy: { reservationId } } }
    );
  } catch (err) {
    logger.warn(`Failed to release promo reservation ${code}: ${err.message}`);
  }
}

// Record WHICH order consumed the reservation. The count was already taken by
// reservePromoUse — no second $inc here, otherwise maxUses is double-spent.
async function markPromoUsed(promoCode, email, orderId, reservationId) {
  if (!promoCode) return;
  try {
    if (reservationId) {
      await PromoCode.updateOne(
        { code: String(promoCode).toUpperCase().trim(), "usedBy.reservationId": reservationId },
        { $set: { "usedBy.$.reserved": false, "usedBy.$.orderId": orderId, "usedBy.$.usedAt": new Date() } }
      );
      return;
    }
    // Legacy path (no reservation id): count it once, deferred. Bounded by the
    // read-side isExhausted() check in applyPromoCode.
    await PromoCode.findOneAndUpdate(
      { code: String(promoCode).toUpperCase().trim() },
      {
        $inc: { usedCount: 1 },
        $push: { usedBy: { email, orderId, usedAt: new Date() } },
      }
    );
  } catch (err) {
    logger.warn(`Failed to mark promo ${promoCode} as used: ${err.message}`);
  }
}

/** Socket is optional — never let a broadcast failure fail a paid order. */
function tryGetIO() {
  try {
    return require("../config/socket").getIO();
  } catch {
    return null;
  }
}

/**
 * Tell every connected panel that money just came in.
 *
 * `finalizePaidOrder` is the single atomic winner for an order, so emitting
 * here means exactly one `admin:new_order` per paid order (the webhook and the
 * client-side confirm both race for the same lock — only one gets through).
 */
function broadcastNewOrder(order) {
  try {
    const io = tryGetIO();
    if (!io) return;
    io.to("order-alerts").emit("admin:new_order", {
      orderId: String(order._id),
      orderNumber: order.orderNumber,
      total: order.pricing?.total ?? 0,
      tax: order.pricing?.tax ?? 0,
      itemCount: (order.items || []).reduce((n, i) => n + (i.quantity || 0), 0),
      customerEmail: order.customer?.email || "",
      robloxUsername: order.customer?.robloxUsername || "",
      createdAt: order.createdAt,
    });
  } catch (err) {
    logger.warn("Failed to broadcast new order:", err.message);
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
    tax: order.pricing.tax || 0,
    taxLabel: order.pricing.taxLabel || "",
    robloxUsername: order.customer.robloxUsername,
    claimUrl: frontendUrl,
  }).catch((err) => logger.warn("Order confirmation email failed:", err.message));
}

async function finalizePaidOrder(order) {
  // Atomically claim this order for finalization. Stripe's webhook and the
  // client-side confirmPayment call can both arrive for the same order at
  // nearly the same time; without this guard both would pass the caller's
  // "not already succeeded" check and each would independently decrement
  // stock and allocate stocker batches for the same order — double-counting
  // sales, overstating stocker commissions, and undercounting inventory.
  // "processing" acts as a lock: only one caller can win this update.
  const previousPaymentStatus = order.payment.status;
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, "payment.status": { $nin: ["succeeded", "processing"] } },
    { $set: { "payment.status": "processing" } },
    { new: true }
  );
  if (!claimed) return null; // already finalized, or a concurrent request is finalizing it right now
  order = claimed;

  const decrementedItems = [];
  try {
    for (const item of order.items) {
      const product = await removeStock(item.product, item.quantity);
      if (!product) {
        await Promise.all(decrementedItems.map((previousItem) => addStock(previousItem.product, previousItem.quantity)));
        throw new AppError(
          `"${item.productSnapshot?.name || "Item"}" no longer has enough stock to fulfill this order`,
          409
        );
      }
      decrementedItems.push(item);
    }

    try {
      await allocateStockedBatches(order);
    } catch (error) {
      await Promise.all(decrementedItems.map((item) => addStock(item.product, item.quantity)));
      await rollbackStockedBatchAllocations(order._id);
      throw error;
    }
  } catch (error) {
    // Release the lock so a later retry (e.g. re-running syncStripePayments,
    // or Stripe redelivering the webhook) can attempt finalization again
    // instead of being stuck on "processing" forever.
    await Order.updateOne({ _id: order._id }, { $set: { "payment.status": previousPaymentStatus } });
    throw error;
  }

  order.payment.status = "succeeded";
  order.payment.paidAt = new Date();
  order.status = "paid";
  order.set("delivery.status", "in_progress");
  await order.save();

  // Panel-wide "new order" alert (sound + toast on every open admin page).
  broadcastNewOrder(order);

  // Update customer totalSpent for level system
  try {
    if (order.customer?.email && order.pricing?.total > 0) {
      await Customer.findOneAndUpdate(
        { email: order.customer.email },
        { $inc: { totalSpent: order.pricing.total } },
        { new: false }
      );
    }
  } catch (err) {
    logger.error("Failed to update customer totalSpent:", err);
  }

  return order;
}

exports.finalizePaidOrder = finalizePaidOrder;

exports.createPaymentIntent = catchAsync(async (req, res, next) => {
  const { cartItems, customer, paymentMethodId, promoCode } = req.body;

  if (!customer?.email || !customer?.robloxUsername) {
    return next(new AppError("Email and Roblox username are required", 400));
  }

  const { resolvedItems, subtotal } = await resolveCartItems(cartItems);
  const { discount, discountPercent, promoCode: validatedCode } = await applyPromoCode(
    promoCode,
    subtotal,
    customer.email
  );

  // Tax is resolved and applied SERVER-SIDE from the stored rate, on top of the
  // discounted amount. The browser only displays it — it can never influence
  // what is charged.
  const taxSettings = await getTaxSettings();
  const pricing = buildPricing({ subtotal, discount, tax: taxSettings });
  const total = pricing.total;

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

  // Reserve the promo use AFTER the duplicate-intent short-circuit, so retrying
  // a checkout never burns a second use of the same code.
  const promoReservation = validatedCode
    ? await reservePromoUse(validatedCode, customer.email)
    : null;

  let order;
  let intent;
  try {
    order = await Order.create({
      customer: {
        email: customer.email,
        robloxUsername: customer.robloxUsername,
      },
      items: resolvedItems,
      pricing: { ...pricing, discountPercent },
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

    intent = await stripe.paymentIntents.create(intentParams);

    order.payment.stripePaymentIntentId = intent.id;
    await order.save();
  } catch (err) {
    // Checkout died after we counted the use — give it back so a failed
    // payment can't quietly burn through a capped promo code.
    await releasePromoUse(validatedCode, promoReservation);
    throw err;
  }

  if (validatedCode) {
    await markPromoUsed(validatedCode, customer.email, order._id, promoReservation);
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

    const finalizedOrder = await finalizePaidOrder(order);
    if (!finalizedOrder) {
      // A concurrent call (e.g. Stripe's webhook, arriving around the same
      // moment) already finalized this order — don't process it again.
      return res.json({
        success: true,
        data: { orderNumber: order.orderNumber, status: "succeeded", alreadyProcessed: true },
      });
    }

    fireOrderConfirmationEmail(finalizedOrder);

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
  const { discount, discountPercent, promoCode: validatedCode } = await applyPromoCode(
    promoCode,
    subtotal,
    customer.email
  );

  // Tax is resolved and applied SERVER-SIDE from the stored rate, on top of the
  // discounted amount. The browser only displays it — it can never influence
  // what is charged.
  const taxSettings = await getTaxSettings();
  const pricing = buildPricing({ subtotal, discount, tax: taxSettings });
  const total = pricing.total;

  const promoReservation = validatedCode
    ? await reservePromoUse(validatedCode, customer.email)
    : null;

  let order;
  let intent;
  try {
    order = await Order.create({
      customer: { email: customer.email, robloxUsername: customer.robloxUsername },
      items: resolvedItems,
      pricing: { ...pricing, discountPercent },
      payment: { method: "paypal", status: "pending" },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    intent = await stripe.paymentIntents.create({
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
  } catch (err) {
    await releasePromoUse(validatedCode, promoReservation);
    throw err;
  }

  if (validatedCode) {
    await markPromoUsed(validatedCode, customer.email, order._id, promoReservation);
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
        const finalizedOrder = await finalizePaidOrder(order);
        if (finalizedOrder) {
          logger.info(`Order paid via webhook: ${order.orderNumber}`);
          fireOrderConfirmationEmail(finalizedOrder);
        }
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
