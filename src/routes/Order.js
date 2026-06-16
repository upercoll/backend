const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  productSnapshot: {
    name: String,
    price: Number,
    originalPrice: Number,
    game: String,
    gradient: { from: String, to: String },
    imageUrl: String,
  },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true },
  totalPrice: { type: Number, required: true },
});

const timelineEventSchema = new mongoose.Schema({
  action: { type: String, required: true },
  by: { type: String, default: "System" },
  details: { type: String },
  timestamp: { type: Date, default: Date.now },
});

const orderSchema = new mongoose.Schema(
  {
    orderNumber: {
      type: String,
      unique: true,
      required: true,
    },

    customer: {
      email: { type: String, required: true, lowercase: true, trim: true },
      robloxUsername: { type: String, required: true, trim: true },
      shippingAddress: {
        line1: String,
        line2: String,
        city: String,
        state: String,
        postalCode: String,
        country: String,
      },
      billingAddress: {
        name: String,
        line1: String,
        line2: String,
        city: String,
        state: String,
        postalCode: String,
        country: String,
      },
    },

    items: [orderItemSchema],

    pricing: {
      subtotal: { type: Number, required: true },
      discount: { type: Number, default: 0 },
      discountPercent: { type: Number, default: 0 },
      promoCode: { type: String },
      total: { type: Number, required: true },
    },

    payment: {
      method: { type: String, enum: ["card", "paypal"], required: true },
      status: {
        type: String,
        enum: ["pending", "processing", "succeeded", "failed", "refunded"],
        default: "pending",
      },
      stripePaymentIntentId: { type: String },
      stripePaymentMethodId: { type: String },
      paypalOrderId: { type: String },
      paidAt: { type: Date },
      failureReason: { type: String },
    },

    delivery: {
      status: {
        type: String,
        enum: ["pending", "in_progress", "delivered", "failed"],
        default: "pending",
      },
      deliveredAt: { type: Date },
      notes: { type: String },
      trackingNumber: { type: String },
      carrier: { type: String },
    },

    status: {
      type: String,
      enum: ["pending", "paid", "delivering", "completed", "cancelled", "refunded", "fulfilled", "partially_refunded"],
      default: "pending",
    },

    refundAmount: { type: Number, default: 0 },
    refundReason: { type: String },
    refundedAt: { type: Date },

    fulfillmentStatus: {
      type: String,
      enum: ["unfulfilled", "partial", "fulfilled"],
      default: "unfulfilled",
    },
    fulfilledAt: { type: Date },
    fulfilledBy: { type: String },

    tags: [{ type: String }],
    notes: { type: String },
    ipAddress: { type: String },
    userAgent: { type: String },
    adminNotes: { type: String },
    source: { type: String, default: "Online Store" },

    timeline: [timelineEventSchema],

    customerOrderCount: { type: Number, default: 1 },
    riskLevel: { type: String, enum: ["low", "medium", "high"], default: "low" },
  },
  { timestamps: true }
);

orderSchema.index({ "customer.email": 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ "payment.stripePaymentIntentId": 1 });
orderSchema.index({ createdAt: -1 });
orderSchema.index({ orderNumber: 1 });

orderSchema.pre("validate", async function (next) {
  if (!this.orderNumber) {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
    this.orderNumber = `RB-${ts}-${rand}`;
  }
  next();
});

module.exports = mongoose.model("Order", orderSchema);
