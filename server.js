/**
 * FBR Digital Invoicing middleware.
 * Contract: POST /api/submit with Authorization: Bearer <MIDDLEWARE_API_KEY>,
 * body: { payload, fbrBearerToken, fbrBaseUrl [, fbrValidateBaseUrl, fbrValidateToken ] }.
 * - fbrValidateBaseUrl + fbrValidateToken: optional; when provided in sandbox (payload.scenarioId set),
 *   validate call uses this URL/token (e.g. validateinvoicedata sandbox URL). Post always uses fbrBaseUrl/fbrBearerToken.
 * Calls FBR validate then post; returns normalized fields plus full FBR responses:
 * - Success: { ok: true, invoiceNumber, dated, validationResponse, fbrValidateResponse, fbrPostResponse }
 * - Error: { ok: false, error, statusCode?, validationResponse?, fbrValidateResponse?, fbrPostResponse? }
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

async function callFbr(baseUrl, bearerToken, path, payload, logLabel = "FBR") {
  const base = (baseUrl || "").replace(/\/$/, "");
  // If base URL is already a full endpoint (ends with this path), use as-is to avoid duplicating path
  const pathNoLeading = path.replace(/^\//, "");
  const isFullUrl = pathNoLeading && (base.endsWith(pathNoLeading) || base === pathNoLeading);
  const url = isFullUrl ? base : `${base}${path}`;
  console.log(`[FBR middleware] ${logLabel} request URL: ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(payload),
  });
  const status = res.status;
  const body = await res.json().catch(() => ({}));
  console.log(`[FBR middleware] ${logLabel} response status: ${status}, body keys: ${Object.keys(body || {}).join(", ") || "(empty)"}`);
  return { status, body };
}

app.post("/api/submit", auth, async (req, res) => {
  console.log("[FBR middleware] ----- POST /api/submit received -----");
  const payload = req.body?.payload;
  const fbrBearerToken = (req.body?.fbrBearerToken && String(req.body.fbrBearerToken).trim()) || null;
  const fbrBaseUrl = (req.body?.fbrBaseUrl && String(req.body.fbrBaseUrl).trim()) || null;
  const fbrValidateBaseUrl = (req.body?.fbrValidateBaseUrl && String(req.body.fbrValidateBaseUrl).trim()) || null;
  const fbrValidateToken = (req.body?.fbrValidateToken && String(req.body.fbrValidateToken).trim()) || null;

  if (!payload || !payload.items || !Array.isArray(payload.items)) {
    console.warn("[FBR middleware] Rejected: missing payload or payload.items");
    return res.status(400).json({ ok: false, error: "Body must be { payload, fbrBearerToken, fbrBaseUrl } with payload.items array" });
  }
  if (!fbrBearerToken || !fbrBaseUrl) {
    console.warn("[FBR middleware] Rejected: missing fbrBearerToken or fbrBaseUrl");
    return res.status(400).json({
      ok: false,
      error: "Body must include fbrBearerToken and fbrBaseUrl (per-company credentials from invoicing app).",
    });
  }

  const isSandbox = payload.scenarioId != null;
  const validatePath = isSandbox ? VALIDATE_SB : VALIDATE_PROD;
  const postPath = isSandbox ? POST_SB : POST_PROD;
  const base = (fbrBaseUrl || "").replace(/\/$/, "");
  // In sandbox, use separate validate URL/token when provided (validateinvoicedata sandbox URL)
  const validateBaseUrl = isSandbox && fbrValidateBaseUrl && fbrValidateToken
    ? fbrValidateBaseUrl.replace(/\/$/, "")
    : base;
  const validateToken = isSandbox && fbrValidateBaseUrl && fbrValidateToken ? fbrValidateToken : fbrBearerToken;
  console.log("[FBR middleware] FBR base URL (post):", base, "| sandbox:", isSandbox, "| validate path:", validatePath, "| post path:", postPath);
  if (isSandbox && fbrValidateBaseUrl && fbrValidateToken) {
    console.log("[FBR middleware] Validate URL (sandbox):", validateBaseUrl);
  }
  console.log("[FBR middleware] Payload: invoiceDate:", payload.invoiceDate, "| items:", (payload.items || []).length, "| scenarioId:", payload.scenarioId ?? "(prod)");

  const validateResult = await callFbr(validateBaseUrl, validateToken, validatePath, payload, "Validate");
  const validateData = validateResult.body || {};
  const vr = validateData.validationResponse;
  // Do not post unless validation clearly succeeded: HTTP 200 and validationResponse.statusCode "00"
  const validateOk = validateResult.status === 200 && vr && vr.statusCode === "00";
  if (!validateOk) {
    const statusCode = vr?.statusCode ?? (validateResult.status !== 200 ? String(validateResult.status) : "(no response)");
    let errMsg = vr?.error || vr?.status ||
      (validateResult.status !== 200 ? `Validate request failed (HTTP ${validateResult.status}). Check validate URL.` : "Validation failed");
    if (errMsg === "Invalid" || (typeof errMsg === "string" && errMsg.trim() === "Invalid")) {
      errMsg = "FBR validation failed: Invalid. Check invoice data (NTN, amounts, line items, scenario) and try again.";
    }
    console.warn("[FBR middleware] Validate failed – not proceeding to post. HTTP:", validateResult.status, "statusCode:", statusCode, "error:", errMsg);
    console.warn("[FBR middleware] Full FBR validate response:", JSON.stringify(validateData, null, 2));
    console.warn("[FBR middleware] ----- POST /api/submit complete (400 validate) -----");
    return res.status(400).json({
      ok: false,
      error: errMsg,
      statusCode: statusCode,
      validationResponse: vr || { statusCode: "", status: "Error", error: errMsg },
      fbrValidateResponse: validateData,
      fbrPostResponse: null,
    });
  }

  const postResult = await callFbr(fbrBaseUrl, fbrBearerToken, postPath, payload, "Post");
  const postData = postResult.body || {};
  const postVr = postData.validationResponse;
  if (postResult.status !== 200 || (postVr && postVr.statusCode !== "00")) {
    let postErr = postVr?.error || postData?.error || (postResult.status !== 200 ? `Post request failed (HTTP ${postResult.status}).` : "Post failed");
    if (postErr === "Invalid" || (typeof postErr === "string" && postErr.trim() === "Invalid")) {
      postErr = "FBR post failed: Invalid. Check invoice data and FBR response in middleware logs.";
    }
    console.warn("[FBR middleware] Post failed. HTTP:", postResult.status, "statusCode:", postVr?.statusCode, "error:", postErr);
    console.warn("[FBR middleware] Full FBR post response:", JSON.stringify(postData, null, 2));
    console.warn("[FBR middleware] ----- POST /api/submit complete (400 post) -----");
    return res.status(400).json({
      ok: false,
      error: postErr,
      statusCode: postVr?.statusCode ?? (postResult.status !== 200 ? String(postResult.status) : undefined),
      validationResponse: postVr,
      fbrValidateResponse: validateData,
      fbrPostResponse: postData,
    });
  }

  // FBR/PRAL may return invoice number under various keys; check top-level, nested (data/result/response), and item statuses
  const trim = (v) => (v != null && String(v).trim() ? String(v).trim() : "");
  const knownKeys = [
    "invoiceNumber", "InvoiceNumber", "invoice_number", "invoiceNo", "InvoiceNo",
    "IRN", "Irn", "irn", "invoiceId", "invoice_id", "refNo", "referenceNo", "invoiceRefNo"
  ];
  const from = (obj) => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";
    for (const k of knownKeys) {
      const v = trim(obj[k]);
      if (v) return v;
    }
    return "";
  };
  const invoiceNumber =
    from(postData) ||
    from(postData?.data) ||
    from(postData?.result) ||
    from(postData?.response) ||
    (postVr?.invoiceStatuses?.[0]?.invoiceNo && trim(postVr.invoiceStatuses[0].invoiceNo)) ||
    (postData?.validationResponse?.invoiceStatuses?.[0]?.invoiceNo && trim(postData.validationResponse.invoiceStatuses[0].invoiceNo)) ||
    (postVr?.invoiceNo && trim(postVr.invoiceNo)) ||
    "";

  if (!invoiceNumber) {
    const topKeys = Object.keys(postData || {});
    console.warn("[FBR middleware] FBR post succeeded but no invoice number found. Top-level keys:", topKeys.join(", ") || "(none)");
    console.warn("[FBR middleware] Full FBR post response (check this to see the exact field name FBR uses):", JSON.stringify(postData, null, 2));
    console.warn("[FBR middleware] ----- POST /api/submit complete (502) -----");
    return res.status(502).json({
      ok: false,
      error: `FBR post succeeded but no invoice number in response. Response keys: ${topKeys.length ? topKeys.join(", ") : "empty"}. Check middleware logs for full response and FBR docs for the correct field name.`,
      validationResponse: postVr || { statusCode: "00", status: "Valid", error: "" },
      fbrValidateResponse: validateData,
      fbrPostResponse: postData,
    });
  }

  console.log("[FBR middleware] Success, invoiceNumber:", invoiceNumber, "| dated:", postData.dated);
  console.log("[FBR middleware] ----- POST /api/submit complete -----");
  res.status(200).json({
    ok: true,
    invoiceNumber,
    dated: postData.dated,
    validationResponse: postVr || { statusCode: "00", status: "Valid", error: "" },
    fbrValidateResponse: validateData,
    fbrPostResponse: postData,
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
