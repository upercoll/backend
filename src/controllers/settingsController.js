const Setting = require("../models/Setting");
const Order = require("../models/Order");
const Customer = require("../models/Customer");
const Game = require("../models/Game");
const ClaimSession = require("../models/ClaimSession");
const catchAsync = require("../utils/catchAsync");
const { getTaxSettings } = require("../utils/tax");

exports.getSettings = catchAsync(async (req, res) => {
  let settings = await Setting.findOne();
  if (!settings) {
    settings = await Setting.create({});
  }
  res.json({ success: true, data: settings });
});

exports.updateSettings = catchAsync(async (req, res) => {
  const allowed = ["salesTaxRate", "taxLabel", "taxEnabled"];
  const update = Object.fromEntries(
    Object.entries(req.body).filter(([k]) => allowed.includes(k))
  );

  let settings = await Setting.findOneAndUpdate({}, update, {
    new: true,
    upsert: true,
    runValidators: true,
  });

  res.json({ success: true, data: settings });
});

/**
 * GET /api/settings/tax — PUBLIC.
 *
 * The checkout page has to show the tax line before the order exists, and the
 * final amount is always recomputed server-side — this only feeds display, so a
 * tampered response could never change what is charged.
 */
exports.getPublicTax = catchAsync(async (req, res) => {
  const tax = await getTaxSettings();
  res.json({
    success: true,
    data: {
      enabled: tax.enabled,
      rate: tax.rate,
      label: tax.label,
    },
  });
});

/**
 * GET /api/settings/public-stats — PUBLIC.
 *
 * Real storefront figures (orders delivered, customers, games, review rating)
 * so the marketing copy never has to hardcode numbers that go stale or get
 * proven wrong. Read-only counts of already-public facts — no revenue, no
 * customer PII, nothing an attacker can leverage.
 *
 * Cached for 60s: the homepage polls this on every load and recounting four
 * collections each time is wasted work.
 */
const STATS_CACHE_MS = 60 * 1000;
let statsCache = { at: 0, data: null };

exports.getPublicStats = catchAsync(async (req, res) => {
  if (statsCache.data && Date.now() - statsCache.at < STATS_CACHE_MS) {
    return res.json({ success: true, data: statsCache.data, cached: true });
  }

  const [delivered, customers, games, reviewAgg] = await Promise.all([
    Order.countDocuments({ "delivery.status": "delivered" }),
    Customer.countDocuments({ active: true }),
    Game.countDocuments({ active: true }),
    ClaimSession.aggregate([
      { $match: { "feedback.rating": { $exists: true, $ne: null } } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          avg: { $avg: "$feedback.rating" },
        },
      },
    ]),
  ]);

  const reviewCount = reviewAgg[0]?.count || 0;
  const data = {
    ordersDelivered: delivered,
    customers,
    games,
    reviews: reviewCount,
    // Round to 1dp; 0 when nobody has reviewed yet (the UI omits the badge).
    rating: reviewCount > 0 ? Math.round(reviewAgg[0].avg * 10) / 10 : 0,
  };

  statsCache = { at: Date.now(), data };
  res.json({ success: true, data });
});
