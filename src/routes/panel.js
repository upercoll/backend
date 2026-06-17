const express = require("express");
const router = express.Router();
const { upload } = require("../config/cloudinary");
const { panelAuth, requirePermission, ownerOnly } = require("../middleware/panelAuth");

const panelAuthCtrl = require("../controllers/panelAuthController");
const rolesCtrl = require("../controllers/rolesController");
const teamCtrl = require("../controllers/teamController");
const analyticsCtrl = require("../controllers/analyticsController");
const siteContentCtrl = require("../controllers/siteContentController");
const gamesCtrl = require("../controllers/gamesController");
const proofCtrl = require("../controllers/proofController");
const agentStatsCtrl = require("../controllers/agentStatsController");
const uploadCtrl = require("../controllers/uploadController");
const profileCtrl = require("../controllers/profileController");
const panelOrdersCtrl = require("../controllers/panelOrdersController");
const categoryCtrl = require("../controllers/categoryController");
const productCtrl = require("../controllers/productController");
const promoCtrl = require("../controllers/promoController");
const settingsCtrl = require("../controllers/settingsController");
const stockCtrl = require("../controllers/stockController");

router.post("/auth/owner-login", panelAuthCtrl.ownerLogin);
router.post("/auth/member-login", panelAuthCtrl.memberLogin);
router.get("/auth/invite/:token", panelAuthCtrl.validateInviteToken);
router.post("/auth/invite/:token/send-code", panelAuthCtrl.sendVerificationCode);
router.post("/auth/invite/:token/verify", panelAuthCtrl.verifyCodeAndActivate);

router.use(panelAuth);

router.get("/auth/me", panelAuthCtrl.me);
router.post("/auth/logout", panelAuthCtrl.logout);

router.get("/profile", profileCtrl.getProfile);
router.patch("/profile", profileCtrl.updateProfile);
router.post("/profile/picture", upload.single("image"), profileCtrl.uploadProfilePicture);
router.patch("/profile/password", profileCtrl.changePassword);

router.get("/analytics/dashboard", requirePermission("view_analytics"), analyticsCtrl.getDashboard);
router.get("/analytics/revenue", requirePermission("view_analytics"), analyticsCtrl.getRevenueChart);
router.get("/analytics/by-game", requirePermission("view_analytics"), analyticsCtrl.getOrdersByGame);
router.get("/analytics/top-products", requirePermission("view_analytics"), analyticsCtrl.getTopProducts);
router.get("/analytics/claims", requirePermission("view_analytics"), analyticsCtrl.getClaimStats);
router.get("/analytics/sales-summary", requirePermission("view_analytics"), analyticsCtrl.getSalesSummary);
router.get("/analytics/conversion", requirePermission("view_analytics"), analyticsCtrl.getConversionRate);
router.get("/analytics/stocker-commissions", ownerOnly, stockCtrl.getStockerStats);

router.get("/roles/permissions", requirePermission("manage_roles"), rolesCtrl.getPermissions);
router.get("/roles", requirePermission("manage_roles"), rolesCtrl.listRoles);
router.get("/roles/:id", requirePermission("manage_roles"), rolesCtrl.getRole);
router.post("/roles", requirePermission("manage_roles"), rolesCtrl.createRole);
router.patch("/roles/:id", requirePermission("manage_roles"), rolesCtrl.updateRole);
router.delete("/roles/:id", requirePermission("manage_roles"), rolesCtrl.deleteRole);

router.get("/team", requirePermission(["view_team", "manage_team"]), teamCtrl.listMembers);
router.get("/team/:id", requirePermission(["view_team", "manage_team"]), teamCtrl.getMember);
router.post("/team/invite", requirePermission(["invite_team", "manage_team"]), teamCtrl.inviteMember);
router.patch("/team/:id", requirePermission(["edit_team", "manage_team"]), teamCtrl.updateMember);
router.patch("/team/:id/commission", ownerOnly, teamCtrl.updateCommission);
router.delete("/team/:id", requirePermission(["remove_team", "manage_team"]), teamCtrl.removeMember);
router.delete("/team/:id/hard-delete", requirePermission(["remove_team", "manage_team"]), teamCtrl.hardDeleteMember);
router.post("/team/:id/resend-invite", requirePermission(["invite_team", "manage_team"]), teamCtrl.resendInvite);

