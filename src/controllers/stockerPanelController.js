const Stocker = require("../models/Stocker");
const StockRequest = require("../models/StockRequest");
const StockerPayout = require("../models/StockerPayout");
const Product = require("../models/Product");
const AppError = require("../utils/AppError");
const catchAsync = require("../utils/catchAsync");

exports.getProfile = catchAsync(async (req, res) => {
  const stocker = req.stocker;
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
        totalRevenue: stocker.totalRevenue,
        totalCommission: stocker.totalCommission,
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

  const stockedRequests = await StockRequest.find({ stocker: stocker._id, status: "stocked" }).lean();

  const stockedProductNames = new Set();
  const stockedProductMap = {};
  const stockedQuantityMap = {};

  for (const r of stockedRequests) {
    for (const item of r.items || []) {
      const nameLower = item.productName?.toLowerCase();
      if (nameLower) {
        stockedProductNames.add(nameLower);
        if (!stockedProductMap[nameLower]) {
          stockedProductMap[nameLower] = {
            productName: item.productName,
            imageUrl: item.imageUrl,
            game: item.game || r.game,
            salePrice: item.salePrice || 0,
          };
        }
        stockedQuantityMap[nameLower] = (stockedQuantityMap[nameLower] || 0) + (item.quantity || 1);
      }
    }
  }

  if (stockedProductNames.size === 0) {
    return res.json({ success: true, data: { deliveries: [], total: 0 } });
  }

  const ClaimSession = require("../models/ClaimSession");
  const deliveredSessions = await ClaimSession.find({ status: { $in: ["claimed", "ended"] } })
    .select("robloxUsername items itemName assignedAgent resolvedAt game orderRef createdAt roomId")
    .sort({ resolvedAt: 1 })
    .lean();

  const remainingQty = { ...stockedQuantityMap };
  const deliveries = [];

  for (const session of deliveredSessions) {
    let sessionItems = [...(session.items || [])];
    if (session.itemName && sessionItems.length === 0) {
      sessionItems = [{ name: session.itemName, quantity: 1 }];
    }

    const creditedItems = [];
    for (const item of sessionItems) {
      const key = item.name?.toLowerCase();
      if (!key || !stockedProductNames.has(key)) continue;
      const remaining = remainingQty[key] || 0;
      if (remaining <= 0) continue;
      const creditQty = Math.min(item.quantity || 1, remaining);
      remainingQty[key] -= creditQty;
      creditedItems.push({ ...item, quantity: creditQty, ...(stockedProductMap[key] || {}) });
    }

    if (creditedItems.length > 0) {
      deliveries.push({
        roomId: session.roomId,
        robloxUsername: session.robloxUsername,
        game: session.game,
        orderRef: session.orderRef,
        agentName: session.assignedAgent?.name || "Unknown Agent",
        deliveredAt: session.resolvedAt || session.createdAt,
        items: creditedItems,
      });
    }
  }

  deliveries.sort((a, b) => new Date(b.deliveredAt) - new Date(a.deliveredAt));

  res.json({ success: true, data: { deliveries, total: deliveries.length } });
});

