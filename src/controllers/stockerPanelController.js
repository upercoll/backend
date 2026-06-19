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

    const itemTotal = product.price * item.quantity;
    totalSaleValue += itemTotal;

    enrichedItems.push({
      product: product._id,
      productName: product.name,
      productSlug: product.slug,
      game: product.game,
      imageUrl: product.imageUrl || (product.images && product.images[0]) || "",
      gradient: product.gradient,
      quantity: item.quantity,
      salePrice: product.price,
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
      }
    }
  }

  if (stockedProductNames.size === 0) {
    return res.json({ success: true, data: { deliveries: [], total: 0 } });
  }

  const ClaimSession = require("../models/ClaimSession");
  const deliveredSessions = await ClaimSession.find({ status: { $in: ["claimed", "ended"] } })
    .select("robloxUsername items itemName assignedAgent resolvedAt game orderRef createdAt roomId")
    .sort({ resolvedAt: -1 })
    .lean();

  const deliveries = [];
  for (const session of deliveredSessions) {
    let sessionItems = [...(session.items || [])];
    if (session.itemName && sessionItems.length === 0) {
      sessionItems = [{ name: session.itemName, quantity: 1 }];
    }

    const matchedItems = sessionItems.filter(item => item.name && stockedProductNames.has(item.name.toLowerCase()));

    if (matchedItems.length > 0) {
      deliveries.push({
        roomId: session.roomId,
        robloxUsername: session.robloxUsername,
        game: session.game,
        orderRef: session.orderRef,
        agentName: session.assignedAgent?.name || "Unknown Agent",
        deliveredAt: session.resolvedAt || session.createdAt,
        items: matchedItems.map(item => ({ ...item, ...(stockedProductMap[item.name?.toLowerCase()] || {}) })),
      });
    }
  }

  res.json({ success: true, data: { deliveries, total: deliveries.length } });
});

exports.getMyPayouts = catchAsync(async (req, res) => {
  const stocker = req.stocker;

  const stockedRequests = await StockRequest.find({ stocker: stocker._id, status: "stocked" }).lean();
  const stockedProductNames = new Set();
  const stockedProductMap = {};
  for (const r of stockedRequests) {
    for (const item of r.items || []) {
      const nameLower = item.productName?.toLowerCase();
      if (nameLower) {
        stockedProductNames.add(nameLower);
        if (!stockedProductMap[nameLower]) {
          stockedProductMap[nameLower] = {
            productName: item.productName,
            salePrice: item.salePrice || 0,
          };
        }
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
      .sort({ resolvedAt: -1 })
      .lean();

    for (const session of deliveredSessions) {
      let sessionItems = [...(session.items || [])];
      if (session.itemName && sessionItems.length === 0) {
        sessionItems = [{ name: session.itemName, quantity: 1 }];
      }
      const matchedItems = sessionItems.filter(item => item.name && stockedProductNames.has(item.name.toLowerCase()));
      if (matchedItems.length > 0) {
        let sessionRevenue = 0;
        const itemsWithPrice = matchedItems.map(item => {
          const key = item.name?.toLowerCase();
          const salePrice = stockedProductMap[key]?.salePrice || 0;
          const qty = item.quantity || 1;
          sessionRevenue += salePrice * qty;
          return { ...item, salePrice };
        });
        const sessionCommission = sessionRevenue * (stocker.commissionRate / 100);
        unpaidAmount += sessionCommission;
        unpaidDeliveries.push({
          roomId: session.roomId,
          robloxUsername: session.robloxUsername,
          game: session.game,
          orderRef: session.orderRef,
          agentName: session.assignedAgent?.name || "Unknown",
          deliveredAt: session.resolvedAt,
          items: itemsWithPrice,
          revenue: sessionRevenue,
          commission: sessionCommission,
        });
      }
    }
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
