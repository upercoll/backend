const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/collaboratorController");
const socialCtrl = require("../controllers/socialController");
const { panelAuth, ownerOnly } = require("../middleware/panelAuth");
const jwt = require("jsonwebtoken");
const AppError = require("../utils/AppError");

function collabAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return next(new AppError("Authentication required", 401));
  const token = auth.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "collab_secret_key");
    if (decoded.type !== "collaborator") return next(new AppError("Invalid token type", 401));
    req.collabUser = decoded;
    next();
  } catch {
    return next(new AppError("Invalid or expired token", 401));
  }
}

router.get("/invite/:token", ctrl.validateInviteToken);
router.post("/invite/:token/send-code", ctrl.sendVerificationCode);
router.post("/invite/:token/verify", ctrl.verifyAndActivate);
router.post("/login", ctrl.collabLogin);

router.get("/me", collabAuth, ctrl.collabMe);

// ── Creator social endpoints (collabAuth) ──────────────────────────────────
router.get("/social/my",          collabAuth, socialCtrl.creatorGetMy);
router.get("/social/stats",       collabAuth, socialCtrl.creatorGetStats);
router.get("/social/payouts",     collabAuth, socialCtrl.creatorGetPayouts);
router.post("/social/preview",    collabAuth, socialCtrl.creatorPreview);
router.post("/social/submit",     collabAuth, socialCtrl.creatorSubmit);
router.post("/social/:id/accept", collabAuth, socialCtrl.creatorAccept);

router.use(panelAuth);
router.use(ownerOnly);

router.get("/", ctrl.listCollaborators);
router.post("/invite", ctrl.inviteCollaborator);
router.get("/payouts", ctrl.listPayouts);
router.get("/:id", ctrl.getCollaborator);
router.delete("/:id", ctrl.deleteCollaborator);
router.get("/:id/available-products", ctrl.getAvailableProducts);
router.post("/:id/products", ctrl.addProduct);
router.patch("/:id/products/:cpId", ctrl.updateProduct);
router.delete("/:id/products/:cpId", ctrl.removeProduct);
router.get("/:id/payouts", ctrl.getCollaboratorPayouts);
router.get("/:id/payouts/:payoutId", ctrl.getPayoutDetail);
router.post("/:id/payouts/mark-paid", ctrl.markPayoutPaid);

module.exports = router;
