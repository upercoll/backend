const jwt = require("jsonwebtoken");
const User = require("../models/User");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

function signToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
}

function sendToken(user, statusCode, res) {
  const token = signToken(user._id);
  res.status(statusCode).json({
    success: true,
    token,
    data: { user: user.toSafeObject() },
  });
}

exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return next(new AppError("Email and password are required", 400));
  }

  const user = await User.findOne({ email: String(email).toLowerCase() }).select("+password");

  if (!user || !(await user.comparePassword(password))) {
    return next(new AppError("Invalid email or password", 401));
  }

  if (!user.active) {
    return next(new AppError("Your account has been deactivated", 403));
  }

  user.lastLogin = new Date();
  await user.save({ validateBeforeSave: false });

  sendToken(user, 200, res);
});

exports.me = catchAsync(async (req, res) => {
  res.json({ success: true, data: { user: req.user.toSafeObject() } });
});

exports.changePassword = catchAsync(async (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return next(new AppError("Both current and new passwords are required", 400));
  }
  if (newPassword.length < 8) {
    return next(new AppError("New password must be at least 8 characters", 400));
  }

  const user = await User.findById(req.user._id).select("+password");
  if (!(await user.comparePassword(currentPassword))) {
    return next(new AppError("Current password is incorrect", 401));
  }

  user.password = newPassword;
  await user.save();

  sendToken(user, 200, res);
});
