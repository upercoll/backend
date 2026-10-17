const Product = require("../models/Product");
const Order = require("../models/Order");
const Game = require("../models/Game");
const catchAsync = require("../utils/catchAsync");

/* Public "store activity" feed that replaces the old fake review marquee.
   Everything returned here is aggregated from real documents — no invented
   people, quotes or ratings, and no customer PII (no emails, usernames or
   order numbers ever leave this endpoint).

     • itemsDeliveredToday — units on orders completed since UTC midnight
     • ordersToday         — orders completed since UTC midnight
     • deliveredAllTime    — orders ever completed
     • games[]             — per-game real inventory + lifetime sales, so the
                             storefront can show genuine activity per game

   Cached in-process for 5 minutes: unauthenticated and hit on every home load. */

const TTL_MS = 5 * 60 * 1000;
const DONE = ["paid", "delivering", "completed"];

let cache = { data: null, at: 0 };

function startOfUtcDay() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function computeActivity() {
  const midnight = startOfUtcDay();

  const [todayAgg, allTimeAgg, gameAgg, games] = await Promise.all([
    Order.aggregate([
      { $match: { status: { $in: DONE }, fulfilledAt: { $gte: midnight } } },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          units: { $sum: { $sum: "$items.quantity" } },
        },
      },
    ]),
    Order.aggregate([
      { $match: { status: { $in: DONE } } },
      { $group: { _id: null, orders: { $sum: 1 } } },
    ]),
    // real per-game inventory + lifetime units sold (salesCount is incremented
    // by the stock service at checkout, so these are genuine figures)
    Product.aggregate([
      { $match: { active: true } },
      {
        $group: {
          _id: "$game",
          inStock: {
            $sum: { $cond: [{ $and: [{ $ne: ["$outOfStock", true] }, { $gte: [{ $ifNull: ["$onHand", 0] }, 0] }] }, 1, 0] },
          },
          sold: { $sum: { $ifNull: ["$salesCount", 0] } },
          items: { $sum: 1 },
        },
      },
      { $match: { items: { $gte: 1 } } },
      { $sort: { sold: -1, items: -1 } },
      { $limit: 8 },
    ]),
    // names + art for the slugs above (active storefront games only)
    Game.find({ active: true }).select("slug name imageUrl gradient").lean(),
  ]);

  const today = todayAgg[0] || { orders: 0, units: 0 };
  const bySlug = new Map(games.map((g) => [String(g.slug), g]));

  const enriched = gameAgg
    .map((g) => {
      const slug = String(g._id || "").trim();
      const meta = bySlug.get(slug);
      // hide products belonging to a game that is no longer on the storefront
      if (!meta) return null;
      return {
        slug,
        name: meta.name || slug,
        imageUrl: meta.imageUrl || "",
        gradient: meta.gradient || null,
        inStock: Math.max(0, Math.round(g.inStock || 0)),
        sold: Math.max(0, Math.round(g.sold || 0)),
        items: Math.max(0, Math.round(g.items || 0)),
      };
    })
    .filter(Boolean);

  return {
    itemsDeliveredToday: Math.max(0, Math.round(today.units || 0)),
    ordersToday: Math.max(0, Math.round(today.orders || 0)),
    deliveredAllTime: Math.max(0, Math.round(allTimeAgg[0]?.orders || 0)),
    games: enriched,
  };
}

exports.getPublicActivity = catchAsync(async (req, res) => {
  if (!cache.data || Date.now() - cache.at > TTL_MS) {
    cache = { data: await computeActivity(), at: Date.now() };
  }
  res.json({ success: true, data: cache.data });
});

exports.invalidateActivityCache = () => {
  cache = { data: null, at: 0 };
};
