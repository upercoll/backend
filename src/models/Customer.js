const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const customerSchema = new mongoose.Schema(
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
      required: true,
      minlength: 8,
      select: false,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 32,
    },
    robloxUsername: {
      type: String,
      required: true,
      trim: true,
      maxlength: 20,
    },
    robloxAvatarUrl: {
      type: String,
      default: null,
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    emailVerificationCode: {
      type: String,
      select: false,
    },
    emailVerificationExpiry: {
      type: Date,
      select: false,
    },
    active: {
      type: Boolean,
      default: true,
    },
    lastLogin: { type: Date },
  },
  { timestamps: true }
);

customerSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

customerSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

customerSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.emailVerificationCode;
  delete obj.emailVerificationExpiry;
  return obj;
};

module.exports = mongoose.model("Customer", customerSchema);
