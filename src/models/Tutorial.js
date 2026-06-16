const mongoose = require("mongoose");

const tutorialSchema = new mongoose.Schema(
  {
    game: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    videoUrl: { type: String, trim: true },
    thumbnailUrl: { type: String, trim: true },
    gradient: {
      from: { type: String, default: "#6d28d9" },
      to: { type: String, default: "#4c1d95" },
    },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

tutorialSchema.index({ game: 1, active: 1 });

module.exports = mongoose.model("Tutorial", tutorialSchema);
