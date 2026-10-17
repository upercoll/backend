const express = require("express");
const rateLimit = require("express-rate-limit");
const statsCtrl = require("../controllers/publicStatsController");
const activityCtrl = require("../controllers/publicActivityController");

const router = express.Router();

// Public storefront data (unauthenticated). Both handlers memoise their
// aggregation for 5 minutes server-side; this limiter is only a backstop.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, message: "Too many requests" },
});

// live counters: items in stock / sold / customers served
router.get("/", publicLimiter, statsCtrl.getPublicStats);

// real store activity (per-game inventory + sales, today's deliveries) that
// backs the storefront "orders delivered" band — never returns any customer PII
router.get("/activity", publicLimiter, activityCtrl.getPublicActivity);

module.exports = router;
