/**
 * FBR Digital Invoicing middleware.
 * Contract: POST /api/submit with Authorization: Bearer <MIDDLEWARE_API_KEY>,
 * body: { payload, fbrBearerToken, fbrBaseUrl [, isSandbox, fbrValidateBaseUrl, fbrValidateToken ] }.
 * - isSandbox: optional; when provided by invoicing app, preferred over payload.scenarioId for path selection.
 * - fbrValidateBaseUrl + fbrValidateToken: optional; when provided in sandbox (payload.scenarioId set),
 *   validate call uses this URL/token (e.g. validateinvoicedata sandbox URL). Post always uses fbrBaseUrl/fbrBearerToken.
 * Calls FBR validate then post; returns normalized fields plus full FBR responses:
 * - Success: { ok: true, invoiceNumber, dated, validationResponse, fbrValidateResponse, fbrPostResponse }
 * - Error: { ok: false, error, statusCode?, validationResponse?, fbrValidateResponse?, fbrPostResponse? }
 *
 * Contract: POST /api/reference with Authorization: Bearer <MIDDLEWARE_API_KEY>,
 * body: { path, params?, fbrBaseUrl, fbrBearerToken }.
 * Forwards GET (fbrBaseUrl + path)?(params) with Bearer token; returns FBR response as JSON.
 */

require("dotenv").config();

const express = require("express");

const MIDDLEWARE_API_KEY = process.env.MIDDLEWARE_API_KEY;
const PORT = process.env.PORT || 3001;

const VALIDATE_SB = "/di_data/v1/di/validateinvoicedata_sb";
const VALIDATE_PROD = "/di_data/v1/di/validateinvoicedata";
const POST_SB = "/di_data/v1/di/postinvoicedata_sb";
const POST_PROD = "/di_data/v1/di/postinvoicedata";

const FBR_PRODUCTION_HEADER_KEYS = [
  "invoiceType",
  "invoiceDate",
  "sellerNTNCNIC",
  "sellerBusinessName",
  "sellerProvince",
  "sellerAddress",
  "buyerNTNCNIC",
  "buyerBusinessName",
  "buyerProvince",
  "buyerAddress",
  "buyerRegistrationType",
  "invoiceRefNo",
];

const FBR_ITEM_KEYS = [
  "hsCode",
  "productDescription",
  "rate",
  "uoM",
  "quantity",
  "totalValues",
  "valueSalesExcludingST",
  "fixedNotifiedValueOrRetailPrice",
  "salesTaxApplicable",
  "salesTaxWithheldAtSource",
  "extraTax",
  "furtherTax",
  "sroScheduleNo",
  "fedPayable",
  "discount",
  "saleType",
  "sroItemSerialNo",
];

/** Gateway origin only — paths are appended by this service. */
function normalizeFbrGatewayBaseUrl(baseUrl) {
  const s = (baseUrl || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s.startsWith("http") ? s : `https://${s}`);
    return u.origin;
  } catch {
    return s
      .replace(/\/+$/, "")
      .replace(/\/di_data\/v1\/di\/(post|validate)invoicedata(_sb)?$/i, "")
      .split("/")
      .slice(0, 3)
      .join("/");
  }
}

function stripSandboxFields(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const { scenarioId, ...rest } = payload;
  const next = { ...rest };
  if (next.invoiceType !== "Debit Note") next.invoiceRefNo = "";
  return next;
}