router.get("/orders", requirePermission(["view_orders", "manage_orders"]), panelOrdersCtrl.listOrders);
router.patch("/orders/bulk-status", requirePermission(["update_order_status", "manage_orders"]), panelOrdersCtrl.bulkUpdateStatus);
router.get("/orders/:id", requirePermission(["view_orders", "manage_orders"]), panelOrdersCtrl.getOrder);
router.patch("/orders/:id/status", requirePermission(["update_order_status", "manage_orders"]), panelOrdersCtrl.updateOrderStatus);
router.post("/orders/:id/fulfill", requirePermission(["fulfill_orders", "manage_orders"]), panelOrdersCtrl.fulfillOrder);
router.post("/orders/:id/refund", requirePermission(["refund_orders", "manage_orders"]), panelOrdersCtrl.refundOrder);
router.post("/orders/:id/timeline", requirePermission(["update_order_status", "manage_orders"]), panelOrdersCtrl.addTimeline);
router.patch("/orders/:id/tags", requirePermission(["update_order_status", "manage_orders"]), panelOrdersCtrl.updateTags);
router.get("/orders/:orderId/claim-chat", requirePermission(["view_orders", "manage_orders"]), panelOrdersCtrl.getClaimChat);

router.get("/games", gamesCtrl.listGames);
router.get("/games/:slug", gamesCtrl.getGame);
router.post("/games", requirePermission(["create_games", "manage_games"]), upload.fields([{ name: "image", maxCount: 1 }, { name: "banner", maxCount: 1 }]), gamesCtrl.createGame);
router.patch("/games/:slug", requirePermission(["edit_games", "manage_games"]), upload.fields([{ name: "image", maxCount: 1 }, { name: "banner", maxCount: 1 }]), gamesCtrl.updateGame);
router.delete("/games/:slug", requirePermission(["delete_games", "manage_games"]), gamesCtrl.deleteGame);

router.get("/categories", requirePermission("manage_categories"), categoryCtrl.getAll);
router.get("/categories/game/:game", categoryCtrl.getByGame);
router.post("/categories", requirePermission("manage_categories"), categoryCtrl.create);
router.patch("/categories/:id", requirePermission("manage_categories"), categoryCtrl.update);
router.delete("/categories/:id", requirePermission("manage_categories"), categoryCtrl.delete);
router.post("/categories/:id/subcategories", requirePermission("manage_categories"), categoryCtrl.addSubcategory);
router.delete("/categories/:id/subcategories/:subId", requirePermission("manage_categories"), categoryCtrl.removeSubcategory);

router.get("/products", requirePermission(["view_products", "manage_products"]), productCtrl.adminGetAll);
router.post("/products/bulk", requirePermission(["create_products", "manage_products"]), productCtrl.bulkCreate);
router.get("/products/:id", requirePermission(["view_products", "manage_products"]), productCtrl.getOne);
router.post("/products", requirePermission(["create_products", "manage_products"]), upload.array("images", 10), productCtrl.create);
router.patch("/products/:id/toggle-active", requirePermission(["edit_products", "manage_products"]), productCtrl.toggleActive);
router.patch("/products/:id", requirePermission(["edit_products", "manage_products"]), upload.array("images", 10), productCtrl.update);
router.delete("/products/:id", requirePermission(["delete_products", "manage_products"]), productCtrl.delete);

router.get("/site-content", requirePermission("edit_site_content"), siteContentCtrl.getAllContent);
router.get("/site-content/section/:section", requirePermission("edit_site_content"), siteContentCtrl.getSection);
router.patch("/site-content/:key", requirePermission("edit_site_content"), siteContentCtrl.updateContent);
router.post("/site-content/bulk-update", requirePermission("edit_site_content"), siteContentCtrl.bulkUpdate);
router.post("/site-content/:key/reset", requirePermission("edit_site_content"), ownerOnly, siteContentCtrl.resetToDefault);

router.get("/proof", requirePermission("view_pod"), proofCtrl.listProofs);
router.get("/proof/:id", requirePermission("view_pod"), proofCtrl.getProof);
router.patch("/proof/:id/notes", ownerOnly, proofCtrl.addOwnerNotes);
router.post("/proof/submit", requirePermission("claim_agent"), upload.single("proof"), proofCtrl.submitProof);

