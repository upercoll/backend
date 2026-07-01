const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const collaboratorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
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
    status: {
      type: String,
      enum: ["invited", "active", "disabled"],
      default: "invited",
    },
    inviteToken: { type: String, select: false },
    inviteExpiry: { type: Date },
    verificationCode: { type: String, select: false },
    verificationExpiry: { type: Date },
    lastPayoutAt: { type: Date, default: null },
    invitedBy: { type: String },
    active: { type: Boolean, default: true },
    lastLogin: { type: Date },
    isSocialCreator: { type: Boolean, default: false },
  },
  { timestamps: true }
);

collaboratorSchema.pre("save", async function (next) {
  if (!this.isModified("password") || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

collaboratorSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

collaboratorSchema.methods.generateInviteToken = function () {
  const raw = crypto.randomBytes(32).toString("hex");
  this.inviteToken = crypto.createHash("sha256").update(raw).digest("hex");
  this.inviteExpiry = new Date(Date.now() + 72 * 60 * 60 * 1000);
  return raw;
};

collaboratorSchema.methods.generateVerificationCode = function () {
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  this.verificationCode = code;
  this.verificationExpiry = new Date(Date.now() + 15 * 60 * 1000);
  return code;
};

collaboratorSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.inviteToken;
  delete obj.verificationCode;
  return obj;
};

module.exports = mongoose.model("Collaborator", collaboratorSchema);
