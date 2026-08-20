'use strict';
/**
 * Seeds the DEMO store database.
 * Everything here is fictional: "Northwind Goods" is not a real merchant and
 * the accounts below are throwaway demo logins.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, DB_PATH, initSchema } = require('./index');
const { writeProductImages, writeBrandAssets } = require('./images');

const CATEGORIES = [
  { name: 'Home & Kitchen', slug: 'home-kitchen', description: 'Everyday things for cooking, eating and tidying up.' },
  { name: 'Outdoors', slug: 'outdoors', description: 'Gear for walks, camps and cold mornings.' },
  { name: 'Electronics', slug: 'electronics', description: 'Small useful gadgets, demo catalogue only.' },
  { name: 'Stationery', slug: 'stationery', description: 'Paper, ink and desk companions.' },
  { name: 'Apparel', slug: 'apparel', description: 'Simple, hard-wearing clothes.' }
];

// price_cents everywhere - we never store floating point money.
const PRODUCTS = [
  // Home & Kitchen
  { name: 'Cast Iron Skillet 26cm', category: 'home-kitchen', price_cents: 4900, stock: 34, rating: 4.7, description: 'A pre-seasoned cast iron skillet that gets better every time you use it. Oven safe to 260C, with a helper handle for lifting a full pan of roast potatoes.' },
  { name: 'Stoneware Mug Set (4)', category: 'home-kitchen', price_cents: 3200, stock: 58, rating: 4.4, description: 'Four chunky stoneware mugs in a matte glaze. Dishwasher and microwave safe, 350ml each, and heavy enough to stay put on a wobbly desk.' },
  { name: 'Walnut Chopping Board', category: 'home-kitchen', price_cents: 5600, stock: 21, rating: 4.8, description: 'End-grain walnut board with a juice groove and recessed grips. Kind to knife edges, and it hides scratches better than a plastic board ever will.' },
  { name: 'Pour-Over Coffee Kit', category: 'home-kitchen', price_cents: 4200, stock: 40, rating: 4.5, description: 'Glass dripper, carafe and a reusable stainless filter. Makes two cups at a time and packs down small enough for a weekend bag.' },
  { name: 'Linen Tea Towels (3)', category: 'home-kitchen', price_cents: 1900, stock: 75, rating: 4.2, description: 'Stonewashed linen towels that dry glassware without leaving lint. They start slightly stiff and soften after the first few washes.' },
  { name: 'Enamel Stock Pot 6L', category: 'home-kitchen', price_cents: 6800, stock: 12, rating: 4.6, description: 'A 6 litre enamelled steel pot for stock, soup and pasta. Light enough to lift full, with a vented glass lid so it will not boil over unnoticed.' },

  // Outdoors
  { name: 'Waxed Canvas Rucksack', category: 'outdoors', price_cents: 11900, stock: 18, rating: 4.9, description: 'A 24 litre waxed canvas pack with leather straps and a padded laptop sleeve. Shrugs off drizzle and ages into something better looking than it started.' },
  { name: 'Insulated Flask 750ml', category: 'outdoors', price_cents: 3400, stock: 66, rating: 4.6, description: 'Double-walled stainless flask that keeps drinks hot for twelve hours. The lid doubles as a cup and the mouth is wide enough for ice cubes.' },
  { name: 'Merino Hiking Socks', category: 'outdoors', price_cents: 2200, stock: 90, rating: 4.5, description: 'Cushioned merino blend socks with a reinforced heel. Warm when wet, and they do not develop that end-of-day smell synthetics get.' },
  { name: 'Folding Camp Stool', category: 'outdoors', price_cents: 2900, stock: 27, rating: 4.1, description: 'Aluminium tripod stool with a canvas seat, folding to the size of a rolled newspaper. Rated to 110kg and weighs under 700 grams.' },
  { name: 'Trail Head Torch', category: 'outdoors', price_cents: 3900, stock: 44, rating: 4.4, description: 'USB-rechargeable head torch with 350 lumens, a red night mode and a tilting bracket. Runs about nine hours on the middle setting.' },
  { name: 'Packable Rain Shell', category: 'outdoors', price_cents: 8900, stock: 15, rating: 4.3, description: 'A taped-seam rain shell that stuffs into its own chest pocket. Pit zips and a wired hood brim keep it usable on a long wet walk.' },

  // Electronics
  { name: 'Desk Lamp with USB-C', category: 'electronics', price_cents: 5400, stock: 31, rating: 4.5, description: 'Warm-to-cool dimmable LED lamp with a USB-C port in the base. The arm holds position without drooping, which is rarer than it should be.' },
  { name: 'Mechanical Keyboard 65%', category: 'electronics', price_cents: 12900, stock: 9, rating: 4.8, description: 'A 65 percent hot-swap keyboard with gasket mounting and PBT keycaps. Wired USB-C, no software required, and the arrow keys are still there.' },
  { name: 'Bluetooth Speaker Mini', category: 'electronics', price_cents: 4700, stock: 52, rating: 4.2, description: 'Pocket speaker with a passive radiator that gives it more low end than its size suggests. Twelve hours of playback and an IPX5 splash rating.' },
  { name: 'Wireless Charging Pad', category: 'electronics', price_cents: 2600, stock: 70, rating: 4.0, description: 'A 15W Qi pad with a grippy silicone top and a status light dim enough for a bedside table. Cable included, adapter not.' },
  { name: 'Noise-Isolating Earbuds', category: 'electronics', price_cents: 7900, stock: 23, rating: 4.4, description: 'Wired earbuds with a braided cable, an inline mic and four sizes of tip. No batteries, no pairing, no firmware updates ever.' },
  { name: 'Smart Plug Twin Pack', category: 'electronics', price_cents: 3100, stock: 48, rating: 3.9, description: 'Two scheduling plugs with local timers and energy reporting. They keep their schedule if the internet drops, which is the entire point.' },

  // Stationery
  { name: 'Hardback Dot Grid Notebook', category: 'stationery', price_cents: 1800, stock: 120, rating: 4.7, description: 'A5 notebook with 160 pages of 100gsm dot grid paper, a sewn binding that lies flat and two ribbon markers. Fountain pen friendly.' },
  { name: 'Fountain Pen - Fine Nib', category: 'stationery', price_cents: 3600, stock: 37, rating: 4.6, description: 'A brass-bodied fountain pen with a steel fine nib, converter and two cartridges. Balanced unposted and forgiving of a fast scrawl.' },
  { name: 'Desk Blotter Pad', category: 'stationery', price_cents: 2400, stock: 29, rating: 4.1, description: 'Large felt-backed blotter that protects a desk and gives a mouse something to grip. Rolls for shipping and flattens within a day.' },
  { name: 'Brass Bookmark Set (5)', category: 'stationery', price_cents: 1400, stock: 64, rating: 4.3, description: 'Five slim brass bookmarks that patina with handling. Thin enough not to spread a spine, heavy enough not to slip out in a bag.' },

  // Apparel
  { name: 'Heavyweight Cotton Tee', category: 'apparel', price_cents: 2800, stock: 85, rating: 4.4, description: 'A 240gsm cotton t-shirt with a ribbed collar that keeps its shape. Pre-shrunk, boxy rather than clingy, and it survives a hot wash.' },
  { name: 'Lambswool Crew Jumper', category: 'apparel', price_cents: 9800, stock: 16, rating: 4.7, description: 'Soft lambswool crew neck knitted in a mid-gauge, with a slightly longer body so it stays tucked. Warm without being bulky under a coat.' },
  { name: 'Canvas Work Apron', category: 'apparel', price_cents: 4400, stock: 33, rating: 4.5, description: 'Cross-back canvas apron with three pockets and a towel loop. The straps spread the weight across your shoulders rather than your neck.' }
];

const REVIEW_SNIPPETS = [
  ['Better than expected', 'Arrived quickly and feels far more solid than the price suggests. Would buy again.'],
  ['Solid, small caveat', 'Does the job well. Took a couple of uses to get used to, but no complaints now.'],
  ['Exactly as described', 'No surprises, which is what I wanted. The photos match what turned up.'],
  ['Good value', 'I compared a few options and this was the sensible middle choice. Happy with it.'],
  ['Would recommend', 'Been using it daily for a few weeks and it still looks new.']
];

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function main() {
  console.log('Seeding DEMO store database at %s', DB_PATH);
  initSchema();
  writeBrandAssets();

  const insertCategory = db.prepare(
    'INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)'
  );
  const insertProduct = db.prepare(`
    INSERT INTO products (name, slug, description, price_cents, stock, category_id, rating, rating_count, created_at)
    VALUES (@name, @slug, @description, @price_cents, @stock, @category_id, @rating, @rating_count, @created_at)
  `);
  const insertImage = db.prepare(
    'INSERT INTO product_images (product_id, url, alt, position) VALUES (?, ?, ?, ?)'
  );
  const insertUser = db.prepare(
    'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)'
  );
  const insertAddress = db.prepare(`
    INSERT INTO addresses (user_id, label, full_name, line1, line2, city, region, postal_code, country, phone, is_default)
    VALUES (@user_id, @label, @full_name, @line1, @line2, @city, @region, @postal_code, @country, @phone, @is_default)
  `);
  const insertReview = db.prepare(
    'INSERT INTO reviews (product_id, user_id, rating, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const run = db.transaction(() => {
    const catIds = {};
    for (const c of CATEGORIES) {
      const info = insertCategory.run(c.name, c.slug, c.description);
      catIds[c.slug] = info.lastInsertRowid;
    }

    // Demo accounts. Passwords are deliberately trivial - this is a demo.
    const adminId = insertUser.run(
      'admin@example.com', bcrypt.hashSync('admin123', 10), 'Ada Admin', 'admin'
    ).lastInsertRowid;
    const customerId = insertUser.run(
      'customer@example.com', bcrypt.hashSync('customer123', 10), 'Cass Customer', 'customer'
    ).lastInsertRowid;

    insertAddress.run({
      user_id: customerId, label: 'Home', full_name: 'Cass Customer',
      line1: '14 Kingfisher Lane', line2: 'Flat 2', city: 'Bristol',
      region: 'Somerset', postal_code: 'BS1 4TR', country: 'GB',
      phone: '0117 496 0000', is_default: 1
    });
    insertAddress.run({
      user_id: adminId, label: 'Warehouse', full_name: 'Ada Admin',
      line1: 'Unit 7, Northwind Yard', line2: null, city: 'Leeds',
      region: 'West Yorkshire', postal_code: 'LS10 1AB', country: 'GB',
      phone: '0113 496 0000', is_default: 1
    });

    let n = 0;
    for (const p of PRODUCTS) {
      const slug = slugify(p.name);
      // Stagger created_at so "newest" sorting has something to sort by.
      const created = `datetime('now', '-${PRODUCTS.length - n} days')`;
      const createdAt = db.prepare(`SELECT ${created} AS d`).get().d;
      const ratingCount = 3 + ((n * 7) % 40);
      const productId = insertProduct.run({
        name: p.name,
        slug,
        description: p.description,
        price_cents: p.price_cents,
        stock: p.stock,
        category_id: catIds[p.category],
        rating: p.rating,
        rating_count: ratingCount,
        created_at: createdAt
      }).lastInsertRowid;

      const urls = writeProductImages({ name: p.name, slug }, p.category, 3);
      urls.forEach((url, i) => insertImage.run(productId, url, `${p.name} - view ${i + 1}`, i));

      // A couple of seeded reviews on every third product.
      if (n % 3 === 0) {
        const [title, body] = REVIEW_SNIPPETS[n % REVIEW_SNIPPETS.length];
        insertReview.run(productId, customerId, Math.max(3, Math.round(p.rating)), title, body, createdAt);
      }
      n++;
    }
  });

  run();

  const counts = {
    categories: db.prepare('SELECT COUNT(*) c FROM categories').get().c,
    products: db.prepare('SELECT COUNT(*) c FROM products').get().c,
    images: db.prepare('SELECT COUNT(*) c FROM product_images').get().c,
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    reviews: db.prepare('SELECT COUNT(*) c FROM reviews').get().c
  };
  console.log('Seeded:', counts);
  console.log('Demo logins: admin@example.com / admin123   |   customer@example.com / customer123');
  console.log('Reminder: this is a DEMO store. Checkout is simulated; no payments are processed.');
}

main();
