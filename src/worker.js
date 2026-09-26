// API for the LoRA Dataset Builder. The app's pages are static assets; only
// /api/* reaches this file.
//
// Pruna's API answers browser (CORS) requests from its own docs site only, so
// the browser cannot call it directly: every Pruna call is relayed here with
// the key the visitor typed, carried in the x-pruna-key request header and
// never stored. Hugging Face uploads are relayed the same way with
// x-hf-token. No CORS headers are sent, so only this app's own pages can use
// these routes from a browser.

const PRUNA_DEFAULT = "https://api.pruna.ai";
const HF_DEFAULT = "https://huggingface.co";

// Pruna's /v1/files rejects anything over 100 MB (FILE_TOO_LARGE in its
// OpenAPI spec), and Cloudflare refuses request bodies over 100 MB on the
// Free and Pro plans before this code runs.
const MAX_UPLOAD_BYTES = 100 * 1000 * 1000;

const TRAINERS = new Set(["p-image-trainer", "p-image-edit-trainer"]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/pruna/files" && request.method === "POST") return await prunaFiles(request, env);
      if (path === "/api/pruna/train" && request.method === "POST") return await prunaTrain(request, env);
      if (path === "/api/pruna/status" && request.method === "GET") return await prunaStatus(request, env, url);
      if (path === "/api/pruna/output" && request.method === "GET") return await prunaOutput(request, env, url);
      if (path === "/api/hf/whoami" && request.method === "GET") return await hfWhoami(request, env);
      if (path === "/api/hf/upload" && request.method === "POST") return await hfUpload(request, env, url);
      if (path.startsWith("/api/")) return json({ error: "Not found." }, 404);
      return new Response("Not found.", { status: 404 });
    } catch (err) {
      // Answering before an upload has been read drops the connection, and
      // the browser then sees a network failure instead of this message.
      if (request.body && !request.body.locked) await request.body.pipeTo(new WritableStream()).catch(() => {});
      return json({ error: err instanceof HttpError ? err.message : `Unexpected error: ${err.message}` }, err.status || 502);
    }
  },
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function prunaBase(env) {
  return (env.PRUNA_BASE || PRUNA_DEFAULT).replace(/\/+$/, "");
}

function hfBase(env) {
  return (env.HF_BASE || HF_DEFAULT).replace(/\/+$/, "");
}

function prunaKey(request) {
  const key = (request.headers.get("x-pruna-key") || "").trim();
  if (!key) throw new HttpError("Enter your Pruna API key first.", 401);
  return key;
}

function hfToken(request) {
  const token = (request.headers.get("x-hf-token") || "").trim();
  if (!token) throw new HttpError("Enter your Hugging Face token first.", 401);
  return token;
}

// Relays an upstream answer's body and status so the app can show the
// provider's own error text. Always labelled JSON (these endpoints answer in
// JSON), so nothing upstream can be served from this site as a page.
async function relay(res) {
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function declaredLength(request) {
  const raw = request.headers.get("content-length");
  const len = raw === null ? NaN : Number(raw);
  if (!Number.isSafeInteger(len) || len <= 0) throw new HttpError("The upload has no length.", 411);
  if (len > MAX_UPLOAD_BYTES) throw new HttpError("The upload is over 100 MB, which Pruna refuses.", 413);
  return len;
}

// A body forwarded as a plain stream goes out with chunked encoding; a
// FixedLengthStream keeps Content-Length, which S3-style upload URLs require,
// without holding the file in the Worker's 128 MB of memory.
function fixedLength(stream, length) {
  const { readable, writable } = new FixedLengthStream(length);
  stream.pipeTo(writable).catch(() => {});
  return readable;
}

async function prunaFiles(request, env) {
  const key = prunaKey(request);
  const len = declaredLength(request);
  const type = request.headers.get("content-type") || "";
  if (!type.startsWith("multipart/form-data")) throw new HttpError("Expected multipart form data.", 400);

  const res = await fetch(`${prunaBase(env)}/v1/files`, {
    method: "POST",
    headers: { apikey: key, "content-type": type },
    body: fixedLength(request.body, len),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) return relay(new Response(text, { status: res.status }));
  const fileUrl = data?.urls?.get || data?.url || null;
  if (!fileUrl) throw new HttpError("Pruna accepted the upload but returned no file URL.", 502);
  return json({ id: data?.id || null, url: fileUrl, expires_at: data?.expires_at || null });
}

async function prunaTrain(request, env) {
  const key = prunaKey(request);
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") throw new HttpError("Expected a JSON body.", 400);
  if (!TRAINERS.has(body.model)) throw new HttpError("Only the two Pruna trainers can be started here.", 400);
  if (!body.input || typeof body.input !== "object" || typeof body.input.image_data !== "string") {
    throw new HttpError("The training request has no image_data.", 400);
  }
  const res = await fetch(`${prunaBase(env)}/v1/predictions`, {
    method: "POST",
    headers: { apikey: key, Model: body.model, "content-type": "application/json" },
    body: JSON.stringify({ input: body.input }),
  });
  return relay(res);
}

async function prunaStatus(request, env, url) {
  const key = prunaKey(request);
  const id = url.searchParams.get("id") || "";
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(id)) throw new HttpError("Invalid job id.", 400);
  const res = await fetch(`${prunaBase(env)}/v1/predictions/status/${encodeURIComponent(id)}`, {
    headers: { apikey: key },
  });
  return relay(res);
}

// The trained weights come from a delivery URL that needs the key. Only
// Pruna delivery URLs are fetched, so this cannot be pointed elsewhere.
function isDeliveryUrl(target, env) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  if (!u.pathname.startsWith("/v1/predictions/delivery/")) return false;
  if (u.origin === new URL(prunaBase(env)).origin) return true;
  return u.protocol === "https:" && (u.hostname === "pruna.ai" || u.hostname.endsWith(".pruna.ai"));
}

