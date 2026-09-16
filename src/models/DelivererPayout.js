const mongoose = require("mongoose");

const delivererPayoutSchema = new mongoose.Schema(
  {
    deliverer: { type: mongoose.Schema.Types.ObjectId, ref: "Deliverer", required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    revenue: { type: Number, default: 0 },
    deliveryCount: { type: Number, default: 0 }, // number of DeliveryRecords this payout touched
    records: [
      {
        record: { type: mongoose.Schema.Types.ObjectId, ref: "DeliveryRecord", required: true },
        amount: { type: Number, required: true, min: 0 },
      },
    ],
    remainingCommissionAfter: { type: Number, default: 0 },
    markedPaidBy: { type: String, default: "" },
    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

delivererPayoutSchema.index({ deliverer: 1, createdAt: -1 });

module.exports = mongoose.model("DelivererPayout", delivererPayoutSchema);
