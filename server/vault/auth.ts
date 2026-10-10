// Autenticación del vault: hash de contraseñas (scrypt) y tokens de sesión HMAC.
// Sin dependencias externas: node:crypto. Las contraseñas nunca se guardan en claro
// ni se devuelven; los tokens están ligados al usuario y caducan.
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N }).toString("hex");
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expectedHash: string): boolean {
  try {
    const actual = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N });
    const expected = Buffer.from(expectedHash, "hex");
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface SessionClaims {
  /** Usuario (cuenta de la aplicación) al que pertenece la sesión. */
  sub: string;
  /** Emitido en (ms epoch). */
  iat: number;
  /** Expira en (ms epoch). */
  exp: number;
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8");
}

/** Crea un token de sesión firmado (HMAC-SHA256) para el usuario. */
export function createSessionToken(secret: string, username: string, ttlMs: number = SESSION_TTL_MS): string {
  const now = Date.now();
  const claims: SessionClaims = { sub: username, iat: now, exp: now + ttlMs };
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(payload).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${payload}.${sig}`;
}

/** Verifica firma y caducidad. Devuelve el usuario o null. */
export function verifySessionToken(secret: string, token: string): string | null {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = createHmac("sha256", secret).update(payload).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(fromB64url(payload)) as SessionClaims;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    if (typeof claims.exp !== "number" || Date.now() > claims.exp) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

/** Política de contraseñas mínima (coherente con AuthScreen: mínimo 4 caracteres). */
export function passwordProblem(password: string): string | null {
  if (typeof password !== "string" || password.length < 4) return "La contraseña debe tener al menos 4 caracteres.";
  if (password.length > 256) return "La contraseña es demasiado larga.";
  return null;
}

/** Nombres de usuario válidos: minúsculas, dígitos, guiones y guiones bajos (3..64). */
export function normalizeUsername(username: string): string | null {
  if (typeof username !== "string") return null;
  const clean = username.trim().toLowerCase();
  if (!/^[a-z0-9_-]{3,64}$/.test(clean)) return null;
  return clean;
}
