import { db, prefs, requestPersistence } from "./store.js";
import { processSingle, processPair, decode } from "./images.js";
import { buildZip, readZip } from "./zip.js";
import {
  checks, zipEntries, isComplete, classify, itemLabel, mb,
  TRAINERS, PARAMS, RECOMMENDED, ZIP_LIMIT,
} from "./dataset.js";

const $ = (id) => document.getElementById(id);

// Small DOM builder: text always goes in as text nodes, never as HTML, so
// captions and file names cannot inject markup.
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const state = {
  meta: null,
  items: [],
  view: "start",
  queue: Promise.resolve(),
  pending: 0,
  done: 0,
  pick: null,
  prunaKey: "",
  hfToken: "",
  job: prefs.get("job"),
  output: null,
  polling: null,
  ticker: null,
  watching: false,
  wakeLock: null,
};

// ── thumbnails ─────────────────────────────────────────────────────────────
const urls = new Map();
function imgUrl(key, buf, type = "image/jpeg") {
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(new Blob([buf], { type })));
  return urls.get(key);
}
function dropUrls(prefix) {
  for (const [k, u] of urls) if (k.startsWith(prefix)) {
    URL.revokeObjectURL(u);
    urls.delete(k);
  }
}

// ── toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, isError = false) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("err", isError);
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), isError ? 7000 : 3500);
}

// ── saving files ───────────────────────────────────────────────────────────
// A plain <a download> on iOS opens a full-screen viewer with no way back;
// the share sheet offers "Save to Files" instead. Same approach as Patchbay.
async function saveBlob(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = h("a", { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    if (err && err.name !== "AbortError") toast("Save failed: " + err.message, true);
  }
}

// ── persistence ────────────────────────────────────────────────────────────
let metaTimer = null;
function saveMeta() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => db.putMeta({ ...state.meta, order: state.items.map((i) => i.id) }).catch(storageError), 300);
}
const itemTimers = new Map();
function saveItemSoon(item) {
  clearTimeout(itemTimers.get(item.id));
  itemTimers.set(item.id, setTimeout(() => db.putItem(item).catch(storageError), 400));
}
function storageError(err) {
  toast("This phone refused to save progress (" + (err && err.message) + "). Work continues, but a reload would lose it.", true);
}

