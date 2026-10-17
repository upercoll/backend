const Product = require("../models/Product");
const Order = require("../models/Order");
const Customer = require("../models/Customer");
const catchAsync = require("../utils/catchAsync");

/* Live storefront counters (the Home page stats band).
   Every number here is summed from real documents — nothing is hardcoded:
     • itemsInStock    — units still on the shelf. Only tracked inventory is
                         counted (products set to "unlimited" have no real
                         number to add, so they are skipped rather than guessed).
     • itemsSold       — item quantity across orders that were actually paid.
     • customersServed — active customer accounts, deliberately the SAME figure
                         GET /api/settings/public-stats reports as `customers`
                         so the two never disagree on the storefront.
   Cancelled and refunded orders are excluded so a refund never inflates a
   number. Cached in-process for a few minutes: this is unauthenticated and
   runs on every page load. */

const TTL_MS = 5 * 60 * 1000;
const PAID = ["paid", "delivering", "completed"];

let cache = { data: null, at: 0 };

async function computeStats() {
  const [stockAgg, soldAgg, customers] = await Promise.all([
    Product.aggregate([
      { $match: { active: true, outOfStock: { $ne: true }, onHand: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: "$onHand" } } },
    ]),
    Order.aggregate([
      { $match: { status: { $in: PAID } } },
      { $unwind: "$items" },
      { $group: { _id: null, total: { $sum: "$items.quantity" } } },
    ]),
    Customer.countDocuments({ active: true }),
  ]);

  return {
    itemsInStock: Math.max(0, Math.round(stockAgg[0]?.total || 0)),
    itemsSold: Math.max(0, Math.round(soldAgg[0]?.total || 0)),
    customersServed: Math.max(0, Number(customers) || 0),
  };
}

exports.getPublicStats = catchAsync(async (req, res) => {
  if (!cache.data || Date.now() - cache.at > TTL_MS) {
    cache = { data: await computeStats(), at: Date.now() };
  }
  res.json({ success: true, data: cache.data });
});

// used after a bulk import / wipe so the panel can refresh the numbers
exports.invalidateStatsCache = () => {
  cache = { data: null, at: 0 };
};
