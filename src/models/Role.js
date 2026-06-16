const mongoose = require("mongoose");

const PERMISSIONS = [
  "manage_games",
  "manage_categories",
  "manage_products",
  "manage_orders",
  "manage_claims",
  "manage_team",
  "manage_roles",
  "view_analytics",
  "edit_site_content",
  "manage_promos",
  "monitor_agents",
  "view_pod",
  "claim_agent",
  "manage_collaborators",
  "upload_images",
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
