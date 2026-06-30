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

    // Status flow: in_review → reviewed → accepted → paid
    status: {
      type: String,
      enum: ["in_review", "reviewed", "accepted", "paid"],
      default: "in_review",
    },

    // Set by admin during review
    rateType: { type: String, enum: ["per_view", "auto"] },
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
  },
  { timestamps: true }
);

socialSubmissionSchema.index({ collaborator: 1, status: 1 });
socialSubmissionSchema.index({ status: 1, platform: 1 });

module.exports = mongoose.model("SocialSubmission", socialSubmissionSchema);
