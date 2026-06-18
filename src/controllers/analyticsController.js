const Order = require("../models/Order");
const ClaimSession = require("../models/ClaimSession");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const TeamMember = require("../models/TeamMember");
const AgentStats = require("../models/AgentStats");
const catchAsync = require("../utils/catchAsync");

const PAID_STATUSES = ["paid", "delivering", "completed", "refunded", "partially_refunded"];

const PAID_FILTER = {
  $or: [
    { "payment.status": "succeeded" },
    { status: { $in: PAID_STATUSES } },
  ],
};

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
      { $match: PAID_FILTER },
      { $group: { _id: null, total: { $sum: "$pricing.total" } } },
    ]),
    Order.aggregate([
      { $match: { ...PAID_FILTER, createdAt: { $gte: startOfMonth } } },
      { $group: { _id: null, total: { $sum: "$pricing.total" } } },
    ]),
    Order.aggregate([
      { $match: { ...PAID_FILTER, createdAt: { $gte: startOfLastMonth, $lte: endOfLastMonth } } },
      { $group: { _id: null, total: { $sum: "$pricing.total" } } },
    ]),
    Order.countDocuments({ ...PAID_FILTER, createdAt: { $gte: startOfToday } }),
    Order.countDocuments({ ...PAID_FILTER, createdAt: { $gte: startOfMonth } }),
    Order.countDocuments(PAID_FILTER),
    ClaimSession.countDocuments({ status: "pending" }),
    ClaimSession.countDocuments({ status: "active" }),
    Product.countDocuments({ active: true }),
    Customer.countDocuments({ active: { $ne: false } }),
    Order.find(PAID_FILTER)
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
          ...PAID_FILTER,
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
        ...PAID_FILTER,
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
    { $match: PAID_FILTER },
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
    { $match: PAID_FILTER },
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

exports.getSalesSummary = catchAsync(async (req, res) => {
  const { period = "month" } = req.query;
  const now = new Date();
  let startDate;
  let prevStart;
  let prevEnd;

  if (period === "today") {
    startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    prevStart = new Date(startDate); prevStart.setDate(prevStart.getDate() - 1);
    prevEnd = new Date(startDate); prevEnd.setMilliseconds(-1);
  } else if (period === "week") {
    const day = now.getDay();
    startDate = new Date(now); startDate.setDate(now.getDate() - day); startDate.setHours(0,0,0,0);
    prevStart = new Date(startDate); prevStart.setDate(prevStart.getDate() - 7);
    prevEnd = new Date(startDate); prevEnd.setMilliseconds(-1);
  } else if (period === "month") {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    prevEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  } else if (period === "year") {
    startDate = new Date(now.getFullYear(), 0, 1);
    prevStart = new Date(now.getFullYear() - 1, 0, 1);
    prevEnd = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
  } else {
    startDate = new Date(0);
    prevStart = new Date(0);
    prevEnd = new Date(0);
  }

  const [current, previous, statusBreakdown] = await Promise.all([
    Order.aggregate([
      { $match: { ...PAID_FILTER, createdAt: { $gte: startDate } } },
      { $group: { _id: null, revenue: { $sum: "$pricing.total" }, orders: { $sum: 1 }, avgOrder: { $avg: "$pricing.total" } } },
    ]),
    Order.aggregate([
      { $match: { ...PAID_FILTER, createdAt: { $gte: prevStart, $lte: prevEnd } } },
      { $group: { _id: null, revenue: { $sum: "$pricing.total" }, orders: { $sum: 1 } } },
    ]),
    Order.aggregate([
      { $match: { createdAt: { $gte: startDate } } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  const curr = current[0] || { revenue: 0, orders: 0, avgOrder: 0 };
  const prev = previous[0] || { revenue: 0, orders: 0 };
  const revenueGrowth = prev.revenue > 0 ? ((curr.revenue - prev.revenue) / prev.revenue) * 100 : 0;
  const ordersGrowth = prev.orders > 0 ? ((curr.orders - prev.orders) / prev.orders) * 100 : 0;

  const breakdown = {};
  statusBreakdown.forEach(s => { breakdown[s._id] = s.count; });

  res.json({
    success: true,
    data: {
      period,
      revenue: curr.revenue,
      orders: curr.orders,
      avgOrderValue: curr.avgOrder,
      revenueGrowth: Math.round(revenueGrowth * 10) / 10,
      ordersGrowth: Math.round(ordersGrowth * 10) / 10,
      previousRevenue: prev.revenue,
      statusBreakdown: breakdown,
    },
  });
});

exports.getConversionRate = catchAsync(async (req, res) => {
  const [totalOrders, paidOrders, abandonedCheckouts] = await Promise.all([
    Order.countDocuments(),
    Order.countDocuments(PAID_FILTER),
    Order.countDocuments({
      "payment.stripePaymentIntentId": { $exists: true, $ne: null },
      "payment.status": "failed",
      createdAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    }),
  ]);

  const conversionRate = totalOrders > 0 ? (paidOrders / totalOrders) * 100 : 0;
  const abandonmentRate = totalOrders > 0 ? (abandonedCheckouts / totalOrders) * 100 : 0;

  res.json({
    success: true,
    data: {
      totalOrders,
      paidOrders,
      abandonedCheckouts,
      conversionRate: Math.round(conversionRate * 10) / 10,
      abandonmentRate: Math.round(abandonmentRate * 10) / 10,
    },
  });
});

exports.getStockerCommissions = catchAsync(async (req, res) => {
  const { period = "month" } = req.query;
  const now = new Date();
  const startDate = period === "month" ? new Date(now.getFullYear(), now.getMonth(), 1)
    : period === "week" ? (() => { const d = new Date(now); d.setDate(d.getDate() - 7); return d; })()
    : new Date(0);

  const Product = require("../models/Product");
  const members = await require("../models/TeamMember").find({ status: "active" }).select("email displayName commissionRate").populate("role", "name");

  const commissions = await Promise.all(
    members.map(async (member) => {
      const products = await Product.find({ addedBy: member._id }).select("_id name salesCount price");
      let totalRevenue = 0;
      for (const p of products) {
        const sales = await Order.aggregate([
          { $match: { ...PAID_FILTER, createdAt: { $gte: startDate }, "items.product": p._id } },
          { $unwind: "$items" },
          { $match: { "items.product": p._id } },
          { $group: { _id: null, revenue: { $sum: "$items.totalPrice" } } },
        ]);
        totalRevenue += sales[0]?.revenue || 0;
      }
      const commissionEarned = (totalRevenue * (member.commissionRate || 0)) / 100;
      return {
        memberId: member._id,
        name: member.displayName || member.email,
        email: member.email,
        commissionRate: member.commissionRate || 0,
        productsAdded: products.length,
        revenueGenerated: totalRevenue,
        commissionEarned,
        products: products.slice(0, 5),
      };
    })
  );

  const totals = commissions.reduce((acc, m) => ({
    totalRevenue: acc.totalRevenue + m.revenueGenerated,
    totalCommission: acc.totalCommission + m.commissionEarned,
  }), { totalRevenue: 0, totalCommission: 0 });

  res.json({ success: true, data: { commissions: commissions.filter(c => c.productsAdded > 0), totals, period } });
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
