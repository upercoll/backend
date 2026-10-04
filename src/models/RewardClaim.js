const mongoose = require("mongoose");

/**
 * A reward issued to a customer by the Daily Spin wheel or by reaching a
 * Level Rewards milestone. Each claim points at the one-time PromoCode it
 * created, so the customer can (re)copy their code and the backend can
 * prove what was issued.
 *
 * The (customer, kind, key) unique index is the idempotency guard: a spin
 * can only happen once per UTC day per customer, and each level milestone
 * can only ever be claimed once — concurrent/duplicate requests hit the
 * index instead of double-issuing discount codes.
 */
const rewardClaimSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
    },
    kind: {
      type: String,
      enum: ["spin", "level"],
      required: true,
    },
    // spin  -> "spin:2026-10-02"  (one per UTC day)
    // level -> "level:15"         (one per milestone)
    key: {
      type: String,
      required: true,
    },
    prizeLabel: { type: String, required: true }, // "15% OFF"
    discountValue: { type: Number, required: true },
    promoCode: { type: String, required: true, uppercase: true, trim: true },
    promo: { type: mongoose.Schema.Types.ObjectId, ref: "PromoCode" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

rewardClaimSchema.index({ customer: 1, kind: 1, key: 1 }, { unique: true });

module.exports = mongoose.model("RewardClaim", rewardClaimSchema);
