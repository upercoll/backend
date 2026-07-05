const mongoose = require("mongoose");

const deliveryRecordSchema = new mongoose.Schema(
  {
    deliverer: { type: mongoose.Schema.Types.ObjectId, ref: "Deliverer", required: true, index: true },
    sessionId: { type: String, required: true }, // ClaimSession.roomId
    orderNumber: { type: String },               // ClaimSession.orderRef
    robloxUsername: { type: String },
    game: { type: String },
    items: [{ name: String, quantity: Number }],
    orderTotal: { type: Number, default: 0 },    // order.pricing.total
    commissionRate: { type: Number, required: true },
    commission: { type: Number, required: true }, // orderTotal * commissionRate / 100
    deliveredAt: { type: Date, default: Date.now },
    paidOut: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DeliveryRecord", deliveryRecordSchema);
