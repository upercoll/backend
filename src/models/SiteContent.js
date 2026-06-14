const mongoose = require("mongoose");

const siteContentSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    section: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
    type: {
      type: String,
      enum: ["text", "richtext", "image", "json", "boolean", "number", "color"],
      default: "text",
    },
    value: { type: mongoose.Schema.Types.Mixed },
    defaultValue: { type: mongoose.Schema.Types.Mixed },
    lastEditedBy: { type: String, trim: true },
    lastEditedById: { type: mongoose.Schema.Types.ObjectId },
    sortOrder: { type: Number, default: 0 },
    visible: { type: Boolean, default: true },
  },
  { timestamps: true }
);

siteContentSchema.index({ section: 1, sortOrder: 1 });

module.exports = mongoose.model("SiteContent", siteContentSchema);