async function load() {
  requestPersistence();
  try {
    const meta = await db.getMeta();
    if (meta) {
      const all = await db.allItems();
      const byId = new Map(all.map((i) => [i.id, i]));
      state.items = (meta.order || []).map((id) => byId.get(id)).filter(Boolean);
      for (const i of all) if (!state.items.includes(i)) state.items.push(i);
      state.meta = meta;
    }
    state.output = await db.getOutput();
  } catch (err) {
    storageError(err);
  }
  if (prefs.get("rememberKey")) state.prunaKey = prefs.get("prunaKey", "");
  // A reload during the upload loses it (nothing was created at Pruna yet);
  // a reload while the result was downloading can try the download again.
  if (state.job && (state.job.phase === "uploading" || state.job.phase === "submitting")) setJob(null);
  if (state.job && state.job.phase === "collecting") setJob({ ...state.job, phase: "uncollected", error: "The download was interrupted." });
  if (prefs.get("rememberHf")) state.hfToken = prefs.get("hfToken", "");
  show("start");
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function startDataset(mode) {
  if (state.meta && state.items.length && !confirm(`Replace the dataset in progress (${state.items.length} ${state.meta.mode === "photos" ? "photos" : "pairs"})?`)) return false;
  await db.clearDataset().catch(storageError);
  for (const i of state.items) dropUrls(i.id);
  state.items = [];
  state.meta = { mode, triggerWord: "", autoTrigger: false, defaultCaption: "", createdAt: Date.now() };
  saveMeta();
  return true;
}

// ── views ──────────────────────────────────────────────────────────────────
function show(view) {
  state.view = view;
  for (const v of ["start", "build", "check", "train"]) $("view-" + v).classList.toggle("hidden", v !== view);
  const hasSet = !!state.meta;
  $("steps").classList.toggle("hidden", !hasSet || view === "start");
  for (const b of $("steps").querySelectorAll("button")) {
    if (b.dataset.view === view) b.setAttribute("aria-current", "step");
    else b.removeAttribute("aria-current");
  }
  $("mode-line").textContent = hasSet
    ? state.meta.mode === "photos" ? "Photos + captions · p-image-trainer" : "Before / after pairs · p-image-edit-trainer"
    : "For Pruna's LoRA trainers";
  if (view === "start") renderStart();
  if (view === "build") renderBuild();
  if (view === "check") renderCheck();
  if (view === "train") renderTrain();
  updateDock();
  window.scrollTo(0, 0);
}

function updateDock() {
  const dock = $("dock");
  const active = state.meta && (state.view === "build" || state.view === "check");
  dock.classList.toggle("hidden", !active);
  if (!active) return;
  const r = checks(state.meta, state.items);
  $("meter-size").textContent = mb(r.size);
  $("meter-limit").textContent = `of ${mb(ZIP_LIMIT)}`;
  const bar = $("meter-bar");
  bar.style.width = Math.min(100, (r.size / ZIP_LIMIT) * 100) + "%";
  bar.classList.toggle("over", r.size > ZIP_LIMIT);
  let warnings = r.global.filter((x) => x.level === "warn").length;
  for (const list of r.perItem.values()) warnings += list.filter((x) => x.level === "warn").length;
  const pill = $("issues-pill");
  pill.textContent = warnings ? `${warnings} to check` : "No warnings";
  pill.classList.toggle("clear", !warnings);
  $("dock-next").textContent = state.view === "build" ? "Check" : "Train";
  return r;
}

// ── start ──────────────────────────────────────────────────────────────────
function renderStart() {
  const box = $("resume");
  box.replaceChildren();
  const job = state.job;
  if (job && (job.phase === "training" || job.phase === "uncollected")) {
    box.append(h("div", { class: "banner" },
      h("p", { text: job.phase === "training"
        ? `A training run (${job.model}) started ${ago(job.startedAt)} and may still be running.`
        : `A training run (${job.model}) finished but its result wasn't downloaded. Pruna keeps it for about 30 minutes.` }),
      h("div", { class: "actions" }, h("button", { type: "button", class: "primary", onclick: () => show("train") }, "Check on it"))));
  } else if (state.output || (job && job.phase === "done")) {
    box.append(h("div", { class: "banner" },
      h("p", { text: "A trained LoRA from your last run is saved on this phone." }),
      h("div", { class: "actions" }, h("button", { type: "button", class: "primary", onclick: () => show("train") }, "Open it"))));
  }
  if (state.meta) {
    const n = state.items.length;
    box.append(h("div", { class: "banner" },
      h("p", { text: `Dataset in progress: ${n} ${state.meta.mode === "photos" ? (n === 1 ? "photo" : "photos") : (n === 1 ? "pair" : "pairs")}.` }),
      h("div", { class: "actions" }, h("button", { type: "button", class: "primary", onclick: () => show("build") }, "Continue"))));
  }
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const hrs = Math.floor(m / 60);
  return `${hrs} h ${m % 60} min ago`;
}

// ── build ──────────────────────────────────────────────────────────────────
function renderBuild() {
  const m = state.meta;
  $("trigger").value = m.triggerWord || "";
  $("auto-trigger").checked = !!m.autoTrigger;
  $("default-caption").value = m.defaultCaption || "";
  $("settings").open = state.items.length === 0;
  $("add-photos").classList.toggle("hidden", m.mode !== "photos");
  $("add-pair").classList.toggle("hidden", m.mode !== "pairs");
  renderItems();
}

function renderItems() {
  const list = $("items");
  const r = checks(state.meta, state.items);
  list.replaceChildren(...state.items.map((item, i) => (item.kind === "photo" ? photoCard(item, i) : pairCard(item, i))));
  paintIssues(r);
  const empty = $("empty");
  empty.classList.toggle("hidden", state.items.length > 0);
  empty.textContent = state.meta.mode === "photos"
    ? "Add at least 10 photos. Pruna suggests 15–40 for a person or character."
    : "Add before/after pairs one at a time. Pruna suggests 100–300 pairs for simple edits.";
}

function paintIssues(r) {
  for (const item of state.items) {
    const ul = document.querySelector(`#item-${item.id} .issues`);
    if (!ul) continue;
    ul.replaceChildren(...(r.perItem.get(item.id) || []).map((x) => h("li", { class: x.level, text: x.text })));
  }
  updateDock();
}

let recheckTimer = null;
function recheckSoon() {
  clearTimeout(recheckTimer);
  recheckTimer = setTimeout(() => paintIssues(checks(state.meta, state.items)), 250);
}

function captionBox(item, placeholder) {
  return h("textarea", {
    class: "caption", rows: 3, placeholder, "aria-label": "Caption",
    oninput: (e) => {
      item.caption = e.target.value;
      saveItemSoon(item);
      recheckSoon();
    },
  }, item.caption || "");
}

function removeItem(item) {
  if (!confirm(`Remove ${itemLabel(state.meta, state.items, item.id)}?`)) return;
  state.items = state.items.filter((x) => x !== item);
  dropUrls(item.id);
  db.deleteItem(item.id).catch(storageError);
  saveMeta();
  renderItems();
}

function photoCard(item, i) {
  const img = item.img;
  return h("li", { class: "card", id: `item-${item.id}` },
    h("div", { class: "card-head" },
      h("span", { class: "label", text: `Photo ${i + 1}` }),
      h("span", { class: "dims", text: `${img.origW}×${img.origH} → ${img.w}×${img.h} · ${Math.round(img.jpeg.byteLength / 1000)} KB` }),
      h("button", { type: "button", class: "ghost danger", onclick: () => removeItem(item) }, "Remove")),
    h("div", { class: "photo-body" },
      h("img", { class: "thumb", src: imgUrl(`${item.id}:t`, img.thumb), alt: img.name || "" }),
      captionBox(item, "Caption — describe what the model should learn")),
    h("ul", { class: "issues" }));
}

function slot(item, side) {
  const img = item[side];
  const label = side === "before" ? "Before" : "After";
  const btn = h("button", {
    type: "button", class: "slot-btn",
    "aria-label": img ? `Replace the ${side} image` : `Choose the ${side} image`,
    onclick: () => pickFor({ item, side }),
  }, img ? h("img", { src: imgUrl(`${item.id}:${side}:${img.hash}`, img.thumb), alt: "" }) : `Choose ${side}`);
  return h("figure", { class: "slot" }, btn, h("figcaption", { text: img ? `${label} · ${img.w}×${img.h}` : label }));
}

function pairCard(item, i) {
  const refs = (item.refs || []).map((r, k) =>
    h("div", { class: "ref" },
      h("img", { src: imgUrl(`${item.id}:r${k}:${r.hash}`, r.thumb), alt: `Reference ${k + 2}` }),
      h("button", {
        type: "button", "aria-label": `Remove reference ${k + 2}`,
        onclick: () => {
          item.refs.splice(k, 1);
          dropUrls(`${item.id}:r`);
          db.putItem(item).catch(storageError);
          renderItems();
        },
      }, "✕")));
  return h("li", { class: "card pair", id: `item-${item.id}` },
    h("div", { class: "card-head" },
      h("span", { class: "label", text: `Pair ${i + 1}` }),
      h("span", { class: "dims" }),
      isComplete(item) ? h("button", { type: "button", class: "ghost", onclick: () => openFlip(item) }, "Flip") : null,
      h("button", { type: "button", class: "ghost danger", onclick: () => removeItem(item) }, "Remove")),
    h("div", { class: "pair-row" }, slot(item, "before"), slot(item, "after")),
    h("div", { class: "refs" }, refs,
      h("button", { type: "button", class: "ghost add-ref", onclick: () => pickRefs(item) }, "+ Reference image")),
    captionBox(item, "Instruction — describe only the change, e.g. “replace the background with a snowy mountain landscape”"),
    h("ul", { class: "issues" }));
}

// ── picking and processing ────────────────────────────────────────────────
function enqueue(task) {
  state.pending++;
  showProgress();
  state.queue = state.queue.then(task).catch((err) => toast(err.message || String(err), true)).finally(() => {
    state.done++;
    if (state.done >= state.pending) {
      state.pending = state.done = 0;
    }
    showProgress();
  });
  return state.queue;
}

function showProgress() {
  const p = $("progress");
  p.classList.toggle("hidden", !state.pending);
  if (state.pending) p.textContent = `Processing ${Math.min(state.done + 1, state.pending)} of ${state.pending}…`;
}

function pickFor(target) {
  state.pick = target;
  const input = $("pick-one");
  input.value = "";
  input.click();
}

function pickRefs(item) {
  state.pick = { item, side: "refs" };
  const input = $("pick-refs");
  input.value = "";
  input.click();
}

async function addPhoto(file) {
  const img = await processSingle(file, file.name);
  const item = { id: newId(), kind: "photo", caption: "", img };
  state.items.push(item);
  await db.putItem(item).catch(storageError);
  saveMeta();
  if (state.view === "build") renderItems();
}

async function fillSlot(item, side, file) {
  const other = side === "before" ? "after" : "before";
  const otherPending = item["pending_" + other];
  const otherBlob = otherPending
    ? new Blob([otherPending.bytes], { type: otherPending.type })
    : item[other] ? new Blob([item[other].jpeg], { type: "image/jpeg" }) : null;
  if (otherBlob) {
    const beforeBlob = side === "before" ? file : otherBlob;
    const afterBlob = side === "after" ? file : otherBlob;
    const names = side === "before" ? [file.name, item.after && item.after.name] : [item.before && item.before.name, file.name];
    const r = await processPair(beforeBlob, afterBlob, names[0], names[1]);
    item.before = r.before;
    item.after = r.after;
    item.match = r.match;
    item.pending_before = item.pending_after = null;
  } else {
    item[side] = await processSingle(file, file.name);
    item["pending_" + side] = { bytes: await file.arrayBuffer(), type: file.type || "image/jpeg", name: file.name };
    item.match = null;
  }
  dropUrls(item.id);
  if (!state.items.includes(item)) state.items.push(item);
  await db.putItem(item).catch(storageError);
  saveMeta();
  if (state.view === "build") renderItems();
}

async function addRef(item, file) {
  const img = await processSingle(file, file.name);
  item.refs = [...(item.refs || []), img];
  await db.putItem(item).catch(storageError);
  if (state.view === "build") renderItems();
}

// ── opening a ZIP ──────────────────────────────────────────────────────────
async function openZip(file) {
  let parsed;
  try {
    parsed = await readZip(file);
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const c = classify(parsed.files);
  if (!c.photos.length && !c.pairs.length) {
    toast("No images found in that ZIP.", true);
    return;
  }
  if (!(await startDataset(c.mode))) return;
  const skipped = [...parsed.skipped.map((n) => ({ name: n, why: "compressed in a way this app can't read" })), ...c.skipped];
  const failed = [];
  show("build");
  const blobOf = (im) => new Blob([im.data], { type: im.type });
  if (c.mode === "photos") {
    for (const p of c.photos) {
      enqueue(async () => {
        try {
          const img = await processSingle(blobOf(p), p.name);
          const item = { id: newId(), kind: "photo", caption: p.caption, img };
          state.items.push(item);
          await db.putItem(item).catch(storageError);
        } catch {
          failed.push(p.name);
        }
      });
    }
  } else {
    for (const p of c.pairs) {
      enqueue(async () => {
        const item = { id: newId(), kind: "pair", caption: p.caption, before: null, after: null, refs: [], match: null };
        try {
          if (p.before && p.after) {
            const r = await processPair(blobOf(p.before), blobOf(p.after), p.before.name, p.after.name);
            Object.assign(item, { before: r.before, after: r.after, match: r.match });
          } else {
            const one = p.before || p.after;
            const side = p.before ? "before" : "after";
            item[side] = await processSingle(blobOf(one), one.name);
            item["pending_" + side] = { bytes: one.data.buffer.slice(one.data.byteOffset, one.data.byteOffset + one.data.byteLength), type: one.type, name: one.name };
          }
          for (const ref of p.refs) item.refs.push(await processSingle(blobOf(ref), ref.name));
          state.items.push(item);
          await db.putItem(item).catch(storageError);
        } catch {
          failed.push(p.root);
        }
      });
    }
  }
  await state.queue;
  saveMeta();
  const lines = [...skipped.map((s) => `${s.name}: ${s.why}`), ...failed.map((n) => `${n}: could not be read as an image`)];
  const notice = $("notice");
  notice.replaceChildren(
    h("strong", { text: `Opened ${file.name}: ${state.items.length} ${c.mode === "photos" ? "photos" : "pairs"}.` }),
    lines.length ? h("div", { text: "Left out:" }) : null,
    lines.length ? h("ul", {}, ...lines.slice(0, 30).map((l) => h("li", { text: l })), lines.length > 30 ? h("li", { text: `…and ${lines.length - 30} more` }) : null) : null);
  notice.classList.remove("hidden");
  renderItems();
}

// ── flip compare ───────────────────────────────────────────────────────────
function openFlip(item) {
  const dlg = $("flip");
  let side = "before";
  const paint = () => {
    $("flip-img").src = imgUrl(`${item.id}:full:${side}:${item[side].hash}`, item[side].jpeg);
    $("flip-label").textContent = side === "before" ? "Before" : "After";
  };
  $("flip-stage").onclick = () => {
    side = side === "before" ? "after" : "before";
    paint();
  };
  paint();
  dlg.showModal();
}

// ── check ──────────────────────────────────────────────────────────────────
function renderCheck() {
  const r = checks(state.meta, state.items);
  const done = state.items.filter(isComplete).length;
  const what = state.meta.mode === "photos" ? "photos" : "complete pairs";
  $("summary").textContent = `${done} ${what} · ZIP ${mb(r.size)}`;
  $("global-issues").replaceChildren(...r.global.map((x) => h("li", { class: x.level, text: x.text })));
  const groups = [];
  for (const item of state.items) {
    const list = r.perItem.get(item.id);
    if (!list || !list.length) continue;
    groups.push(h("div", { class: "item-group" },
      h("div", { class: "item-group-head" },
        h("strong", { text: itemLabel(state.meta, state.items, item.id) }),
        h("button", { type: "button", class: "ghost", onclick: () => jumpTo(item.id) }, "Show")),
      h("ul", { class: "issues" }, ...list.map((x) => h("li", { class: x.level, text: x.text })))));
  }
  $("item-issues").replaceChildren(...groups);
  $("rec-table").replaceChildren(...RECOMMENDED[state.meta.mode].map(([k, v]) => h("tr", {}, h("td", { text: k }), h("td", { text: v }))));
  const files = zipEntries(state.meta, state.items);
  $("files").replaceChildren(...files.slice(0, 400).map((f) => h("li", { text: `${f.name} (${f.data.length.toLocaleString()} bytes)` })));
  const over = r.size > ZIP_LIMIT;
  $("go-train").disabled = over || !done;
  $("download-zip").disabled = !done;
  $("train-blocked").textContent = over
    ? `Training here needs the ZIP under ${mb(ZIP_LIMIT)} (Pruna's upload limit is 100 MB). Remove some items, or download the ZIP.`
    : "";
}

function jumpTo(id) {
  show("build");
  const el = $("item-" + id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 1600);
}

function zipName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `lora-${state.meta.mode === "photos" ? "images" : "pairs"}-${stamp}.zip`;
}

function makeZip() {
  return buildZip(zipEntries(state.meta, state.items));
}

// ── train ──────────────────────────────────────────────────────────────────
function trainer() {
  const mode = state.job ? (state.job.model === "p-image-trainer" ? "photos" : "pairs") : state.meta ? state.meta.mode : "photos";
  return { mode, ...TRAINERS[mode] };
}

function paramValues(model) {
  return prefs.get("params." + model, {});
}

function renderParams() {
  const t = trainer();
  const box = $("params");
  // Removing a focused, edited input fires its change event mid-removal,
  // which would re-enter this function; blurring first lets that happen
  // before the rebuild instead of during it.
  if (box.contains(document.activeElement)) document.activeElement.blur();
  const saved = paramValues(t.model);
  const rows = [];
  for (const [key, p] of Object.entries(PARAMS)) {
    if (p.photosOnly && t.mode !== "photos") continue;
    const value = saved[key] ?? p.def;
    const changed = value !== p.def;
    let input;
    if (p.options) {
      input = h("select", { id: "param-" + key }, ...p.options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)));
    } else {
      input = h("input", { type: "number", id: "param-" + key, inputmode: "decimal", min: p.min, max: p.max, step: p.step || "any", value: String(value) });
    }
    const range = p.options
      ? `Pruna default: ${p.options.find(([v]) => v === p.def)[1].split(" — ")[0]}`
      : `Range ${fmt(p.min)}–${fmt(p.max)}${p.step ? `, steps of ${p.step}` : ""} · Pruna default ${fmt(p.def)}. ${p.help}`;
    rows.push(h("div", { class: "param" + (changed ? " changed" : "") },
      h("div", { class: "param-head" },
        h("label", { class: "field-label", for: "param-" + key, text: p.label }),
        changed ? h("button", { type: "button", class: "ghost", onclick: () => setParam(key, p.def) }, "Reset") : null),
      input,
      h("p", { class: "range", text: range })));
    input.addEventListener("change", () => {
      let v = p.options ? input.value : Number(input.value);
      if (!p.options) {
        if (!Number.isFinite(v)) v = p.def;
        v = Math.min(p.max, Math.max(p.min, v));
        if (p.step) v = Math.round(v / p.step) * p.step;
      }
      setParam(key, v);
    });
  }
  const dc = saved.default_caption ?? (state.meta ? state.meta.defaultCaption || "" : "");
  rows.push(h("div", { class: "param" },
    h("label", { class: "field-label", for: "param-default_caption", text: "Default caption (sent to Pruna)" }),
    h("input", { type: "text", id: "param-default_caption", value: dc, onchange: (e) => setParam("default_caption", e.target.value) }),
    h("p", { class: "range", text: "Used by Pruna only for files without a caption. The ZIP already carries a caption file for every item that has one." })));
  box.replaceChildren(...rows);
  const steps = saved.steps ?? PARAMS.steps.def;
  $("cost").textContent = `Cost: $${((steps / 1000) * t.usdPer1000Steps).toFixed(2)} (${steps.toLocaleString()} steps at $${t.usdPer1000Steps.toFixed(2)} per 1,000)`;
  // Pruna's steps guidelines table, same for both trainers.
  const guide = steps <= 500 ? "minutes" : steps <= 1000 ? "10–30 minutes" : steps <= 2000 ? "30–60 minutes" : "1–2+ hours";
  $("time-guide").textContent = `Pruna's guide for this many steps: ${guide}.`;
  $("start-training").textContent = `Upload and start training · $${((steps / 1000) * t.usdPer1000Steps).toFixed(2)}`;
}

