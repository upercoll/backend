const mongoose = require("mongoose");

const settingSchema = new mongoose.Schema(
  {
    salesTaxRate: { type: Number, default: 0, min: 0, max: 100 },
    taxLabel: { type: String, default: "Sales Tax", trim: true },
    taxEnabled: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Setting", settingSchema);
