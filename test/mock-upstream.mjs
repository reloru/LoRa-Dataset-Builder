// Stand-in for Pruna, Hugging Face and the storage Hugging Face hands uploads
// to, so the Worker and the app can be exercised end to end without keys or
// charges. Each route checks what the real service documents (auth headers,
// the Model header, SHA-256 of large files) and, like S3, refuses a PUT sent
// without Content-Length.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

export const PRUNA_KEY = "test-pruna-key";
export const HF_TOKEN = "test-hf-token";
const LORA_ZIP = fs.readFileSync(new URL("./fixtures/lora_output.zip", import.meta.url));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  res.writeHead(status, { "content-length": buf.length, "content-type": "application/json", ...headers });
  res.end(buf);
}

function multipartFile(body, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType || "");
  if (!m) return null;
  const boundary = Buffer.from("--" + (m[1] || m[2]));
  const start = body.indexOf(boundary);
  const headEnd = body.indexOf("\r\n\r\n", start);
  const head = body.slice(start, headEnd).toString();
  const end = body.indexOf(Buffer.concat([Buffer.from("\r\n"), boundary]), headEnd);
  const name = /name="([^"]+)"/.exec(head)?.[1];
  const filename = /filename="([^"]*)"/.exec(head)?.[1];
  return { name, filename, bytes: body.slice(headEnd + 4, end) };
}

