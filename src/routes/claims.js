const router = require("express").Router();
const ctrl = require("../controllers/claimController");
const { protect, adminOnly } = require("../middleware/auth");
const rateLimit = require("express-rate-limit");
const { upload } = require("../config/r2");
const { withRoomLock } = require("../utils/roomLock");

const claimCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: "Too many claim requests — please wait before trying again" },
});

const autoQueueLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: { success: false, message: "Too many queue polls — slow down" },
});

const autoClaimLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { success: false, message: "Too many auto delivery actions — slow down" },
});

router.get("/public-reviews", ctrl.getPublicReviews);

router.post("/", claimCreateLimiter, ctrl.createClaim);
router.post("/auto", claimCreateLimiter, ctrl.createAutoDelivery);

// Public auto-delivery bot endpoints (no deliverer login needed).
// NOTE: must be registered BEFORE the /:roomId routes or "auto-queue" would
// be captured as a roomId.
router.get("/auto-queue", autoQueueLimiter, ctrl.getAutoQueue);
// Both handlers below do unguarded read-modify-write on the same session
// document, so serialise them per room — two bot accounts hitting one order
// concurrently could otherwise double-reserve or double-credit quantities.
router.post("/auto/:roomId/claim", autoClaimLimiter, (req, res, next) =>
  withRoomLock(req.params.roomId, () => ctrl.claimAutoSession(req, res, next))
);
router.post("/auto/:roomId/deliver", autoClaimLimiter, (req, res, next) =>
  withRoomLock(req.params.roomId, () => ctrl.deliverAutoSession(req, res, next))
);
router.post("/auto/log", autoClaimLimiter, ctrl.logBotEvent);
router.get("/admin/auto-logs", protect, adminOnly, ctrl.listAutoBotLogs);

router.get("/:roomId/status", ctrl.getSessionStatus);
router.get("/:roomId", ctrl.getSession);
router.post("/:roomId/feedback", upload.single("proofImage"), ctrl.submitFeedback);
router.patch("/:roomId/user-info", ctrl.updateUserInfo);

router.get("/", protect, adminOnly, ctrl.listClaims);
router.get("/admin/:roomId", protect, adminOnly, ctrl.getFullSession);
router.patch("/:roomId/status", protect, adminOnly, ctrl.updateStatus);

module.exports = router;
