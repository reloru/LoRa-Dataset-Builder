// The dataset rules: what goes in the ZIP, under which names, and what gets
// flagged. No DOM here, so it can be tested outside a browser.
//
// Sources for the rules:
// - Pruna API spec (p-image-trainer, p-image-edit-trainer): ROOT_start/ROOT_end
//   naming, ROOT_start2… references, ROOT.txt captions, default_caption.
// - Pruna "LoRA Training and Inference" guide: 512×512 minimum, at least 10
//   images, trigger word in every caption, no reused captions, the dataset
//   size table, _input/_target as alternative names, masks.
// - Pruna's training notebooks: flat ZIP of image_000.png + image_000.txt, and
//   pair_000_start / pair_000_end / pair_000.txt.

import { zipSize } from "./zip.js";
import { hashDistance } from "./images.js";

// Pruna's /v1/files limit is 100 MB, and Cloudflare caps request bodies at
// 100 MB on Free and Pro plans. The upload is a multipart form, which adds a
// few hundred bytes, so the app keeps a margin below both.
export const ZIP_LIMIT = 99 * 1000 * 1000;
export const MIN_SIDE = 512;
export const MIN_PHOTOS = 10;
const DUPLICATE_DISTANCE = 5;

export const TRAINERS = {
  photos: {
    model: "p-image-trainer",
    use: "p-image-lora",
    usdPer1000Steps: 1.8,
  },
  pairs: {
    model: "p-image-edit-trainer",
    use: "p-image-edit-lora",
    usdPer1000Steps: 4.0,
  },
};

// Parameter definitions straight from Pruna's OpenAPI schemas.
export const PARAMS = {
  steps: { label: "Training steps", min: 100, max: 5000, step: 100, def: 1000, help: "More steps take longer and cost more." },
  learning_rate: { label: "Learning rate", min: 0.00001, max: 0.01, def: 0.0001, help: "Lower is slower but more stable." },
  training_type: {
    label: "What to learn",
    options: [
      ["balanced", "Balanced — content and style"],
      ["content", "Content — subjects, characters, objects, people"],
      ["style", "Style — palettes and aesthetic treatments"],
    ],
    def: "balanced",
    photosOnly: true,
  },
};

export const RECOMMENDED = {
  photos: [
    ["Person / character", "15–40"],
    ["Product", "20–50"],
    ["Style / aesthetic", "30–100"],
    ["General concept", "50+"],
  ],
  pairs: [
    ["Simple edits (background, color)", "100–300"],
    ["Inpainting / object replacement", "200–500"],
    ["Instruction-following editing", "500+"],
  ],
};

export function isComplete(item) {
  return item.kind === "photo" ? !!item.img : !!(item.before && item.after);
}

export function captionFor(meta, item) {
  let text = (item.caption || "").trim() || (meta.defaultCaption || "").trim();
  const trigger = (meta.triggerWord || "").trim();
  if (meta.autoTrigger && trigger && !text.includes(trigger)) text = text ? `${trigger}, ${text}` : trigger;
  return text;
}

function pad(i, n) {
  return String(i).padStart(Math.max(3, String(n - 1).length), "0");
}

const utf8 = new TextEncoder();

// The files that go into the ZIP, in order. Incomplete pairs are left out.
export function zipEntries(meta, items) {
  const done = items.filter(isComplete);
  const out = [];
  done.forEach((item, i) => {
    const caption = captionFor(meta, item);
    const n = pad(i, done.length);
    if (item.kind === "photo") {
      out.push({ name: `image_${n}.jpg`, data: new Uint8Array(item.img.jpeg) });
      if (caption) out.push({ name: `image_${n}.txt`, data: utf8.encode(caption) });
    } else {
      out.push({ name: `pair_${n}_start.jpg`, data: new Uint8Array(item.before.jpeg) });
      (item.refs || []).forEach((r, k) => out.push({ name: `pair_${n}_start${k + 2}.jpg`, data: new Uint8Array(r.jpeg) }));
      out.push({ name: `pair_${n}_end.jpg`, data: new Uint8Array(item.after.jpeg) });
      if (caption) out.push({ name: `pair_${n}.txt`, data: utf8.encode(caption) });
    }
  });
  return out;
}

