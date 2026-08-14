const mongoose = require("mongoose");

const autoBotLogItemSchema = new mongoose.Schema(
  {
    name: { type: String },
    quantity: { type: Number },
    category: { type: String },
    delivered: { type: Number },
  },
  { _id: false }
);

const autoBotLogSchema = new mongoose.Schema(
  {
    roomId: { type: String, trim: true },
    orderRef: { type: String, trim: true },
    robloxUsername: { type: String, trim: true },
    game: { type: String, trim: true },
    account: { type: String, trim: true, default: "AUTO BOT" },
    action: {
      type: String,
      enum: ["claim", "deliver", "complete", "error", "info"],
      required: true,
    },
    status: { type: String, default: "ok" },
    message: { type: String, maxlength: 2000 },
    items: [autoBotLogItemSchema],
  },
  { timestamps: true }
);

autoBotLogSchema.index({ createdAt: -1 });
autoBotLogSchema.index({ roomId: 1, createdAt: -1 });
autoBotLogSchema.index({ action: 1, createdAt: -1 });

module.exports = mongoose.model("AutoBotLog", autoBotLogSchema);