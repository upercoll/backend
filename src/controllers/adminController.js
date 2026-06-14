const User = require("../models/User");
const Order = require("../models/Order");
const Product = require("../models/Product");
const Category = require("../models/Category");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.getDashboard = catchAsync(async (req, res) => {
  const [
    totalProducts,
    activeProducts,
    totalCategories,
    totalOrders,
    paidOrders,
    pendingOrders,
    revenueResult,
    topProducts,
  ] = await Promise.all([
    Product.countDocuments(),
    Product.countDocuments({ active: true }),
    Category.countDocuments({ active: true }),
    Order.countDocuments(),
    Order.countDocuments({ "payment.status": "succeeded" }),
    Order.countDocuments({ status: "pending" }),
    Order.aggregate([
      { $match: { "payment.status": "succeeded" } },
      { $group: { _id: null, total: { $sum: "$pricing.total" }, count: { $sum: 1 } } },
    ]),
    Product.find({ active: true }).sort("-salesCount").limit(5).select("name salesCount price game"),
  ]);

  res.json({
    success: true,
    data: {
      products: { total: totalProducts, active: activeProducts },
      categories: { total: totalCategories },
      orders: {
        total: totalOrders,
        paid: paidOrders,
        pending: pendingOrders,
        revenue: revenueResult[0]?.total || 0,
      },
      topProducts,
    },
  });
});

exports.getUsers = catchAsync(async (req, res) => {
  const users = await User.find().sort("-createdAt").select("-password");
  res.json({ success: true, count: users.length, data: users });
});

exports.createUser = catchAsync(async (req, res) => {
  const { email, password, name, role } = req.body;
  const user = await User.create({ email, password, name, role: role || "support" });
  res.status(201).json({ success: true, data: user.toSafeObject() });
});

exports.updateUser = catchAsync(async (req, res, next) => {
  const { name, role, active } = req.body;
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { name, role, active },
    { new: true, runValidators: true }
  ).select("-password");
  if (!user) return next(new AppError("User not found", 404));
  res.json({ success: true, data: user });
});

exports.deleteUser = catchAsync(async (req, res, next) => {
  if (req.params.id === req.user._id.toString()) {
    return next(new AppError("You cannot delete your own account", 400));
  }
  const user = await User.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  if (!user) return next(new AppError("User not found", 404));
  res.json({ success: true, message: "User deactivated" });
});
