const mongoose = require("mongoose");

const adminProfileSchema = new mongoose.Schema(
  {
    memberId: { type: mongoose.Schema.Types.ObjectId, refPath: "memberType" },
    memberType: { type: String, enum: ["User", "TeamMember"], required: true },
    isOwner: { type: Boolean, default: false },
    displayName: { type: String, trim: true, maxlength: 50 },
    username: {
      type: String,
      trim: true,
      lowercase: true,
      maxlength: 30,
      match: /^[a-z0-9_]+$/,
    },
    profilePicture: { type: String },
    bio: { type: String, maxlength: 200, trim: true },
    profileComplete: { type: Boolean, default: false },
    timezone: { type: String, default: "UTC" },
    notifications: {
      newOrders: { type: Boolean, default: true },
      newClaims: { type: Boolean, default: true },
      teamUpdates: { type: Boolean, default: true },
    },
  },
  { timestamps: true }
);

adminProfileSchema.index({ memberId: 1, memberType: 1 }, { unique: true });
adminProfileSchema.index({ username: 1 }, { sparse: true });

module.exports = mongoose.model("AdminProfile", adminProfileSchema);