function fmt(n) {
  return n.toLocaleString("en-US", { maximumFractionDigits: 5 });
}

function setParam(key, value) {
  const t = trainer();
  const saved = paramValues(t.model);
  if (PARAMS[key] && value === PARAMS[key].def) delete saved[key];
  else saved[key] = value;
  prefs.set("params." + t.model, saved);
  renderParams();
}

function renderTrain() {
  const t = trainer();
  $("pruna-key").value = state.prunaKey;
  $("remember-key").checked = !!prefs.get("rememberKey");
  $("trainer-line").textContent = `Trainer: ${t.model} → use the result with ${t.use}.`;
  $("wake-row").classList.toggle("hidden", !("wakeLock" in navigator));
  $("wake").checked = !!prefs.get("wake");
  renderParams();
  const job = state.job;
  const running = job && job.phase === "training";
  $("train-setup").classList.toggle("hidden", !!running || !!state.output || !state.meta);
  $("job").classList.toggle("hidden", !job);
  $("result").classList.toggle("hidden", !state.output);
  if (job) paintJob();
  if (state.output) renderResult();
  if (running && !state.watching) watch();
}

function setJob(job) {
  state.job = job;
  prefs.set("job", job);
}

function paintJob(extra) {
  const job = state.job;
  if (!job) return;
  const bar = $("job-bar");
  bar.classList.remove("indeterminate");
  let title = "Training";
  let status = "";
  let detail = "";
  if (job.phase === "uploading") {
    title = "Uploading";
    status = `Uploading the ZIP… ${Math.round((job.progress || 0) * 100)}%`;
    bar.style.width = Math.round((job.progress || 0) * 100) + "%";
  } else if (job.phase === "submitting") {
    status = "Starting the training job…";
    bar.classList.add("indeterminate");
  } else if (job.phase === "training") {
    const secs = Math.round((Date.now() - job.startedAt) / 1000);
    status = `${cap(job.status || "starting")} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} elapsed`;
    detail = state.watching
      ? `Checked ${job.lastPoll ? ago(job.lastPoll) : "not yet"}. You can leave this screen; the job keeps running at Pruna and this app picks it up when you come back. The result must be downloaded within about 30 minutes of finishing.`
      : "Not being watched. Enter your key above and tap Check now.";
    bar.classList.add("indeterminate");
  } else if (job.phase === "collecting") {
    status = "Finished — downloading the result…";
    bar.classList.add("indeterminate");
  } else if (job.phase === "done") {
    title = "Finished";
    status = "Training finished.";
    bar.style.width = "100%";
  } else if (job.phase === "failed") {
    title = "Failed";
    status = job.error || "Training failed.";
    detail = "Pruna reported this job as failed. The settings above can be changed and the training started again.";
    bar.style.width = "0";
  } else if (job.phase === "uncollected") {
    title = "Finished, not downloaded";
    status = job.error || "The result could not be downloaded.";
    detail = "Pruna keeps the result for about 30 minutes after training ends.";
  }
  $("job-title").textContent = title;
  $("job-status").textContent = extra || status;
  $("job-detail").textContent = detail;
  $("stop-watching").classList.toggle("hidden", job.phase !== "training");
  $("stop-watching").textContent = state.watching ? "Stop watching" : "Check now";
  $("retry-output").classList.toggle("hidden", job.phase !== "uncollected");
  if (job.phase === "failed" && state.meta) $("train-setup").classList.remove("hidden");
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function keyHeader() {
  const key = ($("pruna-key").value || state.prunaKey || "").trim();
  if (!key) throw new Error("Enter your Pruna API key first.");
  return { "x-pruna-key": key };
}

async function readError(res) {
  const text = await res.text().catch(() => "");
  try {
    const d = JSON.parse(text);
    const e = d.error;
    if (typeof e === "string") return e;
    if (e && typeof e === "object") return [e.message, e.details].filter(Boolean).join(" — ") || JSON.stringify(e);
    return d.message || d.detail || `HTTP ${res.status}`;
  } catch {
    return text.slice(0, 300) || `HTTP ${res.status}`;
  }
}

// XMLHttpRequest rather than fetch because fetch reports no upload progress.
function xhrUpload(url, body, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => resolve(new Response(x.responseText, { status: x.status, headers: { "content-type": "application/json" } }));
    x.onerror = () => reject(new Error("The upload failed — check the connection and try again."));
    x.send(body);
  });
}