/** PRAL expects numeric decimals; empty extraTax as "" triggers gateway Code 03. */
function normalizeOutboundPayload(payload, isSandbox) {
  if (!payload || typeof payload !== "object") return payload;
  const roundMoney = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.round(x * 100) / 100;
  };
  const roundQty = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return 0;
    return Math.round(x * 10000) / 10000;
  };
  const items = (payload.items || []).map((item) => {
    const extra = item.extraTax;
    const extraTax = extra != null && extra !== "" && Number(extra) !== 0 ? roundMoney(extra) : 0;
    const row = {
      hsCode: String(item.hsCode ?? "").trim() || "0000.0000",
      productDescription: String(item.productDescription ?? "Item").replace(/[\u0000-\u001F\u007F]/g, " ").trim(),
      rate: String(item.rate ?? "18%").trim() || "18%",
      uoM: String(item.uoM ?? "Numbers").trim() || "Numbers",
      quantity: roundQty(item.quantity),
      totalValues: roundMoney(item.totalValues),
      valueSalesExcludingST: roundMoney(item.valueSalesExcludingST),
      fixedNotifiedValueOrRetailPrice: roundMoney(item.fixedNotifiedValueOrRetailPrice),
      salesTaxApplicable: roundMoney(item.salesTaxApplicable),
      salesTaxWithheldAtSource: roundMoney(item.salesTaxWithheldAtSource),
      extraTax,
      furtherTax: roundMoney(item.furtherTax),
      sroScheduleNo: String(item.sroScheduleNo ?? ""),
      fedPayable: roundMoney(item.fedPayable),
      discount: roundMoney(item.discount),
      saleType: String(item.saleType ?? "Goods at standard rate (default)").trim(),
      sroItemSerialNo: String(item.sroItemSerialNo ?? ""),
    };
    const picked = {};
    for (const key of FBR_ITEM_KEYS) picked[key] = row[key];
    return picked;
  });

  const headerKeys = isSandbox ? [...FBR_PRODUCTION_HEADER_KEYS, "scenarioId"] : FBR_PRODUCTION_HEADER_KEYS;
  const strict = {};
  for (const key of headerKeys) {
    if (key === "scenarioId") {
      if (isSandbox && payload.scenarioId) strict.scenarioId = String(payload.scenarioId).trim();
      continue;
    }
    strict[key] = payload[key];
  }
  if (strict.invoiceType !== "Debit Note") strict.invoiceRefNo = "";
  strict.items = items;
  return strict;
}

function parseInboundPayload(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return typeof raw === "object" ? raw : null;
}

/** FBR gateway errors (Code 03 etc.) arrive without validationResponse wrapper on HTTP 500. */
function extractFbrGatewayError(validateData, validateResult) {
  const vr = validateData?.validationResponse;
  if (vr?.error?.trim()) return vr.error.trim();
  if (vr?.status?.trim() && vr.status !== "Valid") return vr.status.trim();
  const gatewayErr = typeof validateData?.error === "string" ? validateData.error.trim() : "";
  const code = validateData?.Code != null ? String(validateData.Code).trim() : "";
  if (gatewayErr) {
    if (code === "03") {
      return `${gatewayErr} (FBR Code 03). Fix payload types: extraTax must be 0 not "", numeric amounts, no scenarioId in production.`;
    }
    return code ? `${gatewayErr} (FBR Code ${code})` : gatewayErr;
  }
  if (validateResult.status !== 200) {
    return `FBR validate returned HTTP ${validateResult.status} (${validateResult.url}). ${validateResult.status >= 500 ? "Gateway/server error — confirm production DI token, IP whitelist, and that the token is not a sandbox token." : "Check validate URL and token."}`;
  }
  return "Validation failed";
}

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
  const base = normalizeFbrGatewayBaseUrl(baseUrl);
  const pathNoLeading = path.replace(/^\//, "");
  const isFullUrl = pathNoLeading && (base.endsWith(pathNoLeading) || base === pathNoLeading);
  const url = isFullUrl ? base : `${base}${path}`;
  const startMs = Date.now();
  console.log(`[FBR middleware] ${logLabel} request URL: ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearerToken}`,
    },
    body: JSON.stringify(payload),
  });
  const elapsedMs = Date.now() - startMs;
  const status = res.status;
  const rawText = await res.text();
  let body = {};
  if (rawText) {
    try {
      body = JSON.parse(rawText);
    } catch {
      body = { error: rawText.slice(0, 500) };
    }
  }
  console.log(`[FBR middleware] ${logLabel} response status: ${status}, body keys: ${Object.keys(body || {}).join(", ") || "(empty)"}, FBR took: ${elapsedMs} ms`);
  if (status >= 500 && rawText) {
    console.warn(`[FBR middleware] ${logLabel} HTTP ${status} body preview:`, rawText.slice(0, 500));
  }
  return { status, body, url, rawText };
}

