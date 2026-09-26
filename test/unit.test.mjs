// Logic that needs no browser: ZIP format, sizing, pairing, naming, checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildZip, readZip, zipSize, crc32 } from "../public/js/zip.js";
import { planPair, fitLongEdge, hashDistance } from "../public/js/images.js";
import { captionFor, zipEntries, checks, classify, datasetSize, ZIP_LIMIT } from "../public/js/dataset.js";

const enc = new TextEncoder();
const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 256);

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(enc.encode("123456789")), 0xcbf43926);
});

test("buildZip output is valid for the system unzip and reads back identically", async () => {
  const entries = [
    { name: "image_000.jpg", data: bytes(5000) },
    { name: "image_000.txt", data: enc.encode("sks_x, a photo — ünïcode") },
    { name: "pair_000_start2.jpg", data: bytes(1, 9) },
  ];
  const blob = buildZip(entries);
  assert.equal(blob.size, zipSize(entries.map((e) => ({ name: e.name, size: e.data.length }))));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ldb-"));
  const file = path.join(dir, "t.zip");
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  const out = execFileSync("unzip", ["-t", file]).toString();
  assert.match(out, /No errors detected/);
  const listing = execFileSync("zipinfo", ["-1", file]).toString().trim().split("\n");
  assert.deepEqual(listing, entries.map((e) => e.name));
  const { files, skipped } = await readZip(blob);
  assert.equal(skipped.length, 0);
  files.forEach((f, i) => {
    assert.equal(f.name, entries[i].name);
    assert.deepEqual(f.data, entries[i].data);
  });
});

test("readZip inflates deflated entries written by other tools", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ldb-"));
  const file = path.join(dir, "py.zip");
  execFileSync("python3", ["-c", `
import zipfile
with zipfile.ZipFile(${JSON.stringify(file)}, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("set/a_start.png", b"A" * 5000)
    z.writestr("set/a.txt", "make it night")
    z.writestr("__MACOSX/set/._a_start.png", b"junk")
    z.writestr("set/", b"")
`]);
  const { files } = await readZip(new Blob([fs.readFileSync(file)]));
  const a = files.find((f) => f.name === "set/a_start.png");
  assert.equal(a.data.length, 5000);
  assert.ok(a.data.every((b) => b === 65));
  assert.equal(new TextDecoder().decode(files.find((f) => f.name === "set/a.txt").data), "make it night");
  assert.ok(!files.some((f) => f.name.endsWith("/")));
});

test("fitLongEdge never enlarges", () => {
  assert.deepEqual(fitLongEdge(4000, 3000), { w: 1024, h: 768 });
  assert.deepEqual(fitLongEdge(800, 600), { w: 800, h: 600 });
});

test("planPair: identical, same shape, different shape", () => {
  const same = planPair(4032, 3024, 4032, 3024);
  assert.equal(same.match, "none");
  assert.deepEqual(same.size, { w: 1024, h: 768 });

  const scaled = planPair(4032, 3024, 800, 600);
  assert.equal(scaled.match, "scaled");
  assert.deepEqual(scaled.size, { w: 800, h: 600 }, "the smaller image sets the size");

  const cropped = planPair(1600, 1200, 1024, 1024);
  assert.equal(cropped.match, "cropped");
  assert.deepEqual(cropped.beforeCrop, { x: 200, y: 0, w: 1200, h: 1200 }, "before cropped at its center to the after's shape");
  assert.deepEqual(cropped.afterCrop, { x: 0, y: 0, w: 1024, h: 1024 });
  assert.deepEqual(cropped.size, { w: 1024, h: 1024 });

  const cropAfter = planPair(1600, 1200, 1024, 1024, "after");
  assert.equal(cropAfter.match, "cropped");
  assert.deepEqual(cropAfter.beforeCrop, { x: 0, y: 0, w: 1600, h: 1200 });
  assert.deepEqual(cropAfter.afterCrop, { x: 0, y: 128, w: 1024, h: 768 }, "after cropped at its center to the before's shape");
  assert.deepEqual(cropAfter.size, { w: 1024, h: 768 });

  const tall = planPair(1000, 2000, 1200, 900);
  assert.equal(tall.match, "cropped");
  assert.deepEqual(tall.beforeCrop, { x: 0, y: 625, w: 1000, h: 750 });
  assert.deepEqual(tall.size, { w: 1000, h: 750 }, "limited by the cropped before");
});

test("hashDistance counts differing bits", () => {
  assert.equal(hashDistance("0000000000000000", "0000000000000000"), 0);
  assert.equal(hashDistance("000000000000000f", "0000000000000000"), 4);
  assert.equal(hashDistance("ffffffffffffffff", "0000000000000000"), 64);
});

const img = (w = 1024, h = 768, hash = "0123456789abcdef", size = 1000) => ({
  jpeg: new ArrayBuffer(size), thumb: new ArrayBuffer(10), hash, w, h, origW: w, origH: h, name: "x.jpg",
});

test("captionFor: default caption and trigger word", () => {
  const meta = { triggerWord: "sks_dog", autoTrigger: true, defaultCaption: "a photo" };
  assert.equal(captionFor(meta, { caption: "" }), "sks_dog, a photo");
  assert.equal(captionFor(meta, { caption: "sks_dog running" }), "sks_dog running");
  assert.equal(captionFor({ ...meta, defaultCaption: "" }, { caption: "" }), "sks_dog");
  assert.equal(captionFor({ ...meta, autoTrigger: false }, { caption: " hi " }), "hi");
});