async function startTraining() {
  if (!state.meta) return toast("There is no dataset to train on.", true);
  let headers;
  try {
    headers = keyHeader();
  } catch (err) {
    toast(err.message, true);
    return;
  }
  const t = trainer();
  const saved = paramValues(t.model);
  const input = { steps: saved.steps ?? PARAMS.steps.def, learning_rate: saved.learning_rate ?? PARAMS.learning_rate.def };
  if (t.mode === "photos") input.training_type = saved.training_type ?? PARAMS.training_type.def;
  const dc = (saved.default_caption ?? (state.meta.defaultCaption || "")).trim();
  if (dc) input.default_caption = dc;
  const cost = ((input.steps / 1000) * t.usdPer1000Steps).toFixed(2);
  if (!confirm(`Start ${t.model} with ${input.steps} steps? Pruna bills $${cost}.`)) return;

  const blob = makeZip();
  if (blob.size > ZIP_LIMIT) {
    toast("The ZIP is over the upload limit.", true);
    return;
  }
  setJob({ phase: "uploading", model: t.model, progress: 0, steps: input.steps, cost });
  $("train-setup").classList.add("hidden");
  $("job").classList.remove("hidden");
  paintJob();
  try {
    const form = new FormData();
    form.append("content", new File([blob], zipName(), { type: "application/zip" }));
    const up = await xhrUpload("/api/pruna/files", form, headers, (p) => {
      state.job.progress = p;
      paintJob();
    });
    if (!up.ok) throw new Error("Pruna refused the upload: " + (await readError(up)));
    const { url } = await up.json();
    setJob({ ...state.job, phase: "submitting" });
    paintJob();
    const res = await fetch("/api/pruna/train", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model: t.model, input: { image_data: url, ...input } }),
    });
    if (!res.ok) throw new Error("Pruna refused to start training: " + (await readError(res)));
    const data = await res.json();
    if (!data.id) throw new Error("Pruna started nothing (no job id came back).");
    setJob({ phase: "training", id: data.id, model: t.model, startedAt: Date.now(), steps: input.steps, cost, status: "starting" });
    paintJob();
    watch();
  } catch (err) {
    setJob(null);
    $("job").classList.add("hidden");
    $("train-setup").classList.remove("hidden");
    toast(err.message, true);
  }
}

