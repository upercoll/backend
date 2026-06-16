const Customer = require("../models/Customer");
const Order = require("../models/Order");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.listCustomers = catchAsync(async (req, res) => {
  const { page = 1, limit = 20, search, active } = req.query;
  const filter = {};

  if (active !== undefined) filter.active = active === "true";
  if (search) {
    filter.$or = [
      { email: { $regex: search, $options: "i" } },
      { displayName: { $regex: search, $options: "i" } },
      { robloxUsername: { $regex: search, $options: "i" } },
    ];
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const [customers, total] = await Promise.all([
    Customer.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
    Customer.countDocuments(filter),
  ]);

  const enriched = await Promise.all(
    customers.map(async (c) => {
      const orderCount = await Order.countDocuments({ "customer.email": c.email });
      const spending = await Order.aggregate([
        { $match: { "customer.email": c.email, "payment.status": "succeeded" } },
        { $group: { _id: null, total: { $sum: "$pricing.total" } } },
      ]);
      return {
        ...c.toSafeObject(),
        orderCount,
        totalSpent: spending[0]?.total || 0,
      };
    })
  );

  res.json({
    success: true,
    data: { customers: enriched, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) },
  });
});

exports.getCustomer = catchAsync(async (req, res, next) => {
  const customer = await Customer.findById(req.params.id);
  if (!customer) return next(new AppError("Customer not found", 404));

  const [orders, totalSpent] = await Promise.all([
    Order.find({ "customer.email": customer.email }).sort({ createdAt: -1 }).limit(20),
    Order.aggregate([
      { $match: { "customer.email": customer.email, "payment.status": "succeeded" } },
      { $group: { _id: null, total: { $sum: "$pricing.total" } } },
    ]),
  ]);

  res.json({
    success: true,
    data: { customer: customer.toSafeObject(), orders, totalSpent: totalSpent[0]?.total || 0 },
  });
});

exports.updateCustomer = catchAsync(async (req, res, next) => {
  const { active, displayName } = req.body;
  const customer = await Customer.findById(req.params.id);
  if (!customer) return next(new AppError("Customer not found", 404));

  if (active !== undefined) customer.active = active;
  if (displayName) customer.displayName = displayName;

  await customer.save({ validateBeforeSave: false });
  res.json({ success: true, data: { customer: customer.toSafeObject() } });
});

exports.deleteCustomer = catchAsync(async (req, res, next) => {
  const customer = await Customer.findByIdAndDelete(req.params.id);
  if (!customer) return next(new AppError("Customer not found", 404));
  res.json({ success: true, message: "Customer deleted" });
});

exports.getCustomerStats = catchAsync(async (req, res) => {
  const [total, active, newThisMonth, topSpenders] = await Promise.all([
    Customer.countDocuments(),
    Customer.countDocuments({ active: { $ne: false } }),
    Customer.countDocuments({ createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } }),
    Order.aggregate([
      { $match: { "payment.status": "succeeded" } },
      { $group: { _id: "$customer.email", total: { $sum: "$pricing.total" }, orders: { $sum: 1 }, robloxUsername: { $first: "$customer.robloxUsername" } } },
      { $sort: { total: -1 } },
      { $limit: 5 },
    ]),
  ]);

  res.json({ success: true, data: { total, active, newThisMonth, topSpenders } });
});
