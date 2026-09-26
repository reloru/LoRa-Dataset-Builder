// Image decoding, resizing and fingerprinting, all on the device.
//
// Every image leaves as a JPEG no larger than 1024 px on its long edge at
// quality 0.9. Measured on 15 camera photos (8–24 MP) in Chromium, that
// averaged 144 KB per image, about 690 images or 345 pairs per 100 MB.

export const LONG_EDGE = 1024;
export const JPEG_QUALITY = 0.9;
const THUMB_EDGE = 240;

// Decoding through an <img> element rather than createImageBitmap: it is the
// path Safari uses for HEIC, and drawing an <img> applies the photo's EXIF
// orientation, so portrait phone photos stay upright.
export function decode(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const release = () => {
        img.src = "";
        URL.revokeObjectURL(url);
      };
      resolve({ img, width: img.naturalWidth, height: img.naturalHeight, release });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This file could not be read as an image."));
    };
    img.src = url;
  });
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error("The image could not be encoded."))),
      "image/jpeg",
      quality
    );
  });
}

function draw(source, crop, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  // Transparent PNG areas would otherwise turn black in a JPEG.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
  return c;
}

export function fitLongEdge(w, h, edge = LONG_EDGE) {
  const s = Math.min(1, edge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// 64-bit difference hash from a 9×8 grayscale copy: close hashes mean
// visually near-identical images, which catches re-saved or resized copies
// that a byte comparison would miss.
function dHash(source, crop) {
  const c = draw(source, crop, 9, 8);
  const px = c.getContext("2d").getImageData(0, 0, 9, 8).data;
  const gray = [];
  for (let i = 0; i < px.length; i += 4) gray.push(px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += gray[y * 9 + x] > gray[y * 9 + x + 1] ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hashDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

// Renders one decoded image to the stored form: the full JPEG, a thumbnail
// and a fingerprint. `crop` is in source pixels; `size` is the output size.
async function render(decoded, crop, size) {
  const full = draw(decoded.img, crop, size.w, size.h);
  const jpeg = await canvasToJpeg(full, JPEG_QUALITY);
  const t = fitLongEdge(size.w, size.h, THUMB_EDGE);
  const thumb = await canvasToJpeg(draw(full, { x: 0, y: 0, w: size.w, h: size.h }, t.w, t.h), 0.7);
  const hash = dHash(full, { x: 0, y: 0, w: size.w, h: size.h });
  full.width = full.height = 0;
  return { jpeg, thumb, hash, w: size.w, h: size.h, origW: decoded.width, origH: decoded.height };
}

export async function processSingle(blob, name) {
  const d = await decode(blob);
  try {
    const out = await render(d, { x: 0, y: 0, w: d.width, h: d.height }, fitLongEdge(d.width, d.height));
    return { ...out, name };
  } finally {
    d.release();
  }
}

// Decides how a before/after pair is made the same size, from the two
// original sizes:
//   - identical sizes: nothing to fix;
//   - same shape (aspect ratios within 1%): both are scaled to one size,
//     which keeps them aligned;
//   - different shapes: the side the person chose (`cropSide`, the before
//     unless changed) is cropped at its center to the other's shape, then
//     both are scaled to one size. That lines up only if both were centered
//     alike, so the pair is flagged for a visual check.
// The output is as large as the smaller of the two allows, up to 1024 px:
// neither image is ever enlarged.
export function planPair(bw, bh, aw, ah, cropSide = "before") {
  const full = (w, h) => ({ x: 0, y: 0, w, h });
  const toShape = (w, h, r) => {
    if (w / h > r) {
      const cw = Math.round(h * r);
      return { x: Math.round((w - cw) / 2), y: 0, w: cw, h };
    }
    const ch = Math.round(w / r);
    return { x: 0, y: Math.round((h - ch) / 2), w, h: ch };
  };
  let beforeCrop = full(bw, bh);
  let afterCrop = full(aw, ah);
  let match = "none";
  const rb = bw / bh;
  const ra = aw / ah;
  if (bw !== aw || bh !== ah) {
    if (Math.abs(rb - ra) / rb < 0.01) match = "scaled";
    else {
      match = "cropped";
      if (cropSide === "after") afterCrop = toShape(aw, ah, rb);
      else beforeCrop = toShape(bw, bh, ra);
    }
  }
  const kept = match === "cropped" && cropSide === "after" ? beforeCrop : afterCrop;
  const edge = Math.min(LONG_EDGE, Math.max(beforeCrop.w, beforeCrop.h), Math.max(afterCrop.w, afterCrop.h));
  return { match, beforeCrop, afterCrop, size: fitLongEdge(kept.w, kept.h, edge) };
}

export async function processPair(beforeBlob, afterBlob, beforeName, afterName, cropSide = "before") {
  const b = await decode(beforeBlob);
  try {
    const a = await decode(afterBlob);
    try {
      const plan = planPair(b.width, b.height, a.width, a.height, cropSide);
      const before = { ...(await render(b, plan.beforeCrop, plan.size)), name: beforeName };
      const after = { ...(await render(a, plan.afterCrop, plan.size)), name: afterName };
      return { before, after, match: plan.match, crop: plan.match === "cropped" ? cropSide : null };
    } finally {
      a.release();
    }
  } finally {
    b.release();
  }
}
