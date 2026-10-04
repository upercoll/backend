const router = require("express").Router();
const rateLimit = require("express-rate-limit");
const ctrl = require("../controllers/settingsController");

// Public read of the tax rate so checkout can render the tax line before an
// order exists. The charged amount is always recomputed server-side.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { success: false, message: "Too many requests" },
});

router.get("/tax", publicLimiter, ctrl.getPublicTax);

// Real storefront figures (orders delivered / customers / games / rating) so
// the marketing copy never hardcodes numbers that go stale.
router.get("/public-stats", publicLimiter, ctrl.getPublicStats);

module.exports = router;