export async function startMock(port = 0) {
  const state = {
    log: [],
    files: new Map(),
    jobs: new Map(),
    lfs: new Map(),
    parts: new Map(),
    repos: new Set(),
    commits: [],
    lfsMode: "basic",
    pollsToFinish: 2,
    failNextTraining: null,
  };
  let base = "";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const p = url.pathname;
    const chunked = (req.headers["transfer-encoding"] || "").includes("chunked");
    state.log.push({ method: req.method, path: p, chunked, length: req.headers["content-length"] || null });
    try {
      // ── test controls ──
      if (p === "/__state") return send(res, 200, {
        log: state.log,
        files: [...state.files.values()].map((f) => ({ id: f.id, name: f.name, size: f.bytes.length, filename: f.filename })),
        jobs: [...state.jobs.values()].map((j) => ({ id: j.id, model: j.model, input: j.input, polls: j.polls })),
        commits: state.commits,
        lfs: [...state.lfs.keys()],
      });
      if (p === "/__config" && req.method === "POST") {
        Object.assign(state, JSON.parse((await readBody(req)).toString()));
        return send(res, 200, { ok: true });
      }
      if (p.startsWith("/__file/")) {
        const f = state.files.get(p.slice(8));
        return f ? send(res, 200, f.bytes, { "content-type": "application/octet-stream" }) : send(res, 404, {});
      }

      // ── Pruna ──
      if (p === "/v1/files" && req.method === "POST") {
        if (req.headers.apikey !== PRUNA_KEY) return send(res, 401, { error: { code: "UNAUTHORIZED", message: "Invalid API key" } });
        if (chunked || !req.headers["content-length"]) return send(res, 411, { error: "Content-Length required" });
        const body = await readBody(req);
        const part = multipartFile(body, req.headers["content-type"]);
        if (!part || part.name !== "content") return send(res, 400, { error: { code: "INVALID_FILE", message: "missing content" } });
        const id = crypto.randomBytes(5).toString("hex");
        state.files.set(id, { id, name: part.name, filename: part.filename, bytes: part.bytes });
        return send(res, 201, { id, name: part.filename, size: part.bytes.length, urls: { get: `${base}/v1/files/${id}` }, expires_at: new Date(Date.now() + 1800e3).toISOString() });
      }
      if (p === "/v1/predictions" && req.method === "POST") {
        if (req.headers.apikey !== PRUNA_KEY) return send(res, 401, { error: { code: "UNAUTHORIZED", message: "Invalid API key" } });
        const model = req.headers.model;
        const body = JSON.parse((await readBody(req)).toString());
        const id = "job" + crypto.randomBytes(4).toString("hex");
        const fail = state.failNextTraining;
        state.failNextTraining = null;
        state.jobs.set(id, { id, model, input: body.input, polls: 0, fail });
        return send(res, 201, { id, model, input: body.input, get_url: `${base}/v1/predictions/status/${id}` });
      }
      if (p.startsWith("/v1/predictions/status/")) {
        if (req.headers.apikey !== PRUNA_KEY) return send(res, 401, { error: { code: "UNAUTHORIZED", message: "Invalid API key" } });
        const job = state.jobs.get(p.split("/").pop());
        if (!job) return send(res, 404, { error: "not found" });
        job.polls++;
        if (job.polls < state.pollsToFinish) return send(res, 200, { status: job.polls === 1 ? "starting" : "processing", message: "Generation in progress" });
        if (job.fail) return send(res, 200, { message: "Training failed", error: job.fail });
        return send(res, 200, { status: "succeeded", generation_url: `${base}/v1/predictions/delivery/xezq/${job.id}/lora_weights.zip` });
      }
      if (p.startsWith("/v1/predictions/delivery/")) {
        if (req.headers.apikey !== PRUNA_KEY) return send(res, 401, { error: "Invalid API key" });
        return send(res, 200, LORA_ZIP, { "content-type": "application/zip" });
      }

      // ── Hugging Face ──
      const auth = req.headers.authorization;
      if (p === "/api/whoami-v2") {
        if (auth !== `Bearer ${HF_TOKEN}`) return send(res, 401, { error: "Invalid credentials in Authorization header" });
        return send(res, 200, { name: "tester", orgs: [{ name: "test-org" }], auth: { accessToken: { role: "write" } } });
      }
      if (p === "/api/repos/create" && req.method === "POST") {
        if (auth !== `Bearer ${HF_TOKEN}`) return send(res, 401, { error: "Invalid credentials" });
        const b = JSON.parse((await readBody(req)).toString());
        const id = `${b.organization || "tester"}/${b.name}`;
        if (b.type !== "model") return send(res, 400, { error: "type must be model" });
        if (state.repos.has(id)) return send(res, 409, { error: "You already created this model repo", url: `${base}/${id}` });
        state.repos.add(id);
        return send(res, 200, { url: `${base}/${id}`, private: b.private });
      }
      let m = /^\/([^/]+)\/([^/]+)\.git\/info\/lfs\/objects\/batch$/.exec(p);
      if (m && req.method === "POST") {
        if (auth !== `Bearer ${HF_TOKEN}`) return send(res, 401, { message: "Unauthorized" });
        if (req.headers.accept !== "application/vnd.git-lfs+json") return send(res, 406, { message: "bad accept" });
        const b = JSON.parse((await readBody(req)).toString());
        const o = b.objects[0];
        if (state.lfs.has(o.oid)) return send(res, 200, { transfer: "basic", objects: [{ oid: o.oid, size: o.size }] });
        const verify = { href: `${base}/lfs/verify` };
        if (state.lfsMode === "multipart") {
          const chunk = 100000;
          const header = { chunk_size: String(chunk) };
          for (let i = 1; i <= Math.ceil(o.size / chunk); i++) header[String(i)] = `${base}/s3/part/${o.oid}/${i}`;
          return send(res, 200, { transfer: "multipart", objects: [{ oid: o.oid, size: o.size, actions: { upload: { href: `${base}/lfs/complete/${o.oid}`, header }, verify } }] });
        }
        return send(res, 200, { transfer: "basic", objects: [{ oid: o.oid, size: o.size, actions: { upload: { href: `${base}/s3/put/${o.oid}` }, verify } }] });
      }
      m = /^\/s3\/put\/([0-9a-f]{64})$/.exec(p);
      if (m && req.method === "PUT") {
        if (chunked || !req.headers["content-length"]) return send(res, 411, "<Error><Code>MissingContentLength</Code></Error>");
        const body = await readBody(req);
        const sha = crypto.createHash("sha256").update(body).digest("hex");
        if (sha !== m[1]) return send(res, 400, "<Error><Code>BadDigest</Code></Error>");
        state.lfs.set(sha, body);
        return send(res, 200, "", { etag: '"x"' });
      }
      m = /^\/s3\/part\/([0-9a-f]{64})\/(\d+)$/.exec(p);
      if (m && req.method === "PUT") {
        if (chunked || !req.headers["content-length"]) return send(res, 411, "<Error><Code>MissingContentLength</Code></Error>");
        const body = await readBody(req);
        const key = m[1];
        if (!state.parts.has(key)) state.parts.set(key, []);
        state.parts.get(key)[Number(m[2]) - 1] = body;
        return send(res, 200, "", { etag: `"part-${m[2]}"` });
      }
      m = /^\/lfs\/complete\/([0-9a-f]{64})$/.exec(p);
      if (m && req.method === "POST") {
        const b = JSON.parse((await readBody(req)).toString());
        const parts = state.parts.get(m[1]) || [];
        if (b.oid !== m[1] || b.parts.length !== parts.length || b.parts.some((x, i) => x.etag !== `"part-${i + 1}"` || x.partNumber !== i + 1)) {
          return send(res, 400, { message: "bad completion" });
        }
        const all = Buffer.concat(parts);
        if (crypto.createHash("sha256").update(all).digest("hex") !== m[1]) return send(res, 400, { message: "hash mismatch" });
        state.lfs.set(m[1], all);
        return send(res, 200, {});
      }
      if (p === "/lfs/verify" && req.method === "POST") {
        if (auth !== `Bearer ${HF_TOKEN}`) return send(res, 401, { message: "Unauthorized" });
        const b = JSON.parse((await readBody(req)).toString());
        return state.lfs.has(b.oid) && state.lfs.get(b.oid).length === b.size ? send(res, 200, {}) : send(res, 404, { message: "not uploaded" });
      }
      m = /^\/api\/models\/([^/]+)\/([^/]+)\/commit\/main$/.exec(p);
      if (m && req.method === "POST") {
        if (auth !== `Bearer ${HF_TOKEN}`) return send(res, 401, { error: "Unauthorized" });
        if (!(req.headers["content-type"] || "").startsWith("application/x-ndjson")) return send(res, 400, { error: "expected ndjson" });
        const lines = (await readBody(req)).toString().trim().split("\n").map((l) => JSON.parse(l));
        const lfsFile = lines.find((l) => l.key === "lfsFile")?.value;
        if (lines[0]?.key !== "header" || !lfsFile || !state.lfs.has(lfsFile.oid)) return send(res, 400, { error: "bad commit" });
        state.commits.push({ repo: `${m[1]}/${m[2]}`, header: lines[0].value, lfsFile });
        return send(res, 200, { commitUrl: `${base}/${m[1]}/${m[2]}/commit/abc123`, commitOid: "abc123" });
      }
      send(res, 404, { error: `mock: no route for ${req.method} ${p}` });
    } catch (err) {
      send(res, 500, { error: String(err && err.stack || err) });
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  return { base, state, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMock(Number(process.argv[2] || 0));
  console.log(m.base);
}
