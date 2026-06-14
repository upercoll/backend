const mongoose = require("mongoose");

const subcategorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true, trim: true, lowercase: true },
  description: { type: String, trim: true },
  icon: { type: String },
  sortOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
});

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true },
    description: { type: String, trim: true },
    game: {
      type: String,
      required: true,
      trim: true,

    },
    icon: { type: String },
    gradient: {
      from: { type: String, default: "#7c3aed" },
      to: { type: String, default: "#6d28d9" },
    },
    subcategories: [subcategorySchema],
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

categorySchema.index({ game: 1 });
categorySchema.index({ slug: 1 });

module.exports = mongoose.model("Category", categorySchema);
