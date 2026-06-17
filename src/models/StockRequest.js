const mongoose = require("mongoose");

const stockItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
  productName: { type: String, required: true },
  productSlug: { type: String },
  game: { type: String },
  imageUrl: { type: String },
  gradient: { from: String, to: String },
  quantity: { type: Number, required: true, min: 1 },
  salePrice: { type: Number, required: true },
  totalSaleValue: { type: Number, required: true },
});

const stockRequestSchema = new mongoose.Schema(
  {
    stocker: { type: mongoose.Schema.Types.ObjectId, ref: "Stocker", required: true },
    stockerName: { type: String },
    stockerEmail: { type: String },
    game: { type: String, required: true },
    items: [stockItemSchema],
    totalSaleValue: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "stocked", "rejected"],
      default: "pending",
    },
    adminNotes: { type: String },
    paymentAmount: { type: Number, default: 0 },
    paymentSent: { type: Boolean, default: false },
    commission: { type: Number, default: 0 },
    commissionRate: { type: Number, default: 0 },
    approvedAt: { type: Date },
    stockedAt: { type: Date },
    rejectedAt: { type: Date },
    stockedBy: { type: String },
  },
  { timestamps: true }
);

stockRequestSchema.index({ stocker: 1, status: 1 });
stockRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model("StockRequest", stockRequestSchema);