test("zipEntries: photo and pair naming, incomplete pairs left out", () => {
  const photos = zipEntries({ mode: "photos", defaultCaption: "" }, [
    { id: "a", kind: "photo", caption: "one", img: img() },
    { id: "b", kind: "photo", caption: "", img: img() },
  ]);
  assert.deepEqual(photos.map((e) => e.name), ["image_000.jpg", "image_000.txt", "image_001.jpg"]);

  const pairs = zipEntries({ mode: "pairs", defaultCaption: "apply it" }, [
    { id: "p", kind: "pair", caption: "", before: img(), after: img(), refs: [img(), img()] },
    { id: "q", kind: "pair", caption: "x", before: img(), after: null, refs: [] },
    { id: "r", kind: "pair", caption: "night", before: img(), after: img(), refs: [] },
  ]);
  assert.deepEqual(pairs.map((e) => e.name), [
    "pair_000_start.jpg", "pair_000_start2.jpg", "pair_000_start3.jpg", "pair_000_end.jpg", "pair_000.txt",
    "pair_001_start.jpg", "pair_001_end.jpg", "pair_001.txt",
  ]);
  assert.equal(new TextDecoder().decode(pairs[4].data), "apply it");
});

test("checks: counts, captions, trigger, duplicates, small images, size", () => {
  const meta = { mode: "photos", triggerWord: "sks", autoTrigger: false, defaultCaption: "" };
  const items = [
    { id: "a", kind: "photo", caption: "sks one", img: img(1024, 768, "0000000000000000") },
    { id: "b", kind: "photo", caption: "Sks one", img: img(1024, 768, "ffffffffffffffff") },
    { id: "c", kind: "photo", caption: "", img: img(400, 300, "00000000000000ff") },
    { id: "d", kind: "photo", caption: "two", img: img(1024, 768, "0000000000000001") },
  ];
  const r = checks(meta, items);
  const g = r.global.map((x) => x.text).join("\n");
  assert.match(g, /at least 10 images; this set has 4/);
  assert.match(g, /1 photo has no caption and there is no default caption/);
  const t = (id) => (r.perItem.get(id) || []).map((x) => x.text).join("\n");
  assert.match(t("b"), /Same caption as Photo 1/);
  assert.match(t("b"), /trigger word “sks”/, "case matters for the trigger word");
  assert.match(t("c"), /400×300, under Pruna's 512×512 minimum/);
  assert.match(t("d"), /duplicate of Photo 1/);
  assert.doesNotMatch(t("a"), /duplicate/);

  const withDefault = checks({ ...meta, defaultCaption: "sks photo" }, items);
  assert.match(withDefault.global.map((x) => x.text).join("\n"), /default caption will be written for it/);

  const pairsMeta = { mode: "pairs", triggerWord: "", defaultCaption: "" };
  const pr = checks(pairsMeta, [
    { id: "p", kind: "pair", caption: "same", before: img(), after: img(), match: "cropped", refs: [] },
    { id: "q", kind: "pair", caption: "same", before: img(1024, 768, "ffffffffffffffff"), after: img(1024, 768, "ffffffffffffffff"), refs: [] },
    { id: "s", kind: "pair", caption: "", before: img(), after: null, refs: [] },
  ]);
  const pt = (id) => (pr.perItem.get(id) || []).map((x) => x.text).join("\n");
  assert.match(pt("p"), /cropped at its center/);
  assert.doesNotMatch(pt("q"), /Same caption/, "repeated edit instructions are not flagged");
  assert.match(pt("s"), /Missing the after image/);
  assert.doesNotMatch(pr.global.map((x) => x.text).join("\n"), /at least 10/);

  const big = [{ id: "z", kind: "photo", caption: "x", img: img(1024, 768, "0", ZIP_LIMIT) }];
  assert.ok(datasetSize(meta, big) > ZIP_LIMIT);
  assert.match(checks(meta, big).global.map((x) => x.text).join("\n"), /over the 99.0 MB upload limit/);
});

test("classify: pairs with alternate names, refs, masks, folders", () => {
  const f = (name, s = "x") => ({ name, data: enc.encode(s) });
  const c = classify([
    f("ds/room_01_input.png"), f("ds/room_01_target.png"), f("ds/room_01_mask.png"), f("ds/room_01.txt", "replace the sofa"),
    f("ds/b_start.jpg"), f("ds/b_start2.jpg"), f("ds/b_end.jpg"),
    f("ds/c_start.jpg"),
    f("ds/notes.pdf"), f("ds/random.jpg"), f("__MACOSX/ds/._b_start.jpg"), f("ds/.DS_Store"),
  ]);
  assert.equal(c.mode, "pairs");
  assert.deepEqual(c.pairs.map((p) => p.root), ["b", "c", "room_01"]);
  const room = c.pairs.find((p) => p.root === "room_01");
  assert.equal(room.before.name, "room_01_input.png");
  assert.equal(room.after.name, "room_01_target.png");
  assert.equal(room.caption, "replace the sofa");
  assert.equal(c.pairs.find((p) => p.root === "b").refs[0].name, "b_start2.jpg");
  assert.equal(c.pairs.find((p) => p.root === "c").after, null);
  const why = Object.fromEntries(c.skipped.map((s) => [s.name.split("/").pop(), s.why]));
  assert.equal(why["room_01_mask.png"], "mask (left out)");
  assert.equal(why["notes.pdf"], "not an image or caption");
  assert.equal(why["random.jpg"], "not named as part of a pair");

  const photos = classify([f("a.jpg"), f("a.txt", "cap"), f("b.webp")]);
  assert.equal(photos.mode, "photos");
  assert.equal(photos.photos.find((p) => p.name === "a.jpg").caption, "cap");
});
