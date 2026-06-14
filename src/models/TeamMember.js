const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const teamMemberSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      minlength: 8,
      select: false,
    },
    role: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Role",
      required: true,
    },
    status: {
      type: String,
      enum: ["invited", "active", "disabled"],
      default: "invited",
    },
    claimGames: [{ type: String, trim: true }],
    claimCategories: [{ type: String, trim: true }],
    inviteToken: { type: String, select: false },
    inviteExpiry: { type: Date },
    verificationCode: { type: String, select: false },
    verificationExpiry: { type: Date },
    active: { type: Boolean, default: true },
    lastLogin: { type: Date },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    invitedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

teamMemberSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

teamMemberSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

teamMemberSchema.methods.generateInviteToken = function () {
  const raw = crypto.randomBytes(32).toString("hex");
  this.inviteToken = crypto.createHash("sha256").update(raw).digest("hex");
  this.inviteExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000);
  return raw;
};

teamMemberSchema.methods.generateVerificationCode = function () {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  this.verificationCode = code;
  this.verificationExpiry = new Date(Date.now() + 15 * 60 * 1000);
  return code;
};

teamMemberSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.inviteToken;
  delete obj.verificationCode;
  return obj;
};

module.exports = mongoose.model("TeamMember", teamMemberSchema);
