/**
 * Reading the inbound x402 payment header (diagnostics + decoding), shared by the paywall (x402.ts) and the
 * refused-payment log (traffic.ts).
 *
 * x402 v2 HTTP transport: the client sends `PAYMENT-SIGNATURE: base64(JSON PaymentPayload)`. `X-PAYMENT` is the
 * v1 header name; it is still read (same value format) because many v2 clients and proxies send it.
 * The spec says base64 (RFC 4648). base64url is the same bytes and is read too; raw JSON is NOT accepted (it is
 * recognised only so the refusal can say exactly what to change). Nothing here verifies anything: decoding a header
 * never makes it a payment. Signature, amount, payee, invoice and settlement checks all happen later, unchanged.
 */

export const PAYMENT_HEADER_NAMES = ["PAYMENT-SIGNATURE", "X-PAYMENT"] as const;
export type PaymentHeaderName = (typeof PAYMENT_HEADER_NAMES)[number];
export type PaymentHeaderEncoding = "base64" | "base64url" | "raw_json" | "invalid";

export const X402_HTTP_SPEC_URL = "https://github.com/coinbase/x402/blob/main/specs/transports-v2/http.md";

/** The payment header actually used (PAYMENT-SIGNATURE wins over X-PAYMENT), with its name. */
export function readPaymentHeader(request: Request): { name: PaymentHeaderName; value: string } | null {
  for (const name of PAYMENT_HEADER_NAMES) {
    const value = request.headers.get(name);
    if (value) return { name, value };
  }
  return null;
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function decodeB64Json(s: string): unknown {
  const padded = s.replace(/=+$/, "");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
}

/**
 * Classify and parse a payment header value. `obj` is the parsed JSON (an object) or null. For `raw_json` the object
 * is returned for diagnostics only; callers must refuse it (spec: base64).
 */
export function parsePaymentHeader(value: string): { encoding: PaymentHeaderEncoding; obj: Record<string, any> | null } {
  const s = value.trim();
  const asObj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : null);
  if (s.startsWith("{")) {
    try {
      const obj = asObj(JSON.parse(s));
      return obj ? { encoding: "raw_json", obj } : { encoding: "invalid", obj: null };
    } catch {
      return { encoding: "invalid", obj: null };
    }
  }
  const compact = s.replace(/\s+/g, "");
  const encoding: PaymentHeaderEncoding | null = B64.test(compact) ? "base64" : B64URL.test(compact) ? "base64url" : null;
  if (!encoding) return { encoding: "invalid", obj: null };
  try {
    const src = encoding === "base64url" ? compact.replace(/-/g, "+").replace(/_/g, "/") : compact;
    const obj = asObj(decodeB64Json(src));
    return obj ? { encoding, obj } : { encoding: "invalid", obj: null };
  } catch {
    return { encoding: "invalid", obj: null };
  }
}

/** x402Version of a parsed payload (integer 0-99) or null. */
export function payloadVersion(obj: Record<string, any> | null): number | null {
  const v = Number(obj?.x402Version);
  return obj && Number.isInteger(v) && v >= 0 && v < 100 ? v : null;
}

export type PaymentHeaderProblem =
  | { error: "payment_header_not_base64"; problem: string }
  | { error: "invalid_x402_version"; problem: string }
  | { error: "invalid_payment_signature_header"; problem: string };

/**
 * Why a header cannot be used as an x402 v2 PaymentPayload, or null when it is structurally a v2 payload
 * (base64/base64url JSON with x402Version 2 and an `accepted` object). Structure only: no verification.
 */
export function paymentHeaderProblem(value: string): PaymentHeaderProblem | null {
  const { encoding, obj } = parsePaymentHeader(value);
  if (encoding === "invalid" || !obj) {
    return { error: "invalid_payment_signature_header", problem: "The payment header is not base64-encoded JSON." };
  }
  const version = payloadVersion(obj);
  if (encoding === "raw_json") {
    return { error: "payment_header_not_base64", problem: "The payment header is raw JSON. x402 requires the JSON PaymentPayload to be base64-encoded." };
  }
  if (version !== 2) {
    const v1Shape = !obj.accepted && (typeof obj.scheme === "string" || typeof obj.network === "string");
    return {
      error: "invalid_x402_version",
      problem:
        version === 1 || v1Shape
          ? "This is an x402 v1 payment (top-level scheme/network, no `accepted`). This API quotes and verifies x402 v2 only: pay one of the v2 `accepts` entries in this response."
          : `x402Version must be 2 (got ${version === null ? "none" : version}).`,
    };
  }
  if (!obj.accepted || typeof obj.accepted !== "object" || Array.isArray(obj.accepted)) {
    return { error: "invalid_payment_signature_header", problem: "x402 v2 PaymentPayload is missing the `accepted` object (copy one entry of `accepts` from this response)." };
  }
  return null;
}

/**
 * The machine- and human-readable fix-it block added to a 402 when the payment header could not be used.
 * Names the expected header, encoding and version, shows a decoded example, and says nothing was charged.
 */
export function paymentHeaderHelp(
  problem: PaymentHeaderProblem,
  received: { name: PaymentHeaderName; value: string },
): Record<string, unknown> {
  const { encoding, obj } = parsePaymentHeader(received.value);
  return {
    problem: problem.problem,
    received: { header: received.name, encoding, x402Version: payloadVersion(obj) },
    expected: {
      header: "PAYMENT-SIGNATURE",
      also_read: "X-PAYMENT (same value; used only when PAYMENT-SIGNATURE is absent)",
      encoding: "base64 (RFC 4648) of the UTF-8 JSON PaymentPayload; base64url also read; raw JSON is not accepted",
      x402Version: 2,
    },
    example: {
      header: "PAYMENT-SIGNATURE: base64(<the JSON below>)",
      decoded: {
        x402Version: 2,
        accepted: "<one object from `accepts` in this response, copied unchanged (keep extra.invoiceId)>",
        payload: "<the scheme's signed payload produced by your x402 client>",
      },
    },
    spec: X402_HTTP_SPEC_URL,
    note: "Not charged. Every payment is verified (signature, amount, payee, invoice) before anything is served.",
  };
}
