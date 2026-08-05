const Stocker = require("../models/Stocker");
const StockRequest = require("../models/StockRequest");
const StockerPayout = require("../models/StockerPayout");
const Product = require("../models/Product");
const StockSale = require("../models/StockSale");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const crypto = require("crypto");
const { sendInviteEmail } = require("../config/email");
const { addStock, removeStockForDeletedRequest } = require("../services/stockService");

exports.listStockers = catchAsync(async (req, res) => {
  const stockers = await Stocker.find({ active: true }).sort({ createdAt: -1 });

  const enriched = await Promise.all(
    stockers.map(async (s) => {
      const requestCount = await StockRequest.countDocuments({ stocker: s._id });
      const stockedCount = await StockRequest.countDocuments({ stocker: s._id, status: "stocked" });
      return { ...s.toObject(), requestCount, stockedCount };
    })
  );

  res.json({ success: true, data: { stockers: enriched } });
});

exports.getStockerDetail = catchAsync(async (req, res, next) => {
  const stocker = await Stocker.findById(req.params.id);
  if (!stocker) return next(new AppError("Stocker not found", 404));

  const requests = await StockRequest.find({ stocker: stocker._id })
    .sort({ createdAt: -1 })
    .limit(50);

  const stats = {
    totalRequests: requests.length,
    pendingRequests: requests.filter((r) => r.status === "pending").length,
    approvedRequests: requests.filter((r) => r.status === "approved").length,
    stockedRequests: requests.filter((r) => r.status === "stocked").length,
    rejectedRequests: requests.filter((r) => r.status === "rejected").length,
    totalRevenue: stocker.totalRevenue,
    totalCommission: stocker.totalCommission,
    totalStocked: stocker.totalStocked,
  };

  res.json({ success: true, data: { stocker, requests, stats } });
});

exports.inviteStocker = catchAsync(async (req, res, next) => {
  const { email, name, commissionRate, games } = req.body;
  if (!email) return next(new AppError("Email is required", 400));

  const existing = await Stocker.findOne({ email: email.toLowerCase() });
  if (existing) return next(new AppError("A stocker with this email already exists", 400));

  const rawToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

  const stocker = await Stocker.create({
    email: email.toLowerCase(),
    name: name || "",
    inviteToken: hashedToken,
    inviteExpiry: new Date(Date.now() + 72 * 60 * 60 * 1000),
    status: "invited",
    commissionRate: commissionRate || 10,
    games: games || [],
  });

  const inviteUrl = `${process.env.FRONTEND_URL}/stocker/invite/${rawToken}`;

  try {
    await sendInviteEmail({
      to: email,
      inviteUrl,
      roleName: "Stocker",
      inviterName: req.panelUser?.email || "Admin",
    });
  } catch (emailErr) {
    console.error("Failed to send stocker invite email:", emailErr.message);
  }

  res.status(201).json({ success: true, data: { stocker } });
});

exports.updateStocker = catchAsync(async (req, res, next) => {
  const stocker = await Stocker.findById(req.params.id);
  if (!stocker) return next(new AppError("Stocker not found", 404));

  const { name, status, commissionRate, games, cryptoAddress, cryptoNetwork } = req.body;
  if (name !== undefined) stocker.name = name;
  if (status) stocker.status = status;
  if (commissionRate !== undefined) stocker.commissionRate = commissionRate;
  if (games) stocker.games = games;
  if (cryptoAddress !== undefined) stocker.cryptoAddress = cryptoAddress;
  if (cryptoNetwork !== undefined) stocker.cryptoNetwork = cryptoNetwork;

  await stocker.save();
  res.json({ success: true, data: { stocker } });
});

exports.deleteStocker = catchAsync(async (req, res, next) => {
  const stocker = await Stocker.findById(req.params.id);
  if (!stocker) return next(new AppError("Stocker not found", 404));
  stocker.active = false;
  stocker.status = "disabled";
  await stocker.save();
  res.json({ success: true, message: "Stocker removed" });
});

exports.listRequests = catchAsync(async (req, res) => {
  const { status, stocker, game } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (stocker) filter.stocker = stocker;
  if (game) filter.game = game;

  const requests = await StockRequest.find(filter)
    .populate("stocker", "name email commissionRate")
    .sort({ createdAt: -1 })
    .limit(100);

  res.json({ success: true, data: { requests } });
});

exports.getRequest = catchAsync(async (req, res, next) => {
  const request = await StockRequest.findById(req.params.id).populate("stocker", "name email commissionRate");
  if (!request) return next(new AppError("Stock request not found", 404));
  res.json({ success: true, data: { request } });
});

exports.approveRequest = catchAsync(async (req, res, next) => {
  const { paymentAmount, adminNotes } = req.body;
  const request = await StockRequest.findById(req.params.id).populate("stocker");
  if (!request) return next(new AppError("Stock request not found", 404));
  if (request.status !== "pending") return next(new AppError("Request is not in pending status", 400));

  request.status = "approved";
  request.paymentAmount = paymentAmount || 0;
  request.approvedAt = new Date();
  if (adminNotes) request.adminNotes = adminNotes;

  await request.save();

  res.json({ success: true, data: { request } });
});

