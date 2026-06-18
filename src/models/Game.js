const mongoose = require("mongoose");

const gameSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: { type: String, trim: true, maxlength: 500 },
    imageUrl: { type: String },
    imagePublicId: { type: String },
    bannerUrl: { type: String },
    bannerPublicId: { type: String },
    gradient: {
      from: { type: String, default: "#1e3a5f" },
      to: { type: String, default: "#0f172a" },
    },
    active: { type: Boolean, default: true },
    featured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
    claimTeam: { type: String, trim: true },
    totalProducts: { type: Number, default: 0 },
    totalSales: { type: Number, default: 0 },
    claimTime: { type: Number, default: 0 },
    claimSchedule: [{
      label: { type: String, default: "" },
      from: { type: String },
      to: { type: String },
      minutes: { type: Number, default: 0 },
    }],
  },
  { timestamps: true }
);

gameSchema.index({ active: 1, sortOrder: 1 });
gameSchema.index({ slug: 1 });

module.exports = mongoose.model("Game", gameSchema);
