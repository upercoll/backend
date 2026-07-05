const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/deliverersAdminController");
const { panelAuth, ownerOnly } = require("../middleware/panelAuth");

router.use(panelAuth);

router.get("/", ctrl.listDeliverers);
router.post("/invite", ownerOnly, ctrl.inviteDeliverer);
router.get("/:id", ctrl.getDelivererDetail);
router.patch("/:id", ownerOnly, ctrl.updateDeliverer);
router.post("/:id/mark-paid", ownerOnly, ctrl.markPaid);
router.delete("/:id", ownerOnly, ctrl.deleteDeliverer);

module.exports = router;
