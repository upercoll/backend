const mongoose = require("mongoose");

const stockerPayoutSchema = new mongoose.Schema(
  {
    stocker: { type: mongoose.Schema.Types.ObjectId, ref: "Stocker", required: true },
    amount: { type: Number, required: true, min: 0 },
    commissionRate: { type: Number, default: 0 },
    deliveryCount: { type: Number, default: 0 },
    periodStart: { type: Date },
    periodEnd: { type: Date },
    notes: { type: String, trim: true, default: "" },
    markedPaidBy: { type: String, default: "" },
    cryptoAddress: { type: String, default: "" },
    cryptoNetwork: { type: String, default: "" },
  },
  { timestamps: true }
);

stockerPayoutSchema.index({ stocker: 1, createdAt: -1 });

module.exports = mongoose.model("StockerPayout", stockerPayoutSchema);
