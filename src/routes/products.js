const router = require("express").Router();
const ctrl = require("../controllers/productController");
const { protect, adminOnly, supportOrAdmin } = require("../middleware/auth");

router.get("/", ctrl.getAll);
router.get("/featured", ctrl.getFeatured);
router.get("/best-sellers", ctrl.getBestSellers);
router.get("/game/:game", ctrl.getByGame);
router.get("/:id/related", ctrl.getRelated);
router.get("/:id", ctrl.getOne);

router.post("/", protect, adminOnly, ctrl.create);
router.put("/:id", protect, adminOnly, ctrl.update);
router.patch("/:id", protect, adminOnly, ctrl.update);
router.delete("/:id", protect, adminOnly, ctrl.delete);
router.patch("/:id/toggle-stock", protect, supportOrAdmin, ctrl.toggleStock);

module.exports = router;
