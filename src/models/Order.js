const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  productSnapshot: {
    name: String,
    price: Number,
    originalPrice: Number,
    game: String,
    gradient: { from: String, to: String },
  },
  quantity: { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, required: true },
  totalPrice: { type: Number, required: true },
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
    },

    items: [orderItemSchema],

    pricing: {
      subtotal: { type: Number, required: true },
      discount: { type: Number, default: 0 },
      discountPercent: { type: Number, default: 0 },
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
    },

    status: {
      type: String,
      enum: ["pending", "paid", "delivering", "completed", "cancelled", "refunded"],
      default: "pending",
    },

    ipAddress: { type: String },
    userAgent: { type: String },
    refundReason: { type: String },
    adminNotes: { type: String },
  },
  { timestamps: true }
);

orderSchema.index({ "customer.email": 1 });
orderSchema.index({ status: 1 });
orderSchema.index({ "payment.stripePaymentIntentId": 1 });
orderSchema.index({ createdAt: -1 });

orderSchema.pre("validate", async function (next) {
  if (!this.orderNumber) {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
    this.orderNumber = `RB-${ts}-${rand}`;
  }
  next();
});

module.exports = mongoose.model("Order", orderSchema);