router.get("/agent-stats", requirePermission("monitor_agents"), agentStatsCtrl.getAllAgentStats);
router.get("/agent-stats/me", requirePermission("claim_agent"), agentStatsCtrl.getMyStats);
router.get("/agent-stats/:id", requirePermission("monitor_agents"), agentStatsCtrl.getAgentDetail);

router.get("/promos", requirePermission("manage_promos"), promoCtrl.getAll);
router.post("/promos", requirePermission("manage_promos"), promoCtrl.create);
router.patch("/promos/:id", requirePermission("manage_promos"), promoCtrl.update);
router.delete("/promos/:id", requirePermission("manage_promos"), promoCtrl.delete);

const canUpload = (req, res, next) => {
  if (req.panelUser?.isOwner) return next();
  const perms = req.panelUser?.permissions || [];
  if (perms.includes("manage_products") || perms.includes("edit_products") || perms.includes("create_products") || perms.includes("upload_images")) return next();
  return res.status(403).json({ success: false, message: "Permission denied" });
};

router.post("/upload/single", canUpload, upload.single("file"), uploadCtrl.uploadSingle);
router.post("/upload/multiple", canUpload, upload.array("files", 20), uploadCtrl.uploadMultiple);
router.delete("/upload", canUpload, uploadCtrl.deleteImage);

router.get("/settings", ownerOnly, settingsCtrl.getSettings);
router.patch("/settings", ownerOnly, settingsCtrl.updateSettings);

const tutorialCtrl = require("../controllers/tutorialController");
router.get("/tutorials", tutorialCtrl.listTutorials);
router.post("/tutorials", requirePermission("edit_site_content"), tutorialCtrl.createTutorial);
router.patch("/tutorials/reorder", requirePermission("edit_site_content"), tutorialCtrl.reorderTutorials);
router.patch("/tutorials/:id", requirePermission("edit_site_content"), tutorialCtrl.updateTutorial);
router.delete("/tutorials/:id", requirePermission("edit_site_content"), tutorialCtrl.deleteTutorial);

const customerAdminCtrl = require("../controllers/customerAdminController");
router.get("/customers", ownerOnly, customerAdminCtrl.listCustomers);
router.get("/customers/stats", ownerOnly, customerAdminCtrl.getCustomerStats);
router.get("/customers/:id", ownerOnly, customerAdminCtrl.getCustomer);
router.patch("/customers/:id", ownerOnly, customerAdminCtrl.updateCustomer);
router.delete("/customers/:id", ownerOnly, customerAdminCtrl.deleteCustomer);

const claimCtrl = require("../controllers/claimController");
router.get("/claims/queue", requirePermission("claim_agent"), claimCtrl.getAgentQueue);
router.get("/claims/active", requirePermission("monitor_agents"), claimCtrl.getActiveClaims);
router.get("/claims/:roomId", requirePermission("monitor_agents"), claimCtrl.getSession);
router.get("/claims/:roomId/full", requirePermission("monitor_agents"), claimCtrl.getFullSession);

router.get("/stock/requests", requirePermission(["manage_stock", "view_stock"]), stockCtrl.listRequests);
router.get("/stock/requests/:id", requirePermission(["manage_stock", "view_stock"]), stockCtrl.getRequest);
router.patch("/stock/requests/:id/approve", requirePermission("manage_stock"), stockCtrl.approveRequest);
router.patch("/stock/requests/:id/stocked", requirePermission("manage_stock"), stockCtrl.markStocked);
router.patch("/stock/requests/:id/reject", requirePermission("manage_stock"), stockCtrl.rejectRequest);
router.get("/stock/stockers", requirePermission(["manage_stockers", "view_stock"]), stockCtrl.listStockers);
router.get("/stock/stockers/:id", requirePermission(["manage_stockers", "view_stock"]), stockCtrl.getStockerDetail);
router.post("/stock/stockers/invite", requirePermission("manage_stockers"), stockCtrl.inviteStocker);
router.patch("/stock/stockers/:id", requirePermission("manage_stockers"), stockCtrl.updateStocker);
router.delete("/stock/stockers/:id", requirePermission("manage_stockers"), stockCtrl.deleteStocker);

module.exports = router;