exports.getMyPayouts = catchAsync(async (req, res) => {
  const stocker = req.stocker;

  const stockedRequests = await StockRequest.find({ stocker: stocker._id, status: "stocked" }).lean();
  const stockedProductNames = new Set();
  const stockedProductMap = {};
  const stockedQuantityMap = {};

  for (const r of stockedRequests) {
    for (const item of r.items || []) {
      const nameLower = item.productName?.toLowerCase();
      if (nameLower) {
        stockedProductNames.add(nameLower);
        if (!stockedProductMap[nameLower]) {
          stockedProductMap[nameLower] = {
            productName: item.productName,
            // Commission is based on store price, not the stocker's custom price
            salePrice: item.storePrice || item.salePrice || 0,
          };
        }
        stockedQuantityMap[nameLower] = (stockedQuantityMap[nameLower] || 0) + (item.quantity || 1);
      }
    }
  }

  let unpaidDeliveries = [];
  let unpaidAmount = 0;

  if (stockedProductNames.size > 0) {
    const ClaimSession = require("../models/ClaimSession");
    const since = stocker.lastPayoutAt || stocker.createdAt;
    const deliveredSessions = await ClaimSession.find({
      status: { $in: ["claimed", "ended"] },
      resolvedAt: { $gt: since },
    })
      .select("robloxUsername items itemName assignedAgent resolvedAt game orderRef roomId")
      .sort({ resolvedAt: 1 })
      .lean();

    const remainingQty = { ...stockedQuantityMap };

    for (const session of deliveredSessions) {
      let sessionItems = [...(session.items || [])];
      if (session.itemName && sessionItems.length === 0) {
        sessionItems = [{ name: session.itemName, quantity: 1 }];
      }

      const creditedItems = [];
      let sessionRevenue = 0;

      for (const item of sessionItems) {
        const key = item.name?.toLowerCase();
        if (!key || !stockedProductNames.has(key)) continue;
        const remaining = remainingQty[key] || 0;
        if (remaining <= 0) continue;
        const creditQty = Math.min(item.quantity || 1, remaining);
        remainingQty[key] -= creditQty;
        const salePrice = stockedProductMap[key]?.salePrice || 0;
        sessionRevenue += salePrice * creditQty;
        creditedItems.push({ ...item, quantity: creditQty, salePrice });
      }

      if (creditedItems.length > 0) {
        const sessionCommission = sessionRevenue * (stocker.commissionRate / 100);
        unpaidAmount += sessionCommission;
        unpaidDeliveries.push({
          roomId: session.roomId,
          robloxUsername: session.robloxUsername,
          game: session.game,
          orderRef: session.orderRef,
          agentName: session.assignedAgent?.name || "Unknown",
          deliveredAt: session.resolvedAt,
          items: creditedItems,
          revenue: sessionRevenue,
          commission: sessionCommission,
        });
      }
    }

    unpaidDeliveries.sort((a, b) => new Date(b.deliveredAt) - new Date(a.deliveredAt));
  }

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
      unpaidAmount,
      unpaidDeliveries,
      totalPaid,
    },
  });
});

exports.markMyRequestStocked = catchAsync(async (req, res, next) => {
  const stocker = req.stocker;
  const request = await StockRequest.findOne({ _id: req.params.id, stocker: stocker._id });
  if (!request) return next(new AppError("Stock request not found", 404));
  if (request.status !== "approved") {
    return next(new AppError("Request must be approved before you can mark it as stocked", 400));
  }

  // Update product stock counts
  for (const item of request.items) {
    if (item.product) {
      await Product.findByIdAndUpdate(item.product, {
        $inc: { stock: item.quantity, onHand: item.quantity },
        outOfStock: false,
      });
    }
  }

  // Commission is based on store price, not the stocker's custom price
  const storeBasedTotal = request.items.reduce(
    (sum, item) => sum + (item.storePrice || item.salePrice || 0) * (item.quantity || 1),
    0
  );
  const commission = (storeBasedTotal * (stocker.commissionRate || 0)) / 100;

  request.status = "stocked";
  request.stockedAt = new Date();
  request.stockedBy = stocker.email;
  request.commission = commission;
  request.commissionRate = stocker.commissionRate;
  request.paymentSent = true;

  await request.save();

  await Stocker.findByIdAndUpdate(stocker._id, {
    $inc: {
      totalRevenue: storeBasedTotal,
      totalCommission: commission,
      totalStocked: request.items.reduce((sum, i) => sum + (i.quantity || 1), 0),
    },
  });

  res.json({ success: true, data: { request } });
});

exports.getMyStats = catchAsync(async (req, res) => {
  const stocker = req.stocker;

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
        totalRevenue: stocker.totalRevenue,
        totalCommission: stocker.totalCommission,
        commissionRate: stocker.commissionRate,
      },
      recentRequests: requests.slice(0, 10),
      productBreakdown: Object.values(productStats),
    },
  });
});
