const mongoose = require("mongoose");

const socialPayoutSchema = new mongoose.Schema(
  {
    collaborator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Collaborator",
      required: true,
    },
    amount: { type: Number, required: true },
    submissionCount: { type: Number, default: 0 },
    submissionIds: [
      { type: mongoose.Schema.Types.ObjectId, ref: "SocialSubmission" },
    ],
    periodEnd: { type: Date },
    paidAt: { type: Date },
    paidBy: { type: String },
  },
  { timestamps: true }
);

socialPayoutSchema.index({ collaborator: 1, createdAt: -1 });

module.exports = mongoose.model("SocialPayout", socialPayoutSchema);
