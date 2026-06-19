const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    sender: { type: String, enum: ["customer", "agent", "system"], required: true },
    text: { type: String, required: true, maxlength: 2000 },
    senderName: { type: String, default: "Unknown" },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: true }
);

const claimItemSchema = new mongoose.Schema(
  {
    itemId: { type: String },
    name: { type: String, required: true },
    quantity: { type: Number, default: 1 },
  },
  { _id: false }
);

const claimSessionSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },

    robloxUsername: { type: String, required: true, trim: true },
    contactEmail: { type: String, required: true, trim: true, lowercase: true },

    orderRef: { type: String, trim: true },
    game: { type: String, trim: true },

    items: [claimItemSchema],

    itemName: { type: String, trim: true },

    status: {
      type: String,
      enum: ["pending", "active", "claimed", "ended", "closed"],
      default: "pending",
    },

    closedAt: { type: Date },
    closedBy: { type: String },

    assignedAgent: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      name: String,
      joinedAt: Date,
    },

    messages: [messageSchema],

    emailNotificationSent: { type: Boolean, default: false },

    firstAgentReplyAt: Date,
    resolvedAt: Date,

    feedback: {
      rating: { type: Number, min: 1, max: 5 },
      comment: String,
      proofImageUrl: String,
      submittedAt: Date,
    },
  },
  { timestamps: true }
);

claimSessionSchema.index({ status: 1, createdAt: -1 });
claimSessionSchema.index({ contactEmail: 1 });
claimSessionSchema.index({ robloxUsername: 1 });

module.exports = mongoose.model("ClaimSession", claimSessionSchema);
