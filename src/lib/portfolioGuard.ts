// Guardia centralizada de escritura del documento users/{u}/data/portfolio.
// Módulo puro (sin Firebase): se usa en App.tsx antes de cada setDoc y en la migración.
//
// Reglas:
// - Se mide el JSON real que se escribiría (no un objeto parcial).
// - Un Base64 (data URL) NUEVO nunca se escribe: debe ir a Storage antes.
// - Los Base64 históricos ya presentes en la nube se toleran (transición) pero siguen
//   contando para el tamaño, así que la escritura se bloquea si supera el margen seguro.

import {
  estimatePayloadBytes,
  PORTFOLIO_DOC_HARD_BYTES,
  PORTFOLIO_DOC_SAFE_BYTES,
  isInlineDataUrl,
} from "./attachmentRules";

/** Proporción del margen seguro a partir de la cual se avisa de que la cartera crece demasiado. */
export const NEAR_LIMIT_RATIO = 0.8;

export interface InlineDataUrl {
  path: string;
  value: string;
}

export function collectInlineDataUrls(value: unknown, path = "$", out: InlineDataUrl[] = []): InlineDataUrl[] {
  if (isInlineDataUrl(value)) {
    out.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => collectInlineDataUrls(v, `${path}[${i}]`, out));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      collectInlineDataUrls(v, `${path}.${k}`, out);
    }
  }
  return out;
}

/** Conjunto de data URLs presentes en un documento: base de la transición (históricos conocidos). */
export function legacyDataUrlSet(value: unknown): Set<string> {
  return new Set(collectInlineDataUrls(value).map((d) => d.value));
}

export interface PortfolioWriteCheck {
  ok: boolean;
  /** Bytes UTF-8 del JSON exacto que se escribiría. */
  bytes: number;
  safeBytes: number;
  hardBytes: number;
  /** Margen restante respecto al límite seguro (negativo si se supera). */
  marginBytes: number;
  nearLimit: boolean;
  newInlineDataPaths: string[];
  legacyInlineDataPaths: string[];
  /** Mensajes comprensibles para el usuario. Vacío si ok. */
  errors: string[];
}

export function checkPortfolioWrite(
  body: unknown,
  opts: { allowedLegacyDataUrls?: ReadonlySet<string> } = {}
): PortfolioWriteCheck {
  const bytes = estimatePayloadBytes(body);
  const inline = collectInlineDataUrls(body);
  const allowed = opts.allowedLegacyDataUrls;
  const newInline = inline.filter((d) => !allowed || !allowed.has(d.value));
  const legacyInline = inline.filter((d) => allowed && allowed.has(d.value));

  const errors: string[] = [];
  if (newInline.length > 0) {
    errors.push(
      `Se han detectado ${newInline.length} adjunto(s) nuevos en Base64 (p. ej. ${newInline[0].path}). ` +
        "Los adjuntos deben guardarse en Firebase Storage antes de escribir la cartera. La escritura se ha cancelado y los cambios NO se han guardado en la nube."
    );
  }
  if (bytes > PORTFOLIO_DOC_SAFE_BYTES) {
    errors.push(
      `La cartera ocupa ${Math.round(bytes / 1024)} KB y supera el margen seguro del documento de Firestore ` +
        `(${Math.round(PORTFOLIO_DOC_SAFE_BYTES / 1024)} KB; límite duro 1 MiB). ` +
        "Los cambios NO se han guardado en la nube. Migra los adjuntos históricos a Storage desde Sincronización."
    );
  }

  return {
    ok: errors.length === 0,
    bytes,
    safeBytes: PORTFOLIO_DOC_SAFE_BYTES,
    hardBytes: PORTFOLIO_DOC_HARD_BYTES,
    marginBytes: PORTFOLIO_DOC_SAFE_BYTES - bytes,
    nearLimit: bytes > PORTFOLIO_DOC_SAFE_BYTES * NEAR_LIMIT_RATIO,
    newInlineDataPaths: newInline.map((d) => d.path),
    legacyInlineDataPaths: legacyInline.map((d) => d.path),
    errors,
  };
}

export class PortfolioWriteError extends Error {
  constructor(public readonly check: PortfolioWriteCheck) {
    super(check.errors.join(" "));
    this.name = "PortfolioWriteError";
  }
}

/** Lanza PortfolioWriteError si el documento no puede escribirse. */
export function assertPortfolioWritable(body: unknown, opts: { allowedLegacyDataUrls?: ReadonlySet<string> } = {}): PortfolioWriteCheck {
  const check = checkPortfolioWrite(body, opts);
  if (!check.ok) throw new PortfolioWriteError(check);
  return check;
}