export function datasetSize(meta, items) {
  const entries = zipEntries(meta, items).map((e) => ({ name: e.name, size: e.data.length }));
  return zipSize(entries);
}

export function itemLabel(meta, items, id) {
  const i = items.findIndex((x) => x.id === id);
  return `${meta.mode === "photos" ? "Photo" : "Pair"} ${i + 1}`;
}

function small(img) {
  return img && (img.origW < MIN_SIDE || img.origH < MIN_SIDE);
}

// Everything worth flagging. Nothing here blocks the ZIP; it is up to the
// person to decide. `global` covers the whole set, `perItem` is keyed by id.
export function checks(meta, items) {
  const global = [];
  const perItem = new Map();
  const add = (id, level, text) => {
    if (!perItem.has(id)) perItem.set(id, []);
    perItem.get(id).push({ level, text });
  };
  const label = (id) => itemLabel(meta, items, id);
  const photos = meta.mode === "photos";
  const trigger = (meta.triggerWord || "").trim();
  const hasDefault = !!(meta.defaultCaption || "").trim();
  const complete = items.filter(isComplete);

  if (photos && complete.length < MIN_PHOTOS) {
    global.push({ level: "warn", text: `Pruna asks for at least ${MIN_PHOTOS} images; this set has ${complete.length}.` });
  }
  if (!complete.length) global.push({ level: "warn", text: photos ? "No photos yet." : "No complete pairs yet." });

  const size = datasetSize(meta, items);
  if (size > ZIP_LIMIT) {
    global.push({ level: "warn", text: `The ZIP would be ${mb(size)}, over the ${mb(ZIP_LIMIT)} upload limit. It can still be downloaded, but Pruna will refuse it.` });
  }

  const uncaptioned = complete.filter((x) => !(x.caption || "").trim());
  if (uncaptioned.length) {
    const what = photos ? "photo" : "pair";
    const s = uncaptioned.length === 1 ? "" : "s";
    if (hasDefault) {
      global.push({ level: "warn", text: `${uncaptioned.length} ${what}${s} ha${s ? "ve" : "s"} no caption of ${s ? "their" : "its"} own; the default caption will be written for ${s ? "them" : "it"}.` });
    } else if (!(meta.autoTrigger && trigger)) {
      global.push({ level: "warn", text: `${uncaptioned.length} ${what}${s} ha${s ? "ve" : "s"} no caption and there is no default caption. Pruna fails training when captions are missing.` });
    }
  }

  if (photos && !trigger) {
    global.push({ level: "note", text: "No trigger word set. Pruna recommends one, used in every caption, for a person, character, product or specific concept." });
  }

  const typed = new Map();
  items.forEach((item, idx) => {
    if (item.kind === "pair") {
      if (!item.before && !item.after) add(item.id, "warn", "Empty pair — it is left out of the ZIP.");
      else if (!item.before) add(item.id, "warn", "Missing the before image — this pair is left out of the ZIP.");
      else if (!item.after) add(item.id, "warn", "Missing the after image — this pair is left out of the ZIP.");
      if (small(item.before)) add(item.id, "warn", `Before is ${item.before.origW}×${item.before.origH}, under Pruna's ${MIN_SIDE}×${MIN_SIDE} minimum.`);
      if (small(item.after)) add(item.id, "warn", `After is ${item.after.origW}×${item.after.origH}, under Pruna's ${MIN_SIDE}×${MIN_SIDE} minimum.`);
      if (item.match === "cropped") {
        add(item.id, "warn", `Before and after were different shapes, so the ${item.crop === "after" ? "after" : "before"} was cropped at its center to match. Use Flip to check they line up${item.src ? ", or crop the other one instead" : ""}.`);
      }
      if (item.match === "scaled") add(item.id, "note", "Before and after were different sizes; both were scaled to one size.");
      (item.refs || []).forEach((r, k) => {
        if (small(r)) add(item.id, "warn", `Reference ${k + 2} is ${r.origW}×${r.origH}, under Pruna's ${MIN_SIDE}×${MIN_SIDE} minimum.`);
      });
    } else if (small(item.img)) {
      add(item.id, "warn", `${item.img.origW}×${item.img.origH}, under Pruna's ${MIN_SIDE}×${MIN_SIDE} minimum.`);
    }
    if (!isComplete(item)) return;

    const own = (item.caption || "").trim();
    const effective = captionFor(meta, item);
    if (!own) {
      add(item.id, "warn", hasDefault ? "No caption — the default caption will be used." : effective ? `No caption — only the trigger word will be written.` : "No caption.");
    }
    if (trigger && effective && !effective.includes(trigger)) add(item.id, "warn", `Caption doesn't contain the trigger word “${trigger}”.`);
    // Pruna lists reused captions as something to avoid for image sets. Edit
    // pairs are different: its own edit notebook gives every pair the same
    // instruction, so repeats are not flagged there.
    if (photos && own) {
      const key = own.toLowerCase();
      if (typed.has(key)) add(item.id, "warn", `Same caption as ${label(typed.get(key))}.`);
      else typed.set(key, item.id);
    }
    for (let j = 0; j < idx; j++) {
      const other = items[j];
      if (!isComplete(other)) continue;
      const same = photos
        ? hashDistance(item.img.hash, other.img.hash) <= DUPLICATE_DISTANCE
        : hashDistance(item.before.hash, other.before.hash) <= DUPLICATE_DISTANCE &&
          hashDistance(item.after.hash, other.after.hash) <= DUPLICATE_DISTANCE;
      if (same) {
        add(item.id, "warn", `Looks like a duplicate of ${label(other.id)}.`);
        break;
      }
    }
  });
  return { global, perItem, size };
}