// Pruna allows 30,000 status checks a minute, so 15 s is far inside it. The
// ?poll= override exists for the browser tests.
const POLL_MS = Number(new URLSearchParams(location.search).get("poll")) || 15000;

async function watch() {
  if (!state.job || state.job.phase !== "training") return;
  try {
    keyHeader();
  } catch {
    state.watching = false;
    paintJob();
    return;
  }
  state.watching = true;
  clearInterval(state.ticker);
  state.ticker = setInterval(() => state.job && state.job.phase === "training" && paintJob(), 1000);
  if ($("wake").checked && "wakeLock" in navigator) {
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
    } catch {}
  }
  pollOnce();
}

function stopWatching() {
  state.watching = false;
  clearTimeout(state.polling);
  clearInterval(state.ticker);
  if (state.wakeLock) state.wakeLock.release().catch(() => {});
  state.wakeLock = null;
  if (state.job) paintJob();
}

async function pollOnce() {
  clearTimeout(state.polling);
  if (!state.watching || !state.job || state.job.phase !== "training") return;
  try {
    const res = await fetch("/api/pruna/status?id=" + encodeURIComponent(state.job.id), { headers: keyHeader() });
    const text = await res.text();
    let s = {};
    try {
      s = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        stopWatching();
        paintJob("Pruna refused the key. Check it and tap Check now.");
        return;
      }
      throw new Error(typeof s.error === "string" ? s.error : `HTTP ${res.status}`);
    }
    state.job.lastPoll = Date.now();
    // A failed job can answer with an `error` and no `status` (seen in Patchbay).
    const err = typeof s.error === "string" ? s.error.trim() : "";
    if (s.status === "succeeded") {
      const out = [s.generation_url, s.output, s.output_url].flat().find((v) => typeof v === "string" && v);
      if (!out) throw new Error("Pruna reported success but gave no download link.");
      setJob({ ...state.job, phase: "collecting", outputUrl: out, finishedAt: Date.now(), status: "succeeded" });
      stopWatching();
      await collect();
      return;
    }
    if (s.status === "failed" || s.status === "canceled" || err) {
      setJob({ ...state.job, phase: "failed", error: [err, s.message].filter(Boolean).join(" — ") || `Training ${s.status}.` });
      stopWatching();
      return;
    }
    setJob({ ...state.job, status: s.status || "processing" });
    paintJob();
  } catch (err) {
    paintJob(`Couldn't reach Pruna (${err.message}). Trying again…`);
  }
  state.polling = setTimeout(pollOnce, POLL_MS);
}

