const router = require("express").Router();
const ctrl = require("../controllers/orderController");
const { protect, adminOnly, supportOrAdmin } = require("../middleware/auth");
const { protectCustomer } = require("../middleware/customerAuth");

router.get("/track/:orderNumber", ctrl.getByOrderNumber);

/* Buyer's own orders — before /:id so "my" is never read as an id. */
router.get("/my", protectCustomer, ctrl.getMyOrders);

router.get("/", protect, supportOrAdmin, ctrl.getAll);
router.get("/stats", protect, supportOrAdmin, ctrl.getStats);
router.get("/ref/:orderNumber", protect, supportOrAdmin, ctrl.getByRef);
router.patch("/ref/:orderNumber/status", protect, supportOrAdmin, ctrl.updateStatusByRef);
router.get("/:id", protect, supportOrAdmin, ctrl.getOne);
router.patch("/:id/status", protect, supportOrAdmin, ctrl.updateStatus);

module.exports = router;
