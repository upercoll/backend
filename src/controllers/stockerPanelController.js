const Stocker = require("../models/Stocker");
const StockRequest = require("../models/StockRequest");
const StockerPayout = require("../models/StockerPayout");
const Product = require("../models/Product");
const StockSale = require("../models/StockSale");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");
const { addStock } = require("../services/stockService");
const money = (value) => Number((Number(value) || 0).toFixed(2));

async function getDeliveredLedgerTotals(stockerId) {
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

exports.getProfile = catchAsync(async (req, res) => {
  const stocker = req.stocker;
  const ledger = await getDeliveredLedgerTotals(stocker._id);
  res.json({
    success: true,
    data: {
      stocker: {
        id: stocker._id,
        email: stocker.email,
        name: stocker.name,
        games: stocker.games,
        commissionRate: stocker.commissionRate,
        totalStocked: stocker.totalStocked,
       ...ledger,
        status: stocker.status,
        cryptoAddress: stocker.cryptoAddress,
        cryptoNetwork: stocker.cryptoNetwork,
        lastPayoutAt: stocker.lastPayoutAt,
      },
    },
  });
});

exports.getProducts = catchAsync(async (req, res) => {
  const { game } = req.query;
  const filter = { active: true };
  if (game) filter.game = game;

  const products = await Product.find(filter)
    .select("name slug game category price imageUrl images gradient stock onHand outOfStock featured")
    .populate("category", "name slug")
    .sort({ game: 1, name: 1 });

  const ClaimSession = require("../models/ClaimSession");
  const activeSessions = await ClaimSession.find({ status: { $in: ["pending", "active"] } })
    .select("items")
    .lean();

  const pendingByName = {};
  for (const session of activeSessions) {
    for (const item of session.items || []) {
      if (item.name) {
        const key = item.name.toLowerCase();
        pendingByName[key] = (pendingByName[key] || 0) + (item.quantity || 1);
      }
    }
  }

  const productsWithOnHand = products.map(p => {
    const obj = p.toObject();
    const pendingClaims = pendingByName[p.name.toLowerCase()] || 0;
    obj.pendingClaims = pendingClaims;

    const physicalStock = p.onHand !== undefined && p.onHand >= 0 ? p.onHand : (p.stock >= 0 ? p.stock : -1);
    obj.onHand = physicalStock;
    obj.availableForSale = physicalStock < 0 ? -1 : Math.max(0, physicalStock - pendingClaims);
    return obj;
  });

  res.json({ success: true, data: { products: productsWithOnHand } });
});

exports.getMyRequests = catchAsync(async (req, res) => {
  const stocker = req.stocker;
  const requests = await StockRequest.find({ stocker: stocker._id })
    .sort({ createdAt: -1 })
    .limit(50);

  res.json({ success: true, data: { requests } });
});

exports.submitRequest = catchAsync(async (req, res, next) => {
  const stocker = req.stocker;
  const { game, items } = req.body;

  if (!game) return next(new AppError("Game is required", 400));
  if (!items || !Array.isArray(items) || items.length === 0) {
    return next(new AppError("At least one item is required", 400));
  }

  const enrichedItems = [];
  let totalSaleValue = 0;

  for (const item of items) {
    if (!item.productId || !item.quantity || item.quantity < 1) {
      return next(new AppError("Each item needs a product and quantity", 400));
    }

    const product = await Product.findById(item.productId);
    if (!product || !product.active) {
      return next(new AppError(`Product not found: ${item.productId}`, 404));
    }

    const storePrice = product.price;
    const customPrice = item.customPrice != null && item.customPrice > 0
      ? parseFloat(item.customPrice)
      : null;
    const effectivePrice = customPrice !== null ? customPrice : storePrice;
    const itemTotal = effectivePrice * item.quantity;
    totalSaleValue += itemTotal;

    enrichedItems.push({
      product: product._id,
      productName: product.name,
      productSlug: product.slug,
      game: product.game,
      imageUrl: product.imageUrl || (product.images && product.images[0]) || "",
      gradient: product.gradient,
      quantity: item.quantity,
      storePrice,
      customPrice: customPrice !== null ? customPrice : undefined,
      salePrice: effectivePrice,
      totalSaleValue: itemTotal,
    });
  }

  const request = await StockRequest.create({
    stocker: stocker._id,
    stockerName: stocker.name,
    stockerEmail: stocker.email,
    game,
    items: enrichedItems,
    totalSaleValue,
    status: "pending",
  });

  try {
    const { getIO } = require("../config/socket");
    const io = getIO();
    if (io) {
      io.to("admin-room").emit("stock:new_request", {
        requestId: request._id,
        stockerName: stocker.name,
        game,
        itemCount: enrichedItems.length,
        totalSaleValue,
      });
    }
  } catch (e) {}

  res.status(201).json({ success: true, data: { request } });
});

exports.getSoldDeliveries = catchAsync(async (req, res) => {
  const stocker = req.stocker;
  const sales = await StockSale.find({
    deliveredAt: { $exists: true },
    "allocations.stocker": stocker._id,
  }).sort({ deliveredAt: -1 }).lean();
  const deliveries = sales.map((sale) => {
    const allocations = sale.allocations.filter((allocation) => String(allocation.stocker) === String(stocker._id));
    return {
      roomId: sale.claimRoomId,
      robloxUsername: sale.customer?.robloxUsername || "Customer",
      orderRef: sale.orderNumber,
      deliveredAt: sale.deliveredAt,
      items: allocations.map((allocation) => ({
        name: sale.productName,
        quantity: allocation.quantity,
        salePrice: allocation.unitRevenue,
      })),
    };
  });

  res.json({ success: true, data: { deliveries, total: deliveries.length } });
});

exports.getMyPayouts = catchAsync(async (req, res) => {
  const stocker = req.stocker;
  const unpaidData = await getUnpaidSaleAllocations(stocker);

  const payouts = await StockerPayout.find({ stocker: stocker._id }).sort({ createdAt: -1 });
  const totalPaid = payouts.reduce((sum, p) => sum + p.amount, 0);

  res.json({
    success: true,
    data: {
      stocker: {
        id: stocker._id,
        name: stocker.name,
        email: stocker.email,
        commissionRate: stocker.commissionRate,
        lastPayoutAt: stocker.lastPayoutAt,
        cryptoAddress: stocker.cryptoAddress,
        cryptoNetwork: stocker.cryptoNetwork,
      },
      payouts,
      unpaidAmount: unpaidData.unpaidAmount,
      unpaidDeliveries: unpaidData.deliveries,
      totalPaid,
    },
  });
});

async function getUnpaidSaleAllocations(stocker) {
  const paidPayouts = await StockerPayout.find({ stocker: stocker._id }).select("saleAllocations").lean();
  const paidBySale = new Map();
  for (const payout of paidPayouts) {
    for (const allocation of payout.saleAllocations || []) {
      const key = `${allocation.sale}:${allocation.allocationIndex}`;
      paidBySale.set(key, (paidBySale.get(key) || 0) + allocation.amount);
    }
  }

  const sales = await StockSale.find({
    deliveredAt: { $exists: true },
    "allocations.stocker": stocker._id,
  }).sort({ deliveredAt: 1 }).lean();
  const deliveries = [];
  let unpaidAmount = 0;

  for (const sale of sales) {
    sale.allocations.forEach((allocation, allocationIndex) => {
      if (String(allocation.stocker) !== String(stocker._id)) return;
       const revenue = money(allocation.unitRevenue * allocation.quantity);
       const commission = money(revenue * (allocation.commissionRate / 100));
      const paidAmount = paidBySale.get(`${sale._id}:${allocationIndex}`) || 0;
      const remaining = Math.max(0, commission - paidAmount);
      if (remaining <= 0.0001) return;
       unpaidAmount = money(unpaidAmount + remaining);
      deliveries.push({
        saleId: String(sale._id),
        allocationIndex,
        roomId: sale.claimRoomId,
        robloxUsername: sale.customer?.robloxUsername || "Customer",
        orderRef: sale.orderNumber,
        deliveredAt: sale.deliveredAt,
        items: [{ name: sale.productName, quantity: allocation.quantity, salePrice: allocation.unitRevenue }],
        revenue,
        commission: remaining,
       commissionRate: allocation.commissionRate,
      });
    });
  }
   return { deliveries: deliveries.reverse(), unpaidAmount: money(unpaidAmount) };
}

exports.markMyRequestStocked = catchAsync(async (req, res, next) => {
  const stocker = req.stocker;
  // Same atomic-claim guard as the admin markStocked path: flip approved ->
  // stocked first so a double-click (or a race with the admin panel doing
  // the same thing) can't both pass the status check and both add real
  // inventory twice.
  const claimed = await StockRequest.findOneAndUpdate(
    { _id: req.params.id, stocker: stocker._id, status: "approved" },
    { $set: { status: "stocked" } },
    { new: true }
  );
  if (!claimed) return next(new AppError("Request must be approved before you can mark it as stocked", 400));

  const request = await StockRequest.findOne({ _id: claimed._id, stocker: stocker._id });
  if (!request) return next(new AppError("Stock request not found", 404));

  // Update product stock counts
  for (const item of request.items) {
    if (item.product) await addStock(item.product, item.quantity);
    item.remainingQuantity = item.quantity;
    item.soldQuantity = 0;
  }

  // Commission is based on store price, not the stocker's custom price
  const storeBasedTotal = request.items.reduce(
    (sum, item) => sum + (item.storePrice || item.salePrice || 0) * (item.quantity || 1),
    0
  );
  const commission = (storeBasedTotal * (stocker.commissionRate || 0)) / 100;

  request.stockedAt = new Date();
  request.stockedBy = stocker.email;
  request.commission = commission;
  request.commissionRate = stocker.commissionRate;
  request.paymentSent = true;

  await request.save();

  await Stocker.findByIdAndUpdate(stocker._id, {
    $inc: {
      totalStocked: request.items.reduce((sum, i) => sum + (i.quantity || 1), 0),
    },
  });

  res.json({ success: true, data: { request } });
});

exports.getMyStats = catchAsync(async (req, res) => {
  const stocker = req.stocker;
  const ledger = await getDeliveredLedgerTotals(stocker._id);

  const requests = await StockRequest.find({ stocker: stocker._id });
  const stocked = requests.filter((r) => r.status === "stocked");

  const productStats = {};
  for (const req of stocked) {
    for (const item of req.items) {
      const key = item.product?.toString() || item.productName;
      if (!productStats[key]) {
        productStats[key] = {
          productName: item.productName,
          imageUrl: item.imageUrl,
          game: item.game,
          quantityStocked: 0,
          totalValue: 0,
        };
      }
      productStats[key].quantityStocked += item.quantity;
      productStats[key].totalValue += item.totalSaleValue;
    }
  }

  res.json({
    success: true,
    data: {
      stats: {
        totalRequests: requests.length,
        pendingRequests: requests.filter((r) => r.status === "pending").length,
        approvedRequests: requests.filter((r) => r.status === "approved").length,
        stockedRequests: stocked.length,
        rejectedRequests: requests.filter((r) => r.status === "rejected").length,
        totalStocked: stocker.totalStocked,
         ...ledger,
        commissionRate: stocker.commissionRate,
      },
      recentRequests: requests.slice(0, 10),
      productBreakdown: Object.values(productStats),
    },
  });
});
