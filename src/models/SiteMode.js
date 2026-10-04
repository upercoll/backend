const mongoose = require("mongoose");

const siteModeSchema = new mongoose.Schema(
  {
    halloween: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SiteMode", siteModeSchema);
