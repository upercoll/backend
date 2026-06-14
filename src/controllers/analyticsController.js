const Order = require("../models/Order");
const ClaimSession = require("../models/ClaimSession");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const TeamMember = require("../models/TeamMember");
const AgentStats = require("../models/AgentStats");
const catchAsync = require("../utils/catchAsync");

exports.getDashboard = catchAsync(async (req, res) => {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const [
    totalRevenue,
    revenueThisMonth,
    revenueLastMonth,
    ordersToday,
    ordersThisMonth,
    totalOrders,
    pendingClaims,
    activeClaims,
    totalProducts,
    totalCustomers,
    recentOrders,
    onlineAgents,
  ] = await Promise.all([
    Order.aggregate([
      { $match: { "payment.status": "succeeded" } },
      { $group: { _id: null, total: { $sum: "$pricing.total" } } },
    ]),
    Order.aggregate([
      { $match: { "payment.status": "succeeded", createdAt: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: "$pricing.total" } } },
    ]),
    Order.aggregate([
      { $match: { "payment.status": "succeeded", createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
      { $group: { _id: null, total: { $sum: "$pricing.total" } } },
    ]),
    Order.countDocuments({ createdAt: { $gte: startOfToday } }),
    Order.countDocuments({ createdAt: { $gte: startOfMonth } }),
    Order.countDocuments({ "payment.status": "succeeded" }),
    ClaimSession.countDocuments({ status: "pending" }),
    ClaimSession.countDocuments({ status: "active" }),
    Product.countDocuments({ active: true }),
    Customer.countDocuments({ active: { $ne: false } }),
    Order.find({ "payment.status": "succeeded" })
      .sort({ createdAt: -1 })
      .limit(10)
      .select("orderNumber customer items pricing status delivery createdAt"),
    AgentStats.countDocuments({ isOnline: true }),
  ]);

  const revenueGrowth =
    revenueLastMonth[0]?.total > 0
      ? (((revenueThisMonth[0]?.total || 0) - revenueLastMonth[0].total) / revenueLastMonth[0].total) * 100
      : 0;

  res.json({
    success: true,
    data: {
      stats: {
        totalRevenue: totalRevenue[0]?.total || 0,
        revenueThisMonth: revenueThisMonth[0]?.total || 0,
        revenueLastMonth: revenueLastMonth[0]?.total || 0,
        revenueGrowth: Math.round(revenueGrowth * 10) / 10,
        ordersToday,
        ordersThisMonth,
        totalOrders,
        pendingClaims,
        activeClaims,
        totalProducts,
        totalCustomers,
        onlineAgents,
      },
      recentOrders,
    },
  });
});

exports.getRevenueChart = catchAsync(async (req, res) => {
  const { period = "monthly", year } = req.query;
  const targetYear = parseInt(year) || new Date().getFullYear();

  if (period === "monthly") {
    const data = await Order.aggregate([
      {
        $match: {
          "payment.status": "succeeded",
          createdAt: {
            $gte: new Date(targetYear, 0, 1),
            $lt: new Date(targetYear + 1, 0, 1),
          },
        },
      },
      {
        $group: {
          _id: { month: { $month: "$createdAt" } },
          revenue: { $sum: "$pricing.total" },
          orders: { $sum: 1 },
          tax: { $sum: { $multiply: ["$pricing.total", 0.0] } },
        },
      },
      { $sort: { "_id.month": 1 } },
    ]);

    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const chartData = months.map((month, i) => {
      const found = data.find((d) => d._id.month === i + 1);
      return {
        month,
        revenue: found?.revenue || 0,
        orders: found?.orders || 0,
      };
    });

    return res.json({ success: true, data: { chart: chartData, period: "monthly", year: targetYear } });
  }

  const now = new Date();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d);
  }

  const data = await Order.aggregate([
    {
      $match: {
        "payment.status": "succeeded",
        createdAt: { $gte: days[0], $lte: now },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: "$createdAt" },
          month: { $month: "$createdAt" },
          day: { $dayOfMonth: "$createdAt" },
        },
        revenue: { $sum: "$pricing.total" },
        orders: { $sum: 1 },
      },
    },
  ]);

  const chartData = days.map((d) => {
    const found = data.find(
      (item) =>
        item._id.year === d.getFullYear() &&
        item._id.month === d.getMonth() + 1 &&
        item._id.day === d.getDate()
    );
    return {
      date: d.toISOString().slice(0, 10),
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      revenue: found?.revenue || 0,
      orders: found?.orders || 0,
    };
  });

  res.json({ success: true, data: { chart: chartData, period: "daily" } });
});

exports.getOrdersByGame = catchAsync(async (req, res) => {
  const data = await Order.aggregate([
    { $match: { "payment.status": "succeeded" } },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.productSnapshot.game",
        revenue: { $sum: "$items.totalPrice" },
        orders: { $sum: 1 },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 10 },
  ]);
  res.json({ success: true, data: { byGame: data } });
});

exports.getTopProducts = catchAsync(async (req, res) => {
  const data = await Order.aggregate([
    { $match: { "payment.status": "succeeded" } },
    { $unwind: "$items" },
    {
      $group: {
        _id: "$items.product",
        name: { $first: "$items.productSnapshot.name" },
        game: { $first: "$items.productSnapshot.game" },
        totalSold: { $sum: "$items.quantity" },
        revenue: { $sum: "$items.totalPrice" },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 10 },
  ]);
  res.json({ success: true, data: { topProducts: data } });
});

exports.getClaimStats = catchAsync(async (req, res) => {
  const [total, pending, active, claimed, ended] = await Promise.all([
    ClaimSession.countDocuments(),
    ClaimSession.countDocuments({ status: "pending" }),
    ClaimSession.countDocuments({ status: "active" }),
    ClaimSession.countDocuments({ status: "claimed" }),
    ClaimSession.countDocuments({ status: "ended" }),
  ]);

  const avgTime = await ClaimSession.aggregate([
    { $match: { status: "claimed", firstAgentReplyAt: { $exists: true } } },
    {
      $project: {
        responseMs: { $subtract: ["$firstAgentReplyAt", "$createdAt"] },
      },
    },
    { $group: { _id: null, avgMs: { $avg: "$responseMs" } } },
  ]);

  res.json({
    success: true,
    data: {
      claims: { total, pending, active, claimed, ended },
      avgResponseMs: avgTime[0]?.avgMs || 0,
    },
  });
});
