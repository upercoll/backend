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
const money = (value) => Number((Number(value) || 0).toFixed(2));

async function getStockerLedgerTotals(stockerId) {
  const [sales, payouts] = await Promise.all([
    StockSale.find({ deliveredAt: { $exists: true }, "allocations.stocker": stockerId })
      .select("allocations")
      .lean(),
    StockerPayout.find({ stocker: stockerId }).select("saleAllocations").lean(),
  ]);
  const paidByAllocation = new Map();
  for (const payout of payouts) {
    for (const allocation of payout.saleAllocations || []) {
      const key = `${allocation.sale}:${allocation.allocationIndex}`;
      paidByAllocation.set(key, money((paidByAllocation.get(key) || 0) + allocation.amount));
    }
  }
  let totalRevenue = 0;
  let totalCommissionEarned = 0;
  let totalCommissionPaid = 0;
  for (const sale of sales) {
    sale.allocations.forEach((allocation, allocationIndex) => {
      if (String(allocation.stocker) !== String(stockerId)) return;
      const revenue = money(allocation.unitRevenue * allocation.quantity);
      const commission = money(revenue * (allocation.commissionRate / 100));
      totalRevenue = money(totalRevenue + revenue);
      totalCommissionEarned = money(totalCommissionEarned + commission);
      totalCommissionPaid = money(totalCommissionPaid + Math.min(commission, paidByAllocation.get(`${sale._id}:${allocationIndex}`) || 0));
    });
  }
  return {
    totalRevenue,
    totalCommissionEarned,
    totalCommissionPaid,
    totalCommissionOwed: money(Math.max(0, totalCommissionEarned - totalCommissionPaid)),
  };
}

exports.listStockers = catchAsync(async (req, res) => {
  const stockers = await Stocker.find({ active: true }).sort({ createdAt: -1 });

  // The Stocker document's own `totalRevenue`/`totalCommission` fields are
  // never written anywhere (only `totalStocked` is), so they always sit at
  // their schema default of 0. The frontend's summary cards and per-stocker
  // rows read `totalRevenue` / `totalCommissionOwed` straight off this list
  // response, which meant they always displayed $0.00 no matter how much
  // had actually sold. The real numbers only exist via
  // getStockerLedgerTotals() (derived from StockSale + StockerPayout) — computing
  // and attaching them here is what actually makes the tracking page correct.
  const enriched = await Promise.all(
    stockers.map(async (s) => {
      const [requestCount, stockedCount, ledger] = await Promise.all([
        StockRequest.countDocuments({ stocker: s._id }),
        StockRequest.countDocuments({ stocker: s._id, status: "stocked" }),
        getStockerLedgerTotals(s._id),
      ]);
      return { ...s.toObject(), requestCount, stockedCount, ...ledger };
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

  // stocker.totalStocked is a manually-incremented counter (bumped by
  // markStocked / markMyRequestStocked) rather than something computed from
  // real data, so any historical double-execution — like the race condition
  // that existed here before markStocked's approved->stocked transition was
  // made atomic — permanently inflates it with no way to self-correct.
  // Summing item quantities straight from this stocker's actual "stocked"
  // requests is always correct regardless of what happened in the past, so
  // that's what gets shown instead of trusting the stored counter.
  const stockedAgg = await StockRequest.aggregate([
    { $match: { stocker: stocker._id, status: "stocked" } },
    { $unwind: "$items" },
    { $group: { _id: null, total: { $sum: "$items.quantity" } } },
  ]);
  const totalStockedLive = stockedAgg[0]?.total || 0;

  const ledger = await getStockerLedgerTotals(stocker._id);
  const stats = {
    totalRequests: requests.length,
    pendingRequests: requests.filter((r) => r.status === "pending").length,
    approvedRequests: requests.filter((r) => r.status === "approved").length,
    stockedRequests: requests.filter((r) => r.status === "stocked").length,
    rejectedRequests: requests.filter((r) => r.status === "rejected").length,
    ...ledger,
    totalStocked: totalStockedLive,
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
  // Atomically flip approved -> stocked before touching inventory. Two
  // concurrent "mark stocked" calls (double-click, or admin + stocker both
  // acting on the same request) would otherwise both pass a plain status
  // check and both call addStock — permanently double-adding real inventory
  // and double-counting the stocker's commission. Only one caller can win
  // this update; the loser gets null and a clean 400 instead of duplicating
  // the stock.
  const claimed = await StockRequest.findOneAndUpdate(
    { _id: req.params.id, status: "approved" },
    { $set: { status: "stocked" } },
    { new: true }
  );
  if (!claimed) return next(new AppError("Request must be approved before marking as stocked", 400));

  const request = await StockRequest.findById(claimed._id).populate("stocker");
  if (!request) return next(new AppError("Stock request not found", 404));

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

  const saleExists = await StockSale.exists({ "allocations.request": request._id });
  if (saleExists) {
    return next(new AppError("This stock request has recorded sales and cannot be deleted. Keep it for accurate stocker accounting.", 409));
  }

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
       const ledger = await getStockerLedgerTotals(s._id);
       return {
        stocker: { _id: s._id, name: s.name, email: s.email, commissionRate: s.commissionRate },
        totalRequests: total,
        pendingRequests: pending,
        stockedRequests: stocked,
         ...ledger,
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
     const commission = money(allocation.unitRevenue * allocation.quantity * (allocation.commissionRate / 100));
    const paidAmount = paidBySale.get(`${sale._id}:${allocationIndex}`) || 0;
    const remaining = Math.max(0, commission - paidAmount);
    if (remaining <= 0.0001) return;
     unpaidAmount = money(unpaidAmount + remaining);
    deliveries.push({
      saleId: String(sale._id),
      allocationIndex,
      deliveredAt: sale.deliveredAt,
      robloxUsername: sale.customer?.robloxUsername || "Customer",
      orderRef: sale.orderNumber,
      items: [{ name: sale.productName, quantity: allocation.quantity, salePrice: allocation.unitRevenue }],
       revenue: money(allocation.unitRevenue * allocation.quantity),
      commission: remaining,
      commissionRate: allocation.commissionRate,
      unpaidAmount: remaining,
    });
  }));
   return { deliveries, unpaidAmount: money(unpaidAmount), deliveryCount: deliveries.length };
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

  const requestedAmount = req.body?.amount === undefined ? unpaidData.unpaidAmount : money(req.body.amount);
  if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount > unpaidData.unpaidAmount) {
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

  const payoutCommissionRate = saleAllocations.length === 1
    ? money(
      unpaidData.deliveries.find((delivery) =>
        delivery.saleId === saleAllocations[0].sale && delivery.allocationIndex === saleAllocations[0].allocationIndex
      )?.commissionRate
    )
    : null;
  const payout = await StockerPayout.create({
    stocker: stocker._id,
    amount: requestedAmount,
    // Mixed-rate payouts have no single meaningful commission percentage. The
    // exact rate is permanently stored on each paid sale allocation.
    commissionRate: payoutCommissionRate ?? 0,
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

  // Nothing was actually setting this after a payout, so every subsequent
  // payout's periodStart fell back to stocker.createdAt — every payout in a
  // stocker's history displayed "period: [account creation] → today" instead
  // of "since their last payout". The $ amounts were unaffected (those come
  // from unpaid-allocation math, not from this date range) but the payout
  // history shown to admins/stockers was wrong.
  stocker.lastPayoutAt = periodEnd;
  await stocker.save();

  res.json({ success: true, data: { payout } });
});
