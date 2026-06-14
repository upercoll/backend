const router = require("express").Router();
const ctrl = require("../controllers/promoController");
const { protect, adminOnly } = require("../middleware/auth");
const rateLimit = require("express-rate-limit");

const promoValidateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  message: { success: false, message: "Too many promo code attempts — please wait a moment" },
});

router.post("/validate", promoValidateLimiter, ctrl.validate);

router.get("/", protect, adminOnly, ctrl.getAll);
router.get("/:id", protect, adminOnly, ctrl.getOne);
router.get("/:id/stats", protect, adminOnly, ctrl.getStats);
router.post("/", protect, adminOnly, ctrl.create);
router.patch("/:id", protect, adminOnly, ctrl.update);
router.delete("/:id", protect, adminOnly, ctrl.delete);

module.exports = router;
