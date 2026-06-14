const router = require("express").Router();
const ctrl = require("../controllers/adminController");
const { protect, adminOnly, supportOrAdmin } = require("../middleware/auth");

router.use(protect);

router.get("/dashboard", supportOrAdmin, ctrl.getDashboard);

router.get("/users", adminOnly, ctrl.getUsers);
router.post("/users", adminOnly, ctrl.createUser);
router.patch("/users/:id", adminOnly, ctrl.updateUser);
router.delete("/users/:id", adminOnly, ctrl.deleteUser);

module.exports = router;
