// End-to-end: the real Worker (wrangler dev) and the real app in Chromium,
// against the stand-in upstream in mock-upstream.mjs. No keys, no charges.
//
// Playwright is not a dependency of this repo; it is loaded from the global
// install (npm i -g playwright). Only Chromium is exercised here: Safari's
// engine was not available where this suite was written, so iPhone-specific
// behaviour (HEIC, the share sheet, EXIF rotation) is not covered.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { startMock, PRUNA_KEY, HF_TOKEN } from "./mock-upstream.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const out = path.join(root, "test", ".out");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

let chromium;
try {
  chromium = createRequire(import.meta.url)("playwright").chromium;
} catch {
  const globalRoot = execFileSync("npm", ["root", "-g"]).toString().trim();
  chromium = createRequire(globalRoot + "/")("playwright").chromium;
}

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${msg}`);
  if (!cond) failures++;
};

const mock = await startMock();
const port = 8700 + Math.floor(Math.random() * 90);
const wr = spawn("npx", ["wrangler", "dev", "--ip", "127.0.0.1", "--port", String(port),
  "--var", `PRUNA_BASE:${mock.base}`, "--var", `HF_BASE:${mock.base}`, "--show-interactive-dev-session=false"],
  { cwd: root, detached: true, env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" } });
let wrLog = "";
wr.stdout.on("data", (d) => (wrLog += d));
wr.stderr.on("data", (d) => (wrLog += d));
const W = `http://127.0.0.1:${port}`;
for (let i = 0; i < 120; i++) {
  try {
    await fetch(W + "/api/ping");
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}

const browser = await chromium.launch();
async function cleanup() {
  await browser.close().catch(() => {});
  try {
    process.kill(-wr.pid, "SIGKILL");
  } catch {}
  await mock.close();
}

try {
  // ── API ──────────────────────────────────────────────────────────────────
  {
    const big = crypto.randomBytes(3_000_000);
    const fd = new FormData();
    fd.append("content", new Blob([big], { type: "application/zip" }), "dataset.zip");
    const r = await fetch(W + "/api/pruna/files", { method: "POST", headers: { "x-pruna-key": PRUNA_KEY }, body: fd });
    ok(r.status === 200, "API: ZIP relayed to Pruna's file upload");
    const up = mock.state.log.filter((l) => l.path === "/v1/files").pop();
    ok(up && !up.chunked && up.length, "API: relayed with Content-Length, not chunked");
    const r2 = await fetch(W + "/api/pruna/train", { method: "POST", headers: { "x-pruna-key": PRUNA_KEY, "content-type": "application/json" }, body: JSON.stringify({ model: "p-video", input: { image_data: "x" } }) });
    ok(r2.status === 400, "API: only the two trainers can be started");
    const r3 = await fetch(W + "/api/pruna/output?url=" + encodeURIComponent("https://example.com/v1/predictions/delivery/a"), { headers: { "x-pruna-key": PRUNA_KEY } });
    ok(r3.status === 400, "API: downloads limited to Pruna delivery links");
    const r4 = await fetch(W + "/api/pruna/status?id=abc");
    ok(r4.status === 401, "API: calls without a key are refused");
  }

  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && pageErrors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  const q = "?poll=300";
  await page.goto(W + "/" + q);

  // ── fixtures, drawn by the browser itself ────────────────────────────────
  const fx = await page.evaluate(async () => {
    function rng(seed) {
      return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    }
    async function draw(w, h, seed, type = "image/jpeg", shift = 0) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const x = c.getContext("2d");
      const r = rng(seed);
      x.fillStyle = `hsl(${r() * 360},60%,${40 + shift}%)`;
      x.fillRect(0, 0, w, h);
      for (let i = 0; i < 14; i++) {
        x.fillStyle = `hsl(${r() * 360},70%,${30 + r() * 50 + shift}%)`;
        x.fillRect(r() * w, r() * h, r() * w * 0.6, r() * h * 0.6);
      }
      const b = await new Promise((res) => c.toBlob(res, type, 0.92));
      const bytes = new Uint8Array(await b.arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }
    const photos = [];
    for (let i = 0; i < 11; i++) photos.push(await draw(1200, 900, 100 + i * 7919));
    return {
      photos,
      small: await draw(400, 300, 5),
      dup: await draw(1200, 900, 100, "image/png"),
      before: await draw(1600, 1200, 42),
      after: await draw(1600, 1200, 42, "image/jpeg", 12),
      before2: await draw(1600, 1200, 77),
      after2square: await draw(1024, 1024, 78),
      ref: await draw(800, 800, 9),
    };
  });
  const write = (name, b64) => {
    const p = path.join(out, name);
    fs.writeFileSync(p, Buffer.from(b64, "base64"));
    return p;
  };
  const photoFiles = fx.photos.map((b, i) => write(`photo_${i}.jpg`, b));
  photoFiles.push(write("small.jpg", fx.small), write("dup.png", fx.dup));

  // ── photos: build, check, download ──────────────────────────────────────
  await page.click('.choice[data-mode="photos"]');
  await page.locator("#pick-photos").setInputFiles(photoFiles);
  await page.waitForFunction(() => document.querySelectorAll("#items .card").length === 13, null, { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector("#progress").classList.contains("hidden"));
  ok(true, "Photos: 13 photos processed into cards");
  await page.fill("#trigger", "sks_test");
  await page.check("#auto-trigger");
  const captions = page.locator("#items textarea.caption");
  await captions.nth(0).fill("a red and blue pattern");
  await captions.nth(1).fill("a red and blue pattern");
  await captions.nth(2).fill("sks_test already here");
  await page.waitForTimeout(600);
  await page.click("#dock-next");
  const checkText = await page.locator("#view-check").innerText();
  ok(/no caption and there is no default caption/i.test(checkText) === false, "Photos: trigger word counts as a caption when auto-added");
  ok(/Same caption as Photo 1/.test(checkText), "Check: repeated caption flagged");
  ok(/400×300, under Pruna's 512×512 minimum/.test(checkText), "Check: small image flagged");
  ok(/duplicate of Photo 1/.test(checkText), "Check: re-saved duplicate flagged");
  ok(/no caption of their own|no caption/i.test(checkText), "Check: missing captions listed");
  const groupThumbs = await page.locator("#item-issues .item-group-thumbs img").count();
  const groups = await page.locator("#item-issues .item-group").count();
  ok(groups > 0 && groupThumbs === groups, `Check: every flagged photo shows its thumbnail (${groupThumbs}/${groups})`);

  const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#download-zip")]);
  const zipPath = path.join(out, "photos.zip");
  await dl.saveAs(zipPath);
  ok(/No errors detected/.test(execFileSync("unzip", ["-t", zipPath]).toString()), "Download: ZIP passes unzip -t");
  const names = execFileSync("zipinfo", ["-1", zipPath]).toString().trim().split("\n");
  ok(names.length === 26 && names[0] === "image_000.jpg" && names.includes("image_012.txt"), `Download: flat image_NNN.jpg/.txt layout (${names.length} files)`);
  const cap0 = execFileSync("unzip", ["-p", zipPath, "image_000.txt"]).toString();
  const cap2 = execFileSync("unzip", ["-p", zipPath, "image_002.txt"]).toString();
  const cap5 = execFileSync("unzip", ["-p", zipPath, "image_005.txt"]).toString();
  ok(cap0 === "sks_test, a red and blue pattern", "Download: trigger word added to the start of a caption");
  ok(cap2 === "sks_test already here", "Download: trigger word not doubled");
  ok(cap5 === "sks_test", "Download: empty caption becomes the trigger word alone");
  ok(!/\//.test(names.join("")), "Download: no folders in the ZIP");
  const extracted = path.join(out, "x0.jpg");
  fs.writeFileSync(extracted, execFileSync("unzip", ["-p", zipPath, "image_000.jpg"]));
  const dims = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bin]));
    return [bmp.width, bmp.height];
  }, fs.readFileSync(extracted).toString("base64"));
  ok(dims[0] === 1024 && dims[1] === 768, `Download: 1200×900 photo stored at 1024×768 (${dims})`);

  // ── reload keeps the dataset ─────────────────────────────────────────────
  await page.reload();
  await page.waitForSelector("#resume .banner");
  ok(/Dataset in progress: 13 photos/.test(await page.locator("#resume").innerText()), "Reload: dataset restored from the phone's storage");
  await page.click("#resume .banner button");
  ok((await page.inputValue("#trigger")) === "sks_test", "Reload: trigger word restored");
  ok((await captions.nth(0).inputValue()) === "a red and blue pattern", "Reload: captions restored");

  // ── training ─────────────────────────────────────────────────────────────
  await page.click('#steps button[data-view="train"]');
  ok((await page.locator("#params").innerText()).includes("Range 100–5,000, steps of 100 · Pruna default 1,000"), "Train: steps range and default shown");
  await page.fill("#param-steps", "250");
  await page.dispatchEvent("#param-steps", "change");
  ok((await page.inputValue("#param-steps")) === "300", "Train: steps snapped to a multiple of 100");
  ok(/\$0\.54/.test(await page.locator("#cost").innerText()), "Train: cost follows steps ($1.80 per 1,000)");
  ok(await page.locator(".param.changed").count() === 1, "Train: changed setting marked, with Reset");
  await page.fill("#pruna-key", PRUNA_KEY);
  await page.check("#remember-key");
  await mock.state.jobs.clear?.();
  Object.assign(mock.state, { pollsToFinish: 6 });
  await page.click("#start-training");
  await page.waitForFunction(() => /elapsed/.test(document.querySelector("#job-status").textContent), null, { timeout: 30000 });
  const job = [...mock.state.jobs.values()].pop();
  ok(job && job.model === "p-image-trainer", "Train: p-image-trainer job submitted");
  ok(job.input.steps === 300 && job.input.training_type === "balanced" && job.input.learning_rate === 0.0001, `Train: settings sent (${JSON.stringify(job.input)})`);
  const uploaded = [...mock.state.files.values()].pop();
  ok(job.input.image_data.endsWith("/v1/files/" + uploaded.id), "Train: image_data is the uploaded file's URL");
  const upZip = path.join(out, "uploaded.zip");
  fs.writeFileSync(upZip, uploaded.bytes);
  ok(execFileSync("zipinfo", ["-1", upZip]).toString().trim().split("\n").join() === names.join(), "Train: the uploaded ZIP has the same files as the download");

  // Reload while training: the job must be offered back and resumed.
  await page.reload();
  await page.waitForSelector("#resume .banner");
  ok(/may still be running/.test(await page.locator("#resume").innerText()), "Resume: running job offered after reload");
  await page.click("#resume .banner button");
  await page.waitForSelector("#result:not(.hidden)", { timeout: 30000 });
  ok(/lora\.safetensors/.test(await page.locator("#result-detail").innerText()), "Resume: job collected, weights found in the output ZIP");
  const [dl2] = await Promise.all([page.waitForEvent("download"), page.click("#save-lora")]);
  const loraPath = path.join(out, "lora.zip");
  await dl2.saveAs(loraPath);
  ok(fs.readFileSync(loraPath).equals(fs.readFileSync(path.join(root, "test/fixtures/lora_output.zip"))), "Result: saved LoRA ZIP is byte-identical to Pruna's output");

  // ── Hugging Face ────────────────────────────────────────────────────────
  await page.fill("#hf-token", HF_TOKEN);
  await page.dispatchEvent("#hf-token", "change");
  await page.waitForFunction(() => /Signed in as tester/.test(document.querySelector("#hf-who").textContent));
  ok((await page.inputValue("#hf-repo")) === "p-image-lora-sks_test", "HF: repository name suggested from the trigger word");
  await page.click("#hf-upload");
  await page.waitForSelector("#hf-result:not(.hidden)", { timeout: 30000 });
  ok((await page.locator("#hf-weights").innerText()) === "huggingface.co/tester/p-image-lora-sks_test/weights.safetensors", "HF: lora_weights value shown");
  const commit = mock.state.commits.pop();
  const expected = crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex");
  ok(commit && commit.lfsFile.path === "weights.safetensors" && commit.lfsFile.size === 300000 && commit.lfsFile.oid !== expected, "HF: weights committed with their SHA-256 and size");

  // Done with this run: both confirmations accepted → LoRA and dataset gone, home screen.
  await page.click("#finish-run");
  await page.waitForSelector("#view-start:not(.hidden)");
  ok((await page.locator("#resume").innerText()).trim() === "", "Done with this run: LoRA and dataset removed, back on the home screen");
  await page.reload();
  await page.waitForSelector("#view-start:not(.hidden)");
  await page.waitForTimeout(300);
  ok((await page.locator("#resume .banner").count()) === 0, "Done with this run: nothing comes back after a reload");

  // ── pairs ────────────────────────────────────────────────────────────────
  await page.goto(W + "/" + q);
  await page.click('.choice[data-mode="pairs"]');
  const pickVia = async (clickSel, file) => {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click(clickSel)]);
    await chooser.setFiles(file);
  };
  await pickVia("#add-pair", write("b1.jpg", fx.before));
  await page.waitForSelector("#items .card");
  await pickVia("#items .card:nth-child(1) .slot:nth-child(2) .slot-btn", write("a1.jpg", fx.after));
  await page.waitForFunction(() => document.querySelectorAll("#items .card:nth-child(1) .slot img").length === 2);
  await pickVia("#add-pair", write("b2.jpg", fx.before2));
  await page.waitForFunction(() => document.querySelectorAll("#items .card").length === 2);
  await pickVia("#items .card:nth-child(2) .slot:nth-child(2) .slot-btn", write("a2.jpg", fx.after2square));
  await page.waitForFunction(() => document.querySelectorAll("#items .card:nth-child(2) .slot img").length === 2);
  await pickVia("#items .card:nth-child(1) .add-ref", write("ref.jpg", fx.ref));
  await page.waitForSelector("#items .card:nth-child(1) .ref img");
  await pickVia("#add-pair", write("b3.jpg", fx.before));
  await page.waitForFunction(() => document.querySelectorAll("#items .card").length === 3);
  await page.locator("#items .card:nth-child(1) textarea").fill("make it brighter");
  await page.waitForTimeout(500);
  const card2 = await page.locator("#items .card:nth-child(2)").innerText();
  ok(/cropped at its center/.test(card2), "Pairs: different shapes cropped and flagged");
  ok(/Before · 1024×1024/.test(card2) && /After · 1024×1024/.test(card2), "Pairs: both sides end up the same size");
  ok(/Missing the after image/.test(await page.locator("#items .card:nth-child(3)").innerText()), "Pairs: incomplete pair flagged");
  await page.click('#items .card:nth-child(2) .crop-choice button:has-text("After")');
  await page.waitForFunction(() => /After · 1024×768/.test(document.querySelector("#items .card:nth-child(2)").innerText));
  const card2b = await page.locator("#items .card:nth-child(2)").innerText();
  ok(/Before · 1024×768/.test(card2b) && /the after was cropped/.test(card2b), "Pairs: choosing to crop the after re-crops from the originals (1024×768)");
  await page.click('#items .card:nth-child(2) .crop-choice button:has-text("Before")');
  await page.waitForFunction(() => /After · 1024×1024/.test(document.querySelector("#items .card:nth-child(2)").innerText));
  ok(true, "Pairs: switching back to cropping the before restores 1024×1024");
  await page.click("#items .card:nth-child(2) .card-head button:not(.danger)");
  ok(await page.locator("#flip[open]").count() === 1, "Pairs: Flip compare opens");
  const flipBefore = await page.locator("#flip-label").innerText();
  await page.click("#flip-stage");
  ok(flipBefore === "Before" && (await page.locator("#flip-label").innerText()) === "After", "Pairs: Flip switches before/after");
  await page.click("#flip .flip-head button");
  await page.click("#dock-next");
  const [dl3] = await Promise.all([page.waitForEvent("download"), page.click("#download-zip")]);
  const pairsZip = path.join(out, "pairs.zip");
  await dl3.saveAs(pairsZip);
  const pnames = execFileSync("zipinfo", ["-1", pairsZip]).toString().trim().split("\n");
  await page.goto(W + "/" + q);
  await page.waitForSelector("#resume .banner");
  ok(/Dataset in progress: 3 pairs/.test(await page.locator("#resume").innerText()), "Home: dataset banner shows Continue and Delete");
  await page.click('#resume .banner button:has-text("Delete")');
  await page.waitForFunction(() => !document.querySelector("#resume .banner"));
  await page.reload();
  await page.waitForSelector("#view-start:not(.hidden)");
  await page.waitForTimeout(300);
  ok((await page.locator("#resume .banner").count()) === 0, "Home: Delete removes the dataset for good");
  ok(pnames.join() === "pair_000_start.jpg,pair_000_start2.jpg,pair_000_end.jpg,pair_000.txt,pair_001_start.jpg,pair_001_end.jpg", `Pairs ZIP: _start/_start2/_end naming, incomplete pair left out (${pnames.join(" ")})`);

  // ── opening an existing ZIP ─────────────────────────────────────────────
  const imp = path.join(out, "import.zip");
  execFileSync("python3", ["-c", `
import zipfile
b = open(${JSON.stringify(path.join(out, "b1.jpg"))}, "rb").read()
a = open(${JSON.stringify(path.join(out, "a1.jpg"))}, "rb").read()
with zipfile.ZipFile(${JSON.stringify(imp)}, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("my set/room_01_input.jpg", b)
    z.writestr("my set/room_01_target.jpg", a)
    z.writestr("my set/room_01_mask.png", a)
    z.writestr("my set/room_01.txt", "replace the sofa")
    z.writestr("__MACOSX/my set/._room_01_input.jpg", b"junk")
`]);
  await page.goto(W + "/" + q);
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.click("#open-zip")]);
  await chooser.setFiles(imp);
  await page.waitForSelector("#notice:not(.hidden)", { timeout: 30000 });
  const notice = await page.locator("#notice").innerText();
  ok(/Opened import\.zip: 1 pairs/.test(notice) && /room_01_mask\.png: mask \(left out\)/.test(notice), "Open ZIP: _input/_target read as a pair, mask left out");
  ok((await page.locator("#items textarea").inputValue()) === "replace the sofa", "Open ZIP: caption carried over");
  ok(await page.locator("#items .card .slot img").count() === 2, "Open ZIP: both images processed");

  ok(pageErrors.length === 0, "No script errors in the page" + (pageErrors.length ? ": " + pageErrors.join(" | ") : ""));
} catch (err) {
  failures++;
  console.log("FAIL (exception) " + (err && err.stack || err));
  console.log(wrLog.slice(-2000));
} finally {
  await cleanup();
}
console.log(failures ? `\n${failures} failure(s)` : "\nAll end-to-end checks passed.");
process.exit(failures ? 1 : 0);