async function collect() {
  paintJob();
  try {
    const res = await fetch("/api/pruna/output?url=" + encodeURIComponent(state.job.outputUrl), { headers: keyHeader() });
    if (!res.ok) throw new Error(await readError(res));
    const zip = await res.arrayBuffer();
    const { files } = await readZip(new Blob([zip]));
    const weights = files.find((f) => /\.safetensors$/i.test(f.name));
    const rec = {
      jobId: state.job.id, model: state.job.model, zip, savedAt: Date.now(),
      weightsName: weights ? weights.name.split("/").pop() : null, weightsSize: weights ? weights.data.length : 0,
      files: files.map((f) => f.name),
    };
    await db.putOutput(rec).catch(storageError);
    state.output = rec;
    setJob({ ...state.job, phase: "done" });
    renderTrain();
    toast("Your LoRA is ready.");
  } catch (err) {
    setJob({ ...state.job, phase: "uncollected", error: "Download failed: " + err.message });
    paintJob();
  }
}

// ── result + Hugging Face ──────────────────────────────────────────────────
function renderResult() {
  const o = state.output;
  $("result-detail").textContent = o.weightsName
    ? `${o.model}: ${o.weightsName} (${mb(o.weightsSize)}), saved on this phone.`
    : `${o.model}: saved on this phone. No .safetensors file was found inside (files: ${o.files.join(", ")}).`;
  $("hf-token").value = state.hfToken;
  $("remember-hf").checked = !!prefs.get("rememberHf");
  $("hf-upload").disabled = !o.weightsName;
  const owner = $("hf-owner");
  if (!owner.options.length) owner.append(h("option", { value: "" }, "—"));
  if (!$("hf-repo").value) {
    const trig = ((state.meta && state.meta.triggerWord) || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    $("hf-repo").value = `${o.model === "p-image-trainer" ? "p-image-lora" : "p-image-edit-lora"}${trig ? "-" + trig : ""}`;
  }
  const last = prefs.get("hfResult");
  if (last && last.jobId === o.jobId) showHfResult(last);
  if (state.hfToken && owner.options.length <= 1) checkHfToken();
}

async function checkHfToken() {
  const token = $("hf-token").value.trim();
  if (!token) return null;
  const who = $("hf-who");
  who.textContent = "Checking the token…";
  try {
    const res = await fetch("/api/hf/whoami", { headers: { "x-hf-token": token } });
    if (!res.ok) throw new Error(await readError(res));
    const me = await res.json();
    who.textContent = `Signed in as ${me.name}${me.role ? ` · ${me.role} token` : ""}.${me.role === "read" ? " A read token can't upload; create a Write token." : ""}`;
    const owner = $("hf-owner");
    const keep = owner.value;
    owner.replaceChildren(...[me.name, ...me.orgs].map((n) => h("option", { value: n, selected: n === keep }, n)));
    return me;
  } catch (err) {
    who.textContent = err.message;
    return null;
  }
}

async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadToHf() {
  const o = state.output;
  const token = $("hf-token").value.trim();
  if (!token) return toast("Enter your Hugging Face token first.", true);
  const me = $("hf-owner").value ? { name: $("hf-owner").value } : await checkHfToken();
  if (!me) return;
  const owner = $("hf-owner").value || me.name;
  const repo = $("hf-repo").value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(repo)) return toast("Repository names use letters, digits, . _ and -.", true);
  const btn = $("hf-upload");
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    const { files } = await readZip(new Blob([o.zip]));
    const weights = files.find((f) => /\.safetensors$/i.test(f.name));
    const hash = await sha256Hex(weights.data);
    const url = `/api/hf/upload?repo=${encodeURIComponent(owner + "/" + repo)}&private=${$("hf-private").checked ? 1 : 0}&path=weights.safetensors`;
    const res = await xhrUpload(url, new Blob([weights.data]), { "x-hf-token": token, "x-sha256": hash }, (p) => {
      btn.textContent = `Uploading… ${Math.round(p * 100)}%`;
    });
    if (!res.ok) throw new Error(await readError(res));
    const result = { ...(await res.json()), jobId: o.jobId };
    prefs.set("hfResult", result);
    showHfResult(result);
    toast("Uploaded to Hugging Face.");
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = "Upload weights";
  }
}

