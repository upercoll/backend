const mongoose = require("mongoose");

const allocationSchema = new mongoose.Schema(
  {
    request: { type: mongoose.Schema.Types.ObjectId, ref: "StockRequest", required: true },
    stocker: { type: mongoose.Schema.Types.ObjectId, ref: "Stocker", required: true },
    quantity: { type: Number, required: true, min: 1 },
    unitRevenue: { type: Number, required: true, min: 0 },
    commissionRate: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const stockSaleSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    orderNumber: { type: String, required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true },
    quantity: { type: Number, required: true, min: 1 },
    customer: {
      robloxUsername: { type: String, default: "" },
      email: { type: String, default: "" },
    },
    allocations: [allocationSchema],
    deliveredAt: { type: Date },
    claimRoomId: { type: String },
  },
  { timestamps: true }
);

stockSaleSchema.index({ order: 1, product: 1 });
stockSaleSchema.index({ "allocations.stocker": 1, deliveredAt: -1 });

module.exports = mongoose.model("StockSale", stockSaleSchema);