async function prunaOutput(request, env, url) {
  const key = prunaKey(request);
  const target = url.searchParams.get("url") || "";
  if (!isDeliveryUrl(target, env)) throw new HttpError("Only Pruna delivery links can be downloaded here.", 400);
  const res = await fetch(target, { headers: { apikey: key } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const expired = res.status === 404 || res.status === 410 || res.status === 403;
    throw new HttpError(
      expired
        ? `Pruna no longer has this result (HTTP ${res.status}). Its link expires about 30 minutes after training ends.`
        : `Pruna refused the download (HTTP ${res.status}). ${text.slice(0, 300)}`,
      res.status
    );
  }
  const headers = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
  for (const h of ["content-type", "content-length", "content-disposition"]) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: 200, headers });
}

// ── Hugging Face ────────────────────────────────────────────────────────────
// Endpoints per the Hub's OpenAPI spec (/.well-known/openapi.json); the
// large-file sequence (LFS batch → PUT → verify → commit) follows
// huggingface_hub's lfs.py, which Hugging Face documents as still working for
// repositories stored on its newer Xet backend.

const LFS_HEADERS = {
  accept: "application/vnd.git-lfs+json",
  "content-type": "application/vnd.git-lfs+json",
};

async function hfFail(res, what) {
  const text = await res.text().catch(() => "");
  let msg = text;
  try {
    const data = JSON.parse(text);
    msg = data.error || data.message || text;
  } catch {}
  const hint = res.status === 401 || res.status === 403 ? " Check that the token is a Write token." : "";
  return new HttpError(`Hugging Face refused ${what} (HTTP ${res.status}): ${String(msg).slice(0, 300)}${hint}`, res.status === 401 || res.status === 403 ? res.status : 502);
}

