'use strict';
/**
 * Generates locally-written SVG placeholder images into public/img/.
 * No external assets or network requests are involved - every image in this
 * demo store is a small SVG file this script writes itself.
 */
const fs = require('fs');
const path = require('path');

const IMG_DIR = path.join(__dirname, '..', 'public', 'img');

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Category -> base hue, so a category reads as a colour family.
const CATEGORY_HUE = {
  'home-kitchen': 18,
  'outdoors': 150,
  'electronics': 212,
  'stationery': 275,
  'apparel': 335
};

function wrap(text, max) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > max) {
      if (line) lines.push(line.trim());
      line = w;
    } else {
      line = (line + ' ' + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

/** Three distinct "angles" of the same product, so the gallery has variety. */
function shapes(variant, h, seed) {
  const accent = `hsl(${(h + 40) % 360} 70% 62%)`;
  const accent2 = `hsl(${(h + 200) % 360} 55% 70%)`;
  const soft = `hsl(${h} 45% 92%)`;
  const jitter = (seed % 40) - 20;
  if (variant === 0) {
    return `
    <circle cx="400" cy="290" r="150" fill="${soft}" opacity="0.75"/>
    <rect x="${300 + jitter}" y="190" width="200" height="200" rx="28" fill="${accent}"/>
    <rect x="${340 + jitter}" y="230" width="120" height="120" rx="18" fill="${soft}" opacity="0.9"/>
    <circle cx="${400 + jitter}" cy="290" r="34" fill="${accent2}"/>`;
  }
  if (variant === 1) {
    return `
    <rect x="230" y="200" width="340" height="190" rx="24" fill="${soft}"/>
    <path d="M250 380 L360 ${230 + jitter} L470 330 L560 250 L560 380 Z" fill="${accent}" opacity="0.9"/>
    <circle cx="${300 + jitter}" cy="245" r="30" fill="${accent2}"/>`;
  }
  return `
    <circle cx="400" cy="290" r="160" fill="${soft}"/>
    <path d="M400 150 L512 290 L400 430 L288 290 Z" fill="${accent}" opacity="0.92"/>
    <path d="M400 205 L457 290 L400 375 L343 290 Z" fill="${accent2}" opacity="0.95"/>
    <circle cx="${400 + jitter}" cy="290" r="18" fill="#ffffff" opacity="0.85"/>`;
}

function svg({ title, subtitle, categorySlug, variant, seed }) {
  const baseHue = CATEGORY_HUE[categorySlug] !== undefined
    ? CATEGORY_HUE[categorySlug]
    : seed % 360;
  const h = (baseHue + variant * 8) % 360;
  const bgA = `hsl(${h} 42% 96%)`;
  const bgB = `hsl(${(h + 25) % 360} 46% 88%)`;
  const ink = `hsl(${h} 35% 22%)`;
  const lines = wrap(title, 22);
  const text = lines
    .map((l, i) => `<text x="400" y="${492 + i * 30}" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="26" fill="${ink}">${esc(l)}</text>`)
    .join('\n    ');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600" role="img" aria-label="${esc(title)} - placeholder illustration">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${bgA}"/>
      <stop offset="100%" stop-color="${bgB}"/>
    </linearGradient>
  </defs>
  <rect width="800" height="600" fill="url(#bg)"/>
  <g>${shapes(variant, h, seed)}
  </g>
  ${text}
  <text x="400" y="${492 + lines.length * 30 + 6}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15" letter-spacing="2" fill="${ink}" opacity="0.65">${esc(subtitle)}</text>
  <text x="400" y="52" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" letter-spacing="3" fill="${ink}" opacity="0.5">NORTHWIND GOODS &#183; DEMO</text>
</svg>
`;
}

/** Writes 3 images for a product; returns the public URLs. */
function writeProductImages(product, categorySlug, count = 3) {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const seed = hash(product.slug);
  const urls = [];
  for (let i = 0; i < count; i++) {
    const file = `${product.slug}-${i + 1}.svg`;
    fs.writeFileSync(
      path.join(IMG_DIR, file),
      svg({
        title: product.name,
        subtitle: `VIEW ${i + 1} OF ${count}`,
        categorySlug,
        variant: i % 3,
        seed: seed + i * 977
      })
    );
    urls.push(`/img/${file}`);
  }
  return urls;
}

function writeBrandAssets() {
  fs.mkdirSync(IMG_DIR, { recursive: true });
  fs.writeFileSync(path.join(IMG_DIR, 'logo.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Northwind Goods demo logo">
  <rect width="64" height="64" rx="14" fill="#1f3d33"/>
  <path d="M18 44V20l14 16V20h6v24h-6L18 28v16z" fill="#e9f0e6"/>
</svg>
`);
  fs.writeFileSync(path.join(IMG_DIR, 'placeholder.svg'), svg({
    title: 'Northwind Goods',
    subtitle: 'DEMO PLACEHOLDER',
    categorySlug: 'outdoors',
    variant: 2,
    seed: 7
  }));
  fs.writeFileSync(path.join(IMG_DIR, 'hero.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 420" width="1200" height="420" role="img" aria-label="Demo store banner">
  <defs>
    <linearGradient id="h" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1f3d33"/>
      <stop offset="100%" stop-color="#3d6b57"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="420" fill="url(#h)"/>
  <circle cx="1010" cy="120" r="150" fill="#ffffff" opacity="0.07"/>
  <circle cx="180" cy="330" r="190" fill="#ffffff" opacity="0.05"/>
  <path d="M0 380 L200 300 L420 360 L640 270 L880 340 L1200 250 L1200 420 L0 420 Z" fill="#ffffff" opacity="0.08"/>
</svg>
`);
}

module.exports = { writeProductImages, writeBrandAssets, IMG_DIR };
