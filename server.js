/**
 * FBR Digital Invoicing middleware.
 * Contract: POST /api/submit with Authorization: Bearer <MIDDLEWARE_API_KEY>, body: { payload }.
 * Calls FBR validate then post; returns { ok, invoiceNumber, dated, validationResponse } or { ok: false, error, ... }.
 */

require("dotenv").config();

const express = require("express");

const MIDDLEWARE_API_KEY = process.env.MIDDLEWARE_API_KEY;
const PORT = process.env.PORT || 3001;

const VALIDATE_SB = "/di_data/v1/di/validateinvoicedata_sb";
const VALIDATE_PROD = "/di_data/v1/di/validateinvoicedata";
const POST_SB = "/di_data/v1/di/postinvoicedata_sb";
const POST_PROD = "/di_data/v1/di/postinvoicedata";

const app = express();
app.use(express.json({ limit: "1mb" }));

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ ok: false, error: "Missing or invalid Authorization header" });
  }
  const key = header.slice(7);
  if (!MIDDLEWARE_API_KEY || key !== MIDDLEWARE_API_KEY) {
    return res.status(403).json({ ok: false, error: "Invalid API key" });
  }
  next();
}

async function callFbr(baseUrl, bearerToken, path, payload) {
  const base = (baseUrl || "").replace(/\/$/, "");
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(payload),
  });
  return res.json().catch(() => ({}));
}

app.post("/api/submit", auth, async (req, res) => {
  const payload = req.body?.payload;
  const fbrBearerToken = (req.body?.fbrBearerToken && String(req.body.fbrBearerToken).trim()) || null;
  const fbrBaseUrl = (req.body?.fbrBaseUrl && String(req.body.fbrBaseUrl).trim()) || null;

  if (!payload || !payload.items || !Array.isArray(payload.items)) {
    return res.status(400).json({ ok: false, error: "Body must be { payload: <FBR DI request> }" });
  }
  if (!fbrBearerToken || !fbrBaseUrl) {
    return res.status(400).json({
      ok: false,
      error: "Body must include fbrBearerToken and fbrBaseUrl (per-company credentials from invoicing app).",
    });
  }

  const isSandbox = payload.scenarioId != null;
  const validatePath = isSandbox ? VALIDATE_SB : VALIDATE_PROD;
  const postPath = isSandbox ? POST_SB : POST_PROD;

  const validateData = await callFbr(fbrBaseUrl, fbrBearerToken, validatePath, payload);
  const vr = validateData.validationResponse;
  if (vr && vr.statusCode !== "00") {
    return res.status(400).json({
      ok: false,
      error: vr.error || "Validation failed",
      statusCode: vr.statusCode,
      validationResponse: vr,
    });
  }

  const postData = await callFbr(fbrBaseUrl, fbrBearerToken, postPath, payload);
  const postVr = postData.validationResponse;
  if (postVr && postVr.statusCode !== "00") {
    return res.status(400).json({
      ok: false,
      error: postVr.error || postData.error || "Post failed",
      statusCode: postVr.statusCode,
      validationResponse: postVr,
    });
  }

  res.status(200).json({
    ok: true,
    invoiceNumber: postData.invoiceNumber || "",
    dated: postData.dated,
    validationResponse: postVr || { statusCode: "00", status: "Valid", error: "" },
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    middlewareKeySet: !!MIDDLEWARE_API_KEY,
  });
});

app.listen(PORT, () => {
  console.log(`FBR middleware listening on port ${PORT}`);
  if (!MIDDLEWARE_API_KEY) {
    console.warn("WARN: MIDDLEWARE_API_KEY not set; all requests will be rejected.");
  }
});
