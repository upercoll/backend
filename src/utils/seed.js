require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../models/User");
const Category = require("../models/Category");
const Product = require("../models/Product");
const logger = require("./logger");

const games = [
  { name: "Murder Mystery 2", slug: "murder-mystery-2", gradient: { from: "#dc2626", to: "#7c3aed" } },
  { name: "Blox Fruits",       slug: "blox-fruits",       gradient: { from: "#d97706", to: "#fbbf24" } },
  { name: "Grow A Garden",     slug: "grow-a-garden",     gradient: { from: "#16a34a", to: "#4ade80" } },
  { name: "Blade Ball",        slug: "blade-ball",        gradient: { from: "#4f46e5", to: "#7c3aed" } },
];

const categoryDefs = [
  { game: "murder-mystery-2", name: "Knives",     slug: "knives",     icon: "Sword",    subs: ["Godly", "Legendary", "Rare", "Common"] },
  { game: "murder-mystery-2", name: "Guns",       slug: "guns",       icon: "Target",   subs: ["Godly", "Legendary", "Rare"] },
  { game: "murder-mystery-2", name: "Pets",       slug: "pets",       icon: "PawPrint", subs: ["Legendary", "Rare", "Common"] },
  { game: "murder-mystery-2", name: "Bundles",    slug: "bundles",    icon: "Package",  subs: ["Value", "Premium"] },
  { game: "blox-fruits",      name: "Fruits",     slug: "fruits",     icon: "Apple",    subs: ["Mythical", "Legendary", "Rare"] },
  { game: "blox-fruits",      name: "Sword",      slug: "swords",     icon: "Sword",    subs: ["Dragon", "Legendary"] },
  { game: "grow-a-garden",    name: "Seeds",      slug: "seeds",      icon: "Sprout",   subs: ["Legendary", "Rare", "Common"] },
  { game: "grow-a-garden",    name: "Tools",      slug: "tools",      icon: "Wrench",   subs: ["Watering", "Harvest"] },
  { game: "blade-ball",       name: "Swords",     slug: "swords-bb",  icon: "Sword",    subs: ["Rare", "Epic", "Common"] },
];

const sampleProducts = [
  { name: "Gingerscope Gun",    game: "murder-mystery-2", catSlug: "guns",   price: 8.49, originalPrice: 12.99, gradient: { from: "#0ea5e9", to: "#1d4ed8" }, bestSeller: true },
  { name: "Harvester Gun",      game: "murder-mystery-2", catSlug: "guns",   price: 6.99, originalPrice: 9.99,  gradient: { from: "#0d9488", to: "#0284c7" }, bestSeller: true },
  { name: "Lightbringer Knife", game: "murder-mystery-2", catSlug: "knives", price: 15.99, originalPrice: 19.99, gradient: { from: "#7c3aed", to: "#4c1d95" }, bestSeller: true },
  { name: "Luger Knife",        game: "murder-mystery-2", catSlug: "knives", price: 3.99,  gradient: { from: "#d97706", to: "#b45309" } },
  { name: "Chroma Scythe",      game: "murder-mystery-2", catSlug: "knives", price: 24.99, originalPrice: 34.99, gradient: { from: "#ec4899", to: "#be185d" }, featured: true },
  { name: "Dragon Fruit",       game: "blox-fruits",      catSlug: "fruits", price: 12.99, originalPrice: 18.99, gradient: { from: "#dc2626", to: "#ea580c" }, bestSeller: true },
  { name: "Leopard Fruit",      game: "blox-fruits",      catSlug: "fruits", price: 19.99, originalPrice: 28.99, gradient: { from: "#d97706", to: "#b45309" }, featured: true },
  { name: "Legendary Seed",     game: "grow-a-garden",    catSlug: "seeds",  price: 5.99,  originalPrice: 8.99,  gradient: { from: "#16a34a", to: "#065f46" } },
  { name: "Golden Watering Can",game: "grow-a-garden",    catSlug: "tools",  price: 9.99,  gradient: { from: "#d97706", to: "#b45309" }, featured: true },
];

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  logger.info("Connected to MongoDB");

  await Promise.all([
    User.deleteMany({}),
    Category.deleteMany({}),
    Product.deleteMany({}),
  ]);

  const admin = await User.create({
    email: process.env.ADMIN_EMAIL || "admin@rbstars.com",
    password: process.env.ADMIN_PASSWORD || "Admin@123456",
    role: "admin",
    name: "RBstars Admin",
  });
  logger.info(`Admin created: ${admin.email}`);

  const categoryMap = {};
  for (const def of categoryDefs) {
    const game = games.find((g) => g.slug === def.game);
    const cat = await Category.create({
      name: def.name,
      slug: `${def.game}-${def.slug}`,
      game: def.game,
      icon: def.icon,
      gradient: game?.gradient || { from: "#7c3aed", to: "#6d28d9" },
      subcategories: def.subs.map((s, i) => ({
        name: s,
        slug: s.toLowerCase().replace(/\s+/g, "-"),
        sortOrder: i,
      })),
    });
    categoryMap[`${def.game}:${def.slug}`] = cat;
    logger.info(`Category: ${cat.name} (${cat.game})`);
  }

  for (const p of sampleProducts) {
    const key = `${p.game}:${p.catSlug}`;
    const cat = categoryMap[key];
    if (!cat) { logger.warn(`No category for product ${p.name}`); continue; }

    const slug = p.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
    await Product.create({
      name: p.name,
      slug,
      game: p.game,
      category: cat._id,
      price: p.price,
      originalPrice: p.originalPrice,
      gradient: p.gradient,
      bestSeller: p.bestSeller || false,
      featured: p.featured || false,
      active: true,
    });
    logger.info(`Product: ${p.name}`);
  }

  logger.info("✅ Seed complete");
  process.exit(0);
}

seed().catch((err) => {
  logger.error(err);
  process.exit(1);
});
