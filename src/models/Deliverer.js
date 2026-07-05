const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const delivererSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, trim: true, default: "" },
    password: { type: String, select: false },
    status: { type: String, enum: ["invited", "active", "disabled"], default: "invited" },
    active: { type: Boolean, default: true },
    inviteToken: { type: String, select: false },
    inviteExpiry: { type: Date },
    verificationCode: { type: String, select: false },
    verificationExpiry: { type: Date },
    commissionRate: { type: Number, default: 20, min: 0, max: 100 },
    lastLogin: { type: Date },
    // Unpaid earnings since last payout
    totalRevenue: { type: Number, default: 0 },
    totalCommission: { type: Number, default: 0 },
    totalDelivered: { type: Number, default: 0 },
    // Lifetime paid totals
    lifetimeRevenue: { type: Number, default: 0 },
    lifetimeCommission: { type: Number, default: 0 },
    lastPayoutAt: { type: Date },
  },
  { timestamps: true }
);

delivererSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

delivererSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model("Deliverer", delivererSchema);
