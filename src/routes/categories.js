const router = require("express").Router();
const ctrl = require("../controllers/categoryController");
const { protect, adminOnly } = require("../middleware/auth");

router.get("/", ctrl.getAll);
router.get("/game/:game", ctrl.getByGame);
router.get("/:id", ctrl.getOne);

router.post("/", protect, adminOnly, ctrl.create);
router.put("/:id", protect, adminOnly, ctrl.update);
router.patch("/:id", protect, adminOnly, ctrl.update);
router.delete("/:id", protect, adminOnly, ctrl.delete);
router.post("/:id/subcategories", protect, adminOnly, ctrl.addSubcategory);
router.delete("/:id/subcategories/:subId", protect, adminOnly, ctrl.removeSubcategory);

module.exports = router;