app.post("/api/submit", auth, async (req, res) => {
  const submitStartMs = Date.now();
  console.log("[FBR middleware] ----- POST /api/submit received -----");
  let payload = parseInboundPayload(req.body?.payload);
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

  const isSandbox =
    typeof req.body?.isSandbox === "boolean"
      ? req.body.isSandbox
      : payload.scenarioId != null;
  let outboundPayload = isSandbox ? payload : stripSandboxFields(payload);
  outboundPayload = normalizeOutboundPayload(outboundPayload, isSandbox);
  const validatePath = isSandbox ? VALIDATE_SB : VALIDATE_PROD;
  const postPath = isSandbox ? POST_SB : POST_PROD;
  const base = normalizeFbrGatewayBaseUrl(fbrBaseUrl);
  // In sandbox, use separate validate URL/token when provided (validateinvoicedata sandbox URL)
  const validateBaseUrl = isSandbox && fbrValidateBaseUrl && fbrValidateToken
    ? normalizeFbrGatewayBaseUrl(fbrValidateBaseUrl)
    : base;
  const validateToken = isSandbox && fbrValidateBaseUrl && fbrValidateToken ? fbrValidateToken : fbrBearerToken;
  console.log("[FBR middleware] FBR base URL (post):", base, "| sandbox:", isSandbox, "| validate path:", validatePath, "| post path:", postPath);
  if (isSandbox && fbrValidateBaseUrl && fbrValidateToken) {
    console.log("[FBR middleware] Validate URL (sandbox):", validateBaseUrl);
  }
  console.log("[FBR middleware] Payload: invoiceDate:", outboundPayload.invoiceDate, "| items:", (outboundPayload.items || []).length, "| scenarioId:", outboundPayload.scenarioId ?? "(prod)");

  const validateResult = await callFbr(validateBaseUrl, validateToken, validatePath, outboundPayload, "Validate");
  const validateData = validateResult.body || {};
  const vr = validateData.validationResponse;
  // Do not post unless validation clearly succeeded: HTTP 200 and validationResponse.statusCode "00"
  const validateOk = validateResult.status === 200 && vr && vr.statusCode === "00";
  if (!validateOk) {
    const statusCode = vr?.statusCode ?? validateData?.Code ?? (validateResult.status !== 200 ? String(validateResult.status) : "(no response)");
    let errMsg = extractFbrGatewayError(validateData, validateResult);
    // Build detailed message from per-item errors (invoiceStatuses) when present
    const itemErrors = Array.isArray(vr?.invoiceStatuses)
      ? vr.invoiceStatuses
          .filter((s) => s?.error && String(s.error).trim())
          .map((s) => `Item ${s.itemSNo || "?"}: ${String(s.error).trim()}`)
      : [];
    if (itemErrors.length > 0) {
      errMsg = itemErrors.join(" | ");
    } else if (errMsg === "Invalid" || (typeof errMsg === "string" && errMsg.trim() === "Invalid")) {
      errMsg = "FBR validation failed: Invalid. Check invoice data (NTN, amounts, line items, scenario) and try again.";
    }
    // Log and return the complete FBR validate response (full raw body we received)
    const fullValidateResponse = validateResult.body ?? validateData;
    console.warn("[FBR middleware] Validate failed – not proceeding to post. HTTP:", validateResult.status, "statusCode:", statusCode, "error:", errMsg);
    console.warn("[FBR middleware] Outbound payload preview:", JSON.stringify(outboundPayload).slice(0, 800));
    console.warn("[FBR middleware] Full FBR validate response (complete):", JSON.stringify(fullValidateResponse, null, 2));
    console.warn("[FBR middleware] ----- POST /api/submit complete (400 validate), total:", Date.now() - submitStartMs, "ms -----");
    return res.status(400).json({
      ok: false,
      error: errMsg,
      statusCode: statusCode,
      validateUrl: validateResult.url,
      fbrValidateHttpStatus: validateResult.status,
      validationResponse: vr || { statusCode: "", status: "Error", error: errMsg },
      fbrValidateResponse: fullValidateResponse,
      fbrPostResponse: null,
    });
  }

  const postResult = await callFbr(base, fbrBearerToken, postPath, outboundPayload, "Post");
  const postData = postResult.body || {};
  const postVr = postData.validationResponse;
  if (postResult.status !== 200 || (postVr && postVr.statusCode !== "00")) {
    let postErr = postVr?.error || postData?.error || (postResult.status !== 200 ? `Post request failed (HTTP ${postResult.status}).` : "Post failed");
    if (postErr === "Invalid" || (typeof postErr === "string" && postErr.trim() === "Invalid")) {
      postErr = "FBR post failed: Invalid. Check invoice data and FBR response in middleware logs.";
    }
    console.warn("[FBR middleware] Post failed. HTTP:", postResult.status, "statusCode:", postVr?.statusCode, "error:", postErr);
    console.warn("[FBR middleware] Full FBR post response:", JSON.stringify(postData, null, 2));
    console.warn("[FBR middleware] ----- POST /api/submit complete (400 post), total:", Date.now() - submitStartMs, "ms -----");
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
    console.warn("[FBR middleware] ----- POST /api/submit complete (502), total:", Date.now() - submitStartMs, "ms -----");
    return res.status(502).json({
      ok: false,
      error: `FBR post succeeded but no invoice number in response. Response keys: ${topKeys.length ? topKeys.join(", ") : "empty"}. Check middleware logs for full response and FBR docs for the correct field name.`,
      validationResponse: postVr || { statusCode: "00", status: "Valid", error: "" },
      fbrValidateResponse: validateData,
      fbrPostResponse: postData,
    });
  }

  console.log("[FBR middleware] Success, invoiceNumber:", invoiceNumber, "| dated:", postData.dated);
  console.log("[FBR middleware] ----- POST /api/submit complete, total:", Date.now() - submitStartMs, "ms -----");
  res.status(200).json({
    ok: true,
    invoiceNumber,
    dated: postData.dated,
    validationResponse: postVr || { statusCode: "00", status: "Valid", error: "" },
    fbrValidateResponse: validateData,
    fbrPostResponse: postData,
  });
});