function showHfResult(r) {
  $("hf-result").classList.remove("hidden");
  $("hf-weights").textContent = r.lora_weights;
  $("hf-link").href = `https://huggingface.co/${r.repo}`;
}

// ── wiring ─────────────────────────────────────────────────────────────────
function wire() {
  for (const b of document.querySelectorAll(".choice[data-mode]")) {
    b.addEventListener("click", async () => {
      if (await startDataset(b.dataset.mode)) {
        $("notice").classList.add("hidden");
        show("build");
      }
    });
  }
  $("open-zip").addEventListener("click", () => {
    $("pick-zip").value = "";
    $("pick-zip").click();
  });
  $("pick-zip").addEventListener("change", (e) => e.target.files[0] && openZip(e.target.files[0]));
  for (const b of $("steps").querySelectorAll("button")) b.addEventListener("click", () => show(b.dataset.view));

  $("trigger").addEventListener("input", (e) => {
    state.meta.triggerWord = e.target.value.trim();
    saveMeta();
    recheckSoon();
  });
  $("auto-trigger").addEventListener("change", (e) => {
    state.meta.autoTrigger = e.target.checked;
    saveMeta();
    recheckSoon();
  });
  $("default-caption").addEventListener("input", (e) => {
    state.meta.defaultCaption = e.target.value;
    saveMeta();
    recheckSoon();
  });

  $("add-photos").addEventListener("click", () => {
    $("pick-photos").value = "";
    $("pick-photos").click();
  });
  $("pick-photos").addEventListener("change", (e) => {
    for (const f of e.target.files) enqueue(() => addPhoto(f));
  });
  $("add-pair").addEventListener("click", () =>
    pickFor({ item: { id: newId(), kind: "pair", caption: "", before: null, after: null, refs: [], match: null }, side: "before" }));
  $("pick-one").addEventListener("change", (e) => {
    const f = e.target.files[0];
    const target = state.pick;
    if (f && target) enqueue(() => fillSlot(target.item, target.side, f));
  });
  $("pick-refs").addEventListener("change", (e) => {
    const target = state.pick;
    for (const f of e.target.files) enqueue(() => addRef(target.item, f));
  });
  $("start-over").addEventListener("click", async () => {
    if (!confirm("Delete this dataset from the phone and start over?")) return;
    await db.clearDataset().catch(storageError);
    for (const i of state.items) dropUrls(i.id);
    state.items = [];
    state.meta = null;
    show("start");
  });

  $("issues-pill").addEventListener("click", () => show("check"));
  $("dock-next").addEventListener("click", () => show(state.view === "build" ? "check" : "train"));
  $("download-zip").addEventListener("click", () => saveBlob(makeZip(), zipName()));
  $("go-train").addEventListener("click", () => show("train"));

  $("pruna-key").addEventListener("input", (e) => {
    state.prunaKey = e.target.value.trim();
    if (prefs.get("rememberKey")) prefs.set("prunaKey", state.prunaKey);
  });
  $("remember-key").addEventListener("change", (e) => {
    prefs.set("rememberKey", e.target.checked || null);
    prefs.set("prunaKey", e.target.checked ? state.prunaKey : null);
  });
  $("wake").addEventListener("change", (e) => prefs.set("wake", e.target.checked || null));
  $("start-training").addEventListener("click", startTraining);
  $("stop-watching").addEventListener("click", () => (state.watching ? stopWatching() : watch()));
  $("retry-output").addEventListener("click", collect);

  $("save-lora").addEventListener("click", () => {
    const o = state.output;
    saveBlob(new Blob([o.zip], { type: "application/zip" }), `${o.model === "p-image-trainer" ? "p-image" : "p-image-edit"}-lora-${o.jobId}.zip`);
  });
  $("hf-token").addEventListener("input", (e) => {
    state.hfToken = e.target.value.trim();
    if (prefs.get("rememberHf")) prefs.set("hfToken", state.hfToken);
  });
  $("hf-token").addEventListener("change", checkHfToken);
  $("remember-hf").addEventListener("change", (e) => {
    prefs.set("rememberHf", e.target.checked || null);
    prefs.set("hfToken", e.target.checked ? state.hfToken : null);
  });
  $("hf-upload").addEventListener("click", uploadToHf);
  $("copy-weights").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("hf-weights").textContent);
      toast("Copied.");
    } catch {
      toast("Copy failed — press and hold the text to copy it.", true);
    }
  });
  $("finish-run").addEventListener("click", async () => {
    if (!confirm("Remove the trained LoRA from this phone? Save it or upload it first.")) return;
    await db.clearOutput().catch(storageError);
    state.output = null;
    setJob(null);
    prefs.set("hfResult", null);
    show(state.meta ? "check" : "start");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.watching) pollOnce();
  });
}

// Exposed for the browser tests only.
window.__ldb = { state, decode };

wire();
load();
