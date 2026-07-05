const mongoose = require("mongoose");

const PERMISSIONS = [
  "view_analytics",

  "view_products",
  "create_products",
  "edit_products",
  "delete_products",
  "manage_products",

  "view_orders",
  "update_order_status",
  "fulfill_orders",
  "refund_orders",
  "manage_orders",

  "view_games",
  "create_games",
  "edit_games",
  "delete_games",
  "manage_games",
  "manage_categories",

  "edit_site_content",
  "upload_images",

  "manage_promos",

  "view_claims",
  "claim_agent",
  "monitor_agents",
  "view_pod",
  "manage_claims",

  "view_team",
  "invite_team",
  "edit_team",
  "remove_team",
  "manage_roles",
  "manage_collaborators",
  "manage_team",

  "view_stock",
  "manage_stock",
  "manage_stockers",

  "view_deliverers",
  "manage_deliverers",

  "view_socials",
  "manage_socials",
];

const roleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    color: { type: String, default: "#6366f1" },
    permissions: [{ type: String, enum: PERMISSIONS }],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

roleSchema.index({ name: 1 });

module.exports = mongoose.model("Role", roleSchema);
module.exports.PERMISSIONS = PERMISSIONS;
