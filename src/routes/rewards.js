const router = require("express").Router();
const ctrl = require("../controllers/rewardController");
const { protectCustomer } = require("../middleware/customerAuth");
const rateLimit = require("express-rate-limit");

// Rewards create real money-off codes — keep a tight leash on attempts.
// (The daily spin already self-limits to 1/day/customer server-side.)
const rewardLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { success: false, message: "Too many reward requests — please wait a moment" },
});

router.get("/claims", protectCustomer, ctrl.getClaims);
router.post("/spin", protectCustomer, rewardLimiter, ctrl.spin);
router.post("/claim-level", protectCustomer, rewardLimiter, ctrl.claimLevel);

module.exports = router;