/** POST /api/reference – forward FBR reference API GET (provinces, HS_UOM, itemdesccode, uom, etc.) */
app.post("/api/reference", auth, async (req, res) => {
  const path = req.body?.path != null ? String(req.body.path).trim() : "";
  const params = req.body?.params && typeof req.body.params === "object" ? req.body.params : null;
  const fbrBaseUrl = req.body?.fbrBaseUrl != null ? String(req.body.fbrBaseUrl).trim() : "";
  const fbrBearerToken = req.body?.fbrBearerToken != null ? String(req.body.fbrBearerToken).trim() : "";

  if (!path || !fbrBaseUrl || !fbrBearerToken) {
    console.warn("[FBR middleware] /api/reference rejected: missing path, fbrBaseUrl, or fbrBearerToken");
    return res.status(400).json({
      error: "Body must be { path, params?, fbrBaseUrl, fbrBearerToken }",
    });
  }

  const base = fbrBaseUrl.replace(/\/$/, "");
  const pathNorm = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(pathNorm, base);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  }
  const fullUrl = url.toString();
  const refStartMs = Date.now();
  console.log("[FBR middleware] /api/reference GET:", fullUrl);

  try {
    const fbrRes = await fetch(fullUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${fbrBearerToken}`,
      },
    });
    const text = await fbrRes.text();
    const refElapsedMs = Date.now() - refStartMs;
    console.log("[FBR middleware] /api/reference FBR took:", refElapsedMs, "ms, status:", fbrRes.status);
    if (!fbrRes.ok) {
      console.warn("[FBR middleware] /api/reference FBR non-OK:", fbrRes.status, text.slice(0, 200));
      res.status(fbrRes.status);
      try {
        res.json(text ? JSON.parse(text) : { error: text || `FBR returned ${fbrRes.status}` });
      } catch {
        res.send(text);
      }
      return;
    }
    res.status(fbrRes.status).set("Content-Type", fbrRes.headers.get("content-type") || "application/json");
    try {
      res.send(text ? JSON.parse(text) : {});
    } catch {
      res.send(text);
    }
  } catch (err) {
    console.error("[FBR middleware] /api/reference fetch failed:", err);
    res.status(502).json({
      error: "FBR request failed",
      message: err?.message || String(err),
    });
  }
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
