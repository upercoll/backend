const mongoose = require("mongoose");

const chatMessageSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    sender: { type: String, enum: ["user", "admin"], required: true },
    text: { type: String, required: true, maxlength: 2000 },
    userName: { type: String, default: "User" },
    read: { type: Boolean, default: false },
    attachmentUrl: { type: String },
  },
  { timestamps: true }
);

chatMessageSchema.index({ sessionId: 1, createdAt: 1 });

module.exports = mongoose.model("ChatMessage", chatMessageSchema);
