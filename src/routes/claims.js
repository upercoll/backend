const router = require("express").Router();
const ctrl = require("../controllers/claimController");
const { protect, adminOnly } = require("../middleware/auth");
const rateLimit = require("express-rate-limit");

const claimCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many claim requests — please wait before trying again" },
});

router.post("/", claimCreateLimiter, ctrl.createClaim);
router.get("/:roomId", ctrl.getSession);
router.post("/:roomId/feedback", ctrl.submitFeedback);
router.patch("/:roomId/user-info", ctrl.updateUserInfo);

router.get("/", protect, adminOnly, ctrl.listClaims);
router.get("/admin/:roomId", protect, adminOnly, ctrl.getFullSession);
router.patch("/:roomId/status", protect, adminOnly, ctrl.updateStatus);

module.exports = router;
