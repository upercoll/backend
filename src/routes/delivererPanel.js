const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const Deliverer = require("../models/Deliverer");
const AppError = require("../utils/AppError");
const authCtrl = require("../controllers/delivererAuthController");
const panelCtrl = require("../controllers/delivererPanelController");

async function delivererAuth(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer "))
      return next(new AppError("Not authenticated", 401));
    const token = header.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return next(new AppError("Invalid or expired token", 401));
    }
    if (decoded.type !== "deliverer") return next(new AppError("Invalid token type", 401));
    const deliverer = await Deliverer.findById(decoded.id);
    if (!deliverer || deliverer.status !== "active")
      return next(new AppError("Account inactive", 401));
    req.deliverer = deliverer;
    next();
  } catch (err) {
    next(err);
  }
}

// Public auth routes
router.post("/auth/login", authCtrl.login);
router.get("/auth/invite/:token", authCtrl.validateInvite);
router.post("/auth/invite/:token/send-code", authCtrl.sendVerificationCode);
router.post("/auth/invite/:token/verify", authCtrl.verifyAndActivate);

// Protected routes
router.use(delivererAuth);

router.get("/auth/me", authCtrl.me);
router.get("/stats", panelCtrl.getStats);
router.get("/claims", panelCtrl.getClaims);
router.get("/claims/:roomId", panelCtrl.getSession);
router.post("/claims/:roomId/claim", panelCtrl.claimSession);
router.post("/claims/:roomId/deliver", panelCtrl.markDelivered);
router.post("/claims/:roomId/message", panelCtrl.sendMessage);

module.exports = router;
