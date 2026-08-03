const mongoose = require("mongoose");

const socialSubmissionSchema = new mongoose.Schema(
  {
    collaborator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Collaborator",
      required: true,
    },
    platform: {
      type: String,
      enum: ["youtube", "tiktok"],
      required: true,
    },
    url: { type: String, required: true },
    videoId: { type: String },
    title: { type: String, default: "" },
    thumbnail: { type: String, default: "" },
    channelName: { type: String, default: "" },
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },

    // Videos are tracked as soon as a creator submits them. `paid` is retained
    // for completed balances, so existing tracker records stay compatible.
    status: {
      type: String,
      enum: ["active", "in_review", "reviewed", "accepted", "paid"],
      default: "active",
    },

    // Set by admin during review
    rateType: { type: String, enum: ["per_view", "auto", "per_1k", "per_video"] },
    ratePerView: { type: Number },    // $ per view
    offeredAmount: { type: Number },  // total offered to creator
    adminNote: { type: String, default: "" },
    reviewedAt: { type: Date },
    reviewedBy: { type: String },

    // Set when creator accepts the offer
    acceptedAt: { type: Date },

    // Set when admin marks as paid
    paidAt: { type: Date },
    paidBy: { type: String },
    paidInPayoutId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SocialPayout",
    },
    paidAmount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

socialSubmissionSchema.index({ collaborator: 1, status: 1 });
socialSubmissionSchema.index({ status: 1, platform: 1 });

module.exports = mongoose.model("SocialSubmission", socialSubmissionSchema);