exports.markStocked = catchAsync(async (req, res, next) => {
  const { adminNotes } = req.body;
  const request = await StockRequest.findById(req.params.id).populate("stocker");
  if (!request) return next(new AppError("Stock request not found", 404));
  if (request.status !== "approved") return next(new AppError("Request must be approved before marking as stocked", 400));

  for (const item of request.items) {
    if (item.product) await addStock(item.product, item.quantity);
    item.remainingQuantity = item.quantity;
    item.soldQuantity = 0;
  }

  // Commission is calculated on store price, not the stocker's custom sale price
  const storeBasedTotal = request.items.reduce(
    (sum, item) => sum + (item.storePrice || item.salePrice || 0) * (item.quantity || 1),
    0
  );
  const commission = (storeBasedTotal * (request.stocker?.commissionRate || 0)) / 100;

  request.status = "stocked";
  request.stockedAt = new Date();
  request.stockedBy = req.panelUser?.email || "Admin";
  request.commission = commission;
  request.commissionRate = request.stocker?.commissionRate || 0;
  if (adminNotes) request.adminNotes = adminNotes;
  request.paymentSent = true;

  await request.save();

  if (request.stocker) {
    await Stocker.findByIdAndUpdate(request.stocker._id, {
      $inc: {
        totalStocked: request.items.reduce((sum, i) => sum + i.quantity, 0),
      },
    });
  }

  res.json({ success: true, data: { request } });
});

exports.getStockerSales = catchAsync(async (req, res, next) => {
  const stocker = await Stocker.findById(req.params.id);
  if (!stocker) return next(new AppError("Stocker not found", 404));

  const sales = await StockSale.find({
    deliveredAt: { $exists: true },
    "allocations.stocker": stocker._id,
  }).sort({ deliveredAt: -1 }).lean();
  const deliveries = [];
  const productSaleMap = {};
  for (const sale of sales) {
    const allocations = sale.allocations.filter((allocation) => String(allocation.stocker) === String(stocker._id));
    const items = allocations.map((allocation) => ({
      name: sale.productName,
      quantity: allocation.quantity,
      salePrice: allocation.unitRevenue,
    }));
    deliveries.push({
      roomId: sale.claimRoomId,
      robloxUsername: sale.customer?.robloxUsername || "Customer",
      contactEmail: sale.customer?.email || "",
      orderRef: sale.orderNumber,
      deliveredAt: sale.deliveredAt,
      items,
    });
    for (const allocation of allocations) {
      const key = String(sale.product);
      if (!productSaleMap[key]) {
        productSaleMap[key] = { productName: sale.productName, salePrice: allocation.unitRevenue, totalSold: 0, totalRevenue: 0 };
      }
      productSaleMap[key].totalSold += allocation.quantity;
      productSaleMap[key].totalRevenue += allocation.quantity * allocation.unitRevenue;
    }
  }

  res.json({
    success: true,
    data: {
      stocker: { _id: stocker._id, name: stocker.name, email: stocker.email },
      deliveries,
      total: deliveries.length,
      productSummary: Object.values(productSaleMap),
    },
  });
});

exports.deleteRequest = catchAsync(async (req, res, next) => {
  const request = await StockRequest.findById(req.params.id);
  if (!request) return next(new AppError("Stock request not found", 404));

  // Reverse product stock if it was already stocked
  if (request.status === "stocked") {
    for (const item of request.items) {
      if (item.product) {
        const product = await removeStockForDeletedRequest(item.product, item.remainingQuantity || 0);
        if (!product && (item.remainingQuantity || 0) > 0) {
          return next(new AppError("Cannot delete this stock request because its remaining inventory has already changed", 409));
        }
      }
    }
  }

  await StockRequest.findByIdAndDelete(req.params.id);
  res.json({ success: true, message: "Stock request deleted" });
});

exports.rejectRequest = catchAsync(async (req, res, next) => {
  const { adminNotes } = req.body;
  const request = await StockRequest.findById(req.params.id);
  if (!request) return next(new AppError("Stock request not found", 404));
  if (!["pending", "approved"].includes(request.status)) {
    return next(new AppError("Cannot reject a request in its current status", 400));
  }

  request.status = "rejected";
  request.rejectedAt = new Date();
  if (adminNotes) request.adminNotes = adminNotes;

  await request.save();
  res.json({ success: true, data: { request } });
});

