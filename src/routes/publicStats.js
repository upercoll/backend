const express = require("express");
const rateLimit = require("express-rate-limit");
const statsCtrl = require("../controllers/publicStatsController");

const router = express.Router();

// Public storefront data (unauthenticated). The handler memoises its
// aggregation for 5 minutes server-side; this limiter is only a backstop.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, message: "Too many requests" },
});

// live counters: items in stock / sold / customers served
router.get("/", publicLimiter, statsCtrl.getPublicStats);

module.exports = router;