async function whoami(env, token) {
  const res = await fetch(`${hfBase(env)}/api/whoami-v2`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw await hfFail(res, "the token");
  const data = await res.json();
  return {
    name: data.name,
    orgs: Array.isArray(data.orgs) ? data.orgs.map((o) => o.name).filter(Boolean) : [],
    role: data.auth?.accessToken?.role || null,
  };
}

async function hfWhoami(request, env) {
  return json(await whoami(env, hfToken(request)));
}

const REPO_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

// Reads exactly `length` bytes from a shared reader into a fixed-length
// stream, so a multi-part upload can hand each part its own slice of one
// incoming body.
function slice(reader, carry, length) {
  const { readable, writable } = new FixedLengthStream(length);
  const writer = writable.getWriter();
  const done = (async () => {
    let left = length;
    while (left > 0) {
      let chunk = carry.bytes;
      carry.bytes = null;
      if (!chunk) {
        const r = await reader.read();
        if (r.done) throw new Error("The upload ended early.");
        chunk = r.value;
      }
      if (chunk.byteLength > left) {
        carry.bytes = chunk.subarray(left);
        chunk = chunk.subarray(0, left);
      }
      await writer.write(chunk);
      left -= chunk.byteLength;
    }
    await writer.close();
  })();
  done.catch((err) => writer.abort(err).catch(() => {}));
  return { readable, done };
}

async function hfUpload(request, env, url) {
  const token = hfToken(request);
  const len = declaredLength(request);
  const oid = (request.headers.get("x-sha256") || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(oid)) throw new HttpError("Missing the file's SHA-256.", 400);
  const [owner, name] = (url.searchParams.get("repo") || "").split("/");
  if (!REPO_PART.test(owner || "") || !REPO_PART.test(name || "")) {
    throw new HttpError("Repository must look like owner/name (letters, digits, . _ -).", 400);
  }
  const filePath = url.searchParams.get("path") || "weights.safetensors";
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(filePath)) throw new HttpError("Invalid file name.", 400);
  const isPrivate = url.searchParams.get("private") === "1";
  const base = hfBase(env);
  const auth = { authorization: `Bearer ${token}` };

  const me = await whoami(env, token);
  const create = await fetch(`${base}/api/repos/create`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      type: "model",
      name,
      ...(owner !== me.name ? { organization: owner } : {}),
      private: isPrivate,
    }),
  });
  // 409 is "already exists", which is fine: the weights go into it.
  if (!create.ok && create.status !== 409) throw await hfFail(create, "creating the repository");
  const created = create.ok;
  await create.body?.cancel();

  const batch = await fetch(`${base}/${owner}/${name}.git/info/lfs/objects/batch`, {
    method: "POST",
    headers: { ...LFS_HEADERS, ...auth },
    body: JSON.stringify({
      operation: "upload",
      transfers: ["basic", "multipart"],
      objects: [{ oid, size: len }],
      hash_algo: "sha256",
    }),
  });
  if (!batch.ok) throw await hfFail(batch, "the upload request");
  const info = await batch.json();
  const obj = Array.isArray(info.objects) ? info.objects[0] : null;
  if (!obj) throw new HttpError("Hugging Face returned no upload instructions.", 502);
  if (obj.error) throw new HttpError(`Hugging Face refused the file: ${obj.error.message || JSON.stringify(obj.error)}`, 502);

  const upload = obj.actions?.upload;
  if (!upload) {
    // Already stored under this hash, so the bytes are not needed; they are
    // still read, because cancelling a body mid-upload drops the connection.
    await request.body.pipeTo(new WritableStream());
  } else {
    const header = upload.header || {};
    const chunkSize = header.chunk_size !== undefined ? Number(header.chunk_size) : null;
    if (chunkSize) {
      const partUrls = Object.keys(header)
        .filter((k) => /^\d+$/.test(k))
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => header[k]);
      if (partUrls.length !== Math.ceil(len / chunkSize)) throw new HttpError("Hugging Face sent an unexpected part list.", 502);
      const reader = request.body.getReader();
      const carry = { bytes: null };
      const parts = [];
      for (let i = 0; i < partUrls.length; i++) {
        const partLen = Math.min(chunkSize, len - i * chunkSize);
        const { readable, done } = slice(reader, carry, partLen);
        const res = await fetch(partUrls[i], { method: "PUT", body: readable });
        if (!res.ok) {
          await reader.cancel().catch(() => {});
          throw await hfFail(res, `part ${i + 1} of the upload`);
        }
        await done;
        const etag = res.headers.get("etag");
        if (!etag) throw new HttpError(`Part ${i + 1} came back without an ETag.`, 502);
        parts.push({ partNumber: i + 1, etag });
        await res.body?.cancel();
      }
      const complete = await fetch(upload.href, {
        method: "POST",
        headers: LFS_HEADERS,
        body: JSON.stringify({ oid, parts }),
      });
      if (!complete.ok) throw await hfFail(complete, "finishing the upload");
      await complete.body?.cancel();
    } else {
      const put = await fetch(upload.href, { method: "PUT", body: fixedLength(request.body, len) });
      if (!put.ok) throw await hfFail(put, "the file upload");
      await put.body?.cancel();
    }
    const verify = obj.actions?.verify;
    if (verify?.href) {
      const v = await fetch(verify.href, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ oid, size: len }),
      });
      if (!v.ok) throw await hfFail(v, "the upload check");
      await v.body?.cancel();
    }
  }

  const ndjson =
    JSON.stringify({ key: "header", value: { summary: `Upload ${filePath}`, description: "Uploaded by LoRA Dataset Builder." } }) +
    "\n" +
    JSON.stringify({ key: "lfsFile", value: { path: filePath, algo: "sha256", oid, size: len } }) +
    "\n";
  const commit = await fetch(`${base}/api/models/${owner}/${name}/commit/main`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-ndjson" },
    body: ndjson,
  });
  if (!commit.ok) throw await hfFail(commit, "the commit");
  const result = await commit.json().catch(() => ({}));
  return json({
    repo: `${owner}/${name}`,
    path: filePath,
    created,
    private: isPrivate,
    commitUrl: result.commitUrl || null,
    lora_weights: `huggingface.co/${owner}/${name}/${filePath}`,
  });
}