exports.getStockerStats = catchAsync(async (req, res) => {
  const stockers = await Stocker.find({ active: true, status: "active" });

  const stats = await Promise.all(
    stockers.map(async (s) => {
      const [total, pending, stocked] = await Promise.all([
        StockRequest.countDocuments({ stocker: s._id }),
        StockRequest.countDocuments({ stocker: s._id, status: "pending" }),
        StockRequest.countDocuments({ stocker: s._id, status: "stocked" }),
      ]);
      return {
        stocker: { _id: s._id, name: s.name, email: s.email, commissionRate: s.commissionRate },
        totalRequests: total,
        pendingRequests: pending,
        stockedRequests: stocked,
        totalRevenue: s.totalRevenue,
        totalCommission: s.totalCommission,
      };
    })
  );

  res.json({ success: true, data: { stats } });
});

async function computeUnpaidDeliveries(stocker) {
  const payouts = await StockerPayout.find({ stocker: stocker._id }).select("saleAllocations").lean();
  const paidBySale = new Map();
  payouts.forEach((payout) => (payout.saleAllocations || []).forEach((allocation) => {
    const key = `${allocation.sale}:${allocation.allocationIndex}`;
    paidBySale.set(key, (paidBySale.get(key) || 0) + allocation.amount);
  }));
  const sales = await StockSale.find({ deliveredAt: { $exists: true }, "allocations.stocker": stocker._id })
    .sort({ deliveredAt: 1 }).lean();
  const deliveries = [];
  let unpaidAmount = 0;
  sales.forEach((sale) => sale.allocations.forEach((allocation, allocationIndex) => {
    if (String(allocation.stocker) !== String(stocker._id)) return;
    const commission = allocation.unitRevenue * allocation.quantity * (allocation.commissionRate / 100);
    const paidAmount = paidBySale.get(`${sale._id}:${allocationIndex}`) || 0;
    const remaining = Math.max(0, commission - paidAmount);
    if (remaining <= 0.0001) return;
    unpaidAmount += remaining;
    deliveries.push({
      saleId: String(sale._id),
      allocationIndex,
      deliveredAt: sale.deliveredAt,
      robloxUsername: sale.customer?.robloxUsername || "Customer",
      orderRef: sale.orderNumber,
      items: [{ name: sale.productName, quantity: allocation.quantity, salePrice: allocation.unitRevenue }],
      revenue: allocation.unitRevenue * allocation.quantity,
      commission: remaining,
      unpaidAmount: remaining,
    });
  }));
  return { deliveries, unpaidAmount: Number(unpaidAmount.toFixed(2)), deliveryCount: deliveries.length };
}

exports.getStockerPayouts = catchAsync(async (req, res, next) => {
  const stocker = await Stocker.findById(req.params.id);
  if (!stocker) return next(new AppError("Stocker not found", 404));

  const [payouts, unpaidData] = await Promise.all([
    StockerPayout.find({ stocker: stocker._id }).sort({ createdAt: -1 }),
    computeUnpaidDeliveries(stocker),
  ]);

  res.json({
    success: true,
    data: {
      stocker,
      payouts,
      unpaidAmount: unpaidData.unpaidAmount,
      unpaidDeliveries: unpaidData.deliveries,
      unpaidDeliveryCount: unpaidData.deliveryCount,
    },
  });
});

exports.markStockerPaid = catchAsync(async (req, res, next) => {
  const stocker = await Stocker.findById(req.params.id);
  if (!stocker) return next(new AppError("Stocker not found", 404));

  const { notes } = req.body;
  const unpaidData = await computeUnpaidDeliveries(stocker);

  if (unpaidData.unpaidAmount <= 0) {
    return next(new AppError("No unpaid amount to mark as paid", 400));
  }

  const requestedAmount = req.body?.amount === undefined ? unpaidData.unpaidAmount : Number(req.body.amount);
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount > unpaidData.unpaidAmount + 0.001) {
    return next(new AppError(`Enter an amount between $0.01 and $${unpaidData.unpaidAmount.toFixed(2)}`, 400));
  }
  let remaining = Number(requestedAmount.toFixed(2));
  const allocations = [];
  const saleAllocations = [];
  for (const delivery of [...unpaidData.deliveries].sort((a, b) => new Date(a.deliveredAt) - new Date(b.deliveredAt))) {
    if (remaining <= 0) break;
    const amount = Number(Math.min(delivery.unpaidAmount, remaining).toFixed(2));
    if (!amount) continue;
    saleAllocations.push({ sale: delivery.saleId, allocationIndex: delivery.allocationIndex, amount });
    remaining = Number((remaining - amount).toFixed(2));
  }
  const periodStart = stocker.lastPayoutAt || stocker.createdAt;
  const periodEnd = new Date();

  const payout = await StockerPayout.create({
    stocker: stocker._id,
    amount: requestedAmount,
    commissionRate: stocker.commissionRate,
    deliveryCount: unpaidData.deliveryCount,
    periodStart,
    periodEnd,
    notes: notes || "",
    markedPaidBy: req.panelUser?.email || "Admin",
    cryptoAddress: stocker.cryptoAddress || "",
    cryptoNetwork: stocker.cryptoNetwork || "",
    allocations,
    saleAllocations,
  });

  await stocker.save();

  res.json({ success: true, data: { payout } });
});
