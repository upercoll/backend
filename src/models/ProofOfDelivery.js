const mongoose = require("mongoose");

const proofOfDeliverySchema = new mongoose.Schema(
  {
    claimSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ClaimSession",
      required: true,
    },
    roomId: { type: String, required: true },
    orderRef: { type: String, trim: true },
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TeamMember",
      required: true,
    },
    agentName: { type: String, trim: true },
    proofImageUrl: { type: String },
    proofImagePublicId: { type: String },
    proofImageUrls: [{ type: String }],
    proofImagePublicIds: [{ type: String }],
    estimatedDelivery: { type: String, trim: true, required: true },
    notes: { type: String, trim: true, maxlength: 500 },
    customerEmail: { type: String, lowercase: true, trim: true },
    robloxUsername: { type: String, trim: true },
    game: { type: String, trim: true },
    viewedByOwner: { type: Boolean, default: false },
    viewedAt: { type: Date },
    ownerNotes: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

proofOfDeliverySchema.index({ agentId: 1, createdAt: -1 });
proofOfDeliverySchema.index({ viewedByOwner: 1 });
proofOfDeliverySchema.index({ roomId: 1 });

module.exports = mongoose.model("ProofOfDelivery", proofOfDeliverySchema);
