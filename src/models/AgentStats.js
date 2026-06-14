const mongoose = require("mongoose");

const agentStatsSchema = new mongoose.Schema(
  {
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TeamMember",
      required: true,
      unique: true,
    },
    totalClaims: { type: Number, default: 0 },
    completedClaims: { type: Number, default: 0 },
    declinedClaims: { type: Number, default: 0 },
    timedOutClaims: { type: Number, default: 0 },
    avgResponseTimeMs: { type: Number, default: 0 },
    avgHandleTimeMs: { type: Number, default: 0 },
    totalOnlineMs: { type: Number, default: 0 },
    currentSessionStart: { type: Date },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date },
    gamesHandled: [{ type: String, trim: true }],
    monthlyStats: [
      {
        month: { type: String },
        year: { type: Number },
        claims: { type: Number, default: 0 },
        completed: { type: Number, default: 0 },
        declined: { type: Number, default: 0 },
        avgResponseMs: { type: Number, default: 0 },
      },
    ],
    rating: {
      total: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
      average: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

agentStatsSchema.index({ agentId: 1 });
agentStatsSchema.index({ isOnline: 1 });

module.exports = mongoose.model("AgentStats", agentStatsSchema);
