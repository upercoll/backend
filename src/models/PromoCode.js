const mongoose = require("mongoose");

const promoCodeSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      maxlength: 30,
    },
    description: { type: String, trim: true },

    discountType: {
      type: String,
      enum: ["percent", "fixed"],
      required: true,
    },
    discountValue: {
      type: Number,
      required: true,
      min: 0,
    },

    minOrderValue: { type: Number, default: 0 },

    maxUses: { type: Number, default: null },
    usedCount: { type: Number, default: 0 },

    maxUsesPerUser: { type: Number, default: null },

    usedBy: [
      {
        email: String,
        usedAt: { type: Date, default: Date.now },
        orderId: mongoose.Schema.Types.ObjectId,
      },
    ],

    startsAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },

    active: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

promoCodeSchema.index({ active: 1 });

promoCodeSchema.virtual("isExpired").get(function () {
  const now = new Date();
  if (this.startsAt && now < this.startsAt) return true;
  if (this.expiresAt && now > this.expiresAt) return true;
  return false;
});

promoCodeSchema.virtual("isExhausted").get(function () {
  if (this.maxUses === null) return false;
  return this.usedCount >= this.maxUses;
});

module.exports = mongoose.model("PromoCode", promoCodeSchema);