export function mb(bytes) {
  return `${(bytes / 1e6).toFixed(bytes < 10e6 ? 2 : 1)} MB`;
}

// ── Opening an existing ZIP ─────────────────────────────────────────────────

const IMAGE_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;
const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" };

function baseName(path) {
  return path.split("/").pop();
}

function stem(name) {
  return name.replace(/\.[^.]+$/, "");
}

// Sorts a ZIP's files into photos or pairs. Folders are flattened, macOS
// metadata is ignored, _input/_target are read as _start/_end, and masks are
// left out (the export never includes them).
export function classify(files) {
  const skipped = [];
  const captions = new Map();
  const images = [];
  const dec = new TextDecoder();
  for (const f of files) {
    if (f.name.includes("__MACOSX/")) continue;
    const name = baseName(f.name);
    if (!name || name.startsWith(".")) continue;
    if (/\.txt$/i.test(name)) captions.set(stem(name), dec.decode(f.data).trim());
    else if (IMAGE_EXT.test(name)) {
      const ext = name.split(".").pop().toLowerCase();
      images.push({ name, stem: stem(name), data: f.data, type: MIME[ext] });
    } else skipped.push({ name: f.name, why: "not an image or caption" });
  }

  const pairRe = /^(.*)_(start|input|end|target|mask)(\d*)$/i;
  const isPairs = images.some((im) => {
    const m = pairRe.exec(im.stem);
    return m && m[2].toLowerCase() !== "mask";
  });

  if (!isPairs) {
    return {
      mode: "photos",
      photos: images.map((im) => ({ ...im, caption: captions.get(im.stem) || "" })),
      pairs: [],
      skipped,
    };
  }

  const roots = new Map();
  const get = (root) => {
    if (!roots.has(root)) roots.set(root, { root, before: null, after: null, refs: [], caption: captions.get(root) || "" });
    return roots.get(root);
  };
  for (const im of images) {
    const m = pairRe.exec(im.stem);
    if (!m) {
      skipped.push({ name: im.name, why: "not named as part of a pair" });
      continue;
    }
    const kind = m[2].toLowerCase();
    const num = m[3] ? Number(m[3]) : 1;
    if (kind === "mask") {
      skipped.push({ name: im.name, why: "mask (left out)" });
      continue;
    }
    const pair = get(m[1]);
    if (kind === "end" || kind === "target") {
      if (pair.after) skipped.push({ name: im.name, why: "second after image for the same pair" });
      else pair.after = im;
    } else if (num <= 1) {
      if (pair.before) pair.refs.push({ ...im, num: 1.5 });
      else pair.before = im;
    } else pair.refs.push({ ...im, num });
  }
  const pairs = [...roots.values()].sort((a, b) => a.root.localeCompare(b.root, undefined, { numeric: true }));
  for (const p of pairs) p.refs.sort((a, b) => a.num - b.num);
  return { mode: "pairs", photos: [], pairs, skipped };
}
