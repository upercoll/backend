const mongoose = require("mongoose");

const ticketMessageSchema = new mongoose.Schema(
  {
    sender: { type: String, enum: ["customer", "agent", "system"], required: true },
    text: { type: String, required: true, maxlength: 2000 },
    senderName: { type: String, default: "Unknown" },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: true }
);

const ticketSchema = new mongoose.Schema(
  {
    ticketId: { type: String, required: true, unique: true, index: true },

    subject: { type: String, required: true, trim: true },

    category: {
      type: String,
      enum: ["general", "order_issue", "delivery", "payment", "technical", "other"],
      default: "general",
    },

    status: {
      type: String,
      enum: ["open", "in_progress", "waiting", "resolved", "closed"],
      default: "open",
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },

    customerEmail: { type: String, required: true, trim: true, lowercase: true },
    customerName: { type: String, trim: true },

    orderId: { type: String, trim: true },

    assignedAgent: {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      name: String,
      assignedAt: Date,
    },

    messages: [ticketMessageSchema],

    tags: [{ type: String, trim: true }],

    resolution: { type: String },
    resolvedAt: { type: Date },
    closedAt: { type: Date },
    lastReplyAt: { type: Date },

    unreadCustomer: { type: Number, default: 0 },
    unreadAgent: { type: Number, default: 0 },
  },
  { timestamps: true }
);

ticketSchema.index({ status: 1, createdAt: -1 });
ticketSchema.index({ customerEmail: 1 });
ticketSchema.index({ "assignedAgent.userId": 1 });

module.exports = mongoose.model("Ticket", ticketSchema);
