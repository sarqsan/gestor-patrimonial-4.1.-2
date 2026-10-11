// Persistencia remota de las ENTIDADES PATRIMONIALES estructuradas (almacén remoto propio).
//
// La cartera se divide en entidades con identificador propio —una por objeto JSON en el
// almacén remoto del backend (server/vault)— de modo que:
//   - reintentar es idempotente por identificador (sin duplicados),
//   - dos escrituras concurrentes de entidades distintas no se pisan,
//   - las RELACIONES viajan por identificador dentro de cada entidad (propertyId,
//     movementId, vaultId, titularidad en el inmueble) y se conservan íntegras.
//
// Tipos de entidad (lista cerrada también en el servidor):
//   owners      — titulares (user1 / user2) con sus datos de perfil.
//   properties  — inmuebles, con la titularidad (owner + porcentajes), el contrato embebido
//                 y los metadatos de sus documentos (el binario vive en `files`).
//   contracts   — contratos del redactor, relacionados por propertyId.
//   payments    — recibos de renta (RentPayment), relacionados por propertyId.
//   settings    — metadatos de la cartera (eventos de sincronización, año, perfiles anuales,
//                 tema) y el ORDEN de visualización de las listas.
//
// Los ingresos/gastos (movements) y los documentos binarios (files) tienen rutas dedicadas
// en el backend; aquí solo se documentan sus relaciones.
//
// Este módulo es el camino DEFINITIVO de guardado de la cartera. Firestore queda como espejo
// legado documentado (véase docs/matriz-entidades-patrimoniales.md).

import type { AppState, Property, RentPayment, SyncEvent, UserProfile, PartnerProfile } from "../types";
import { portfolioBody } from "./portfolioPayload";
import { stableStringify, utf8Bytes, sha256Hex } from "./stableHash";
import {
  VaultAuthError,
  VaultError,
  VaultUnavailableError,
  getVaultToken,
  vaultOperationUrl,
} from "./vaultClient";

export type PortfolioBody = ReturnType<typeof portfolioBody>;

export const PORTFOLIO_ENTITY_TYPES = ["owners", "properties", "contracts", "payments", "settings"] as const;
export type PortfolioEntityType = (typeof PORTFOLIO_ENTITY_TYPES)[number];

export interface PortfolioEntity {
  type: PortfolioEntityType;
  id: string;
  entity: unknown;
}

/** Patrón de identificador admitido por el servidor (letras, números, guiones, guion bajo). */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Identificador estable: el del registro si es válido; si no, derivado de su contenido. */
export async function stableEntityId(id: unknown, content: unknown): Promise<string> {
  if (typeof id === "string" && SAFE_ID.test(id)) return id;
  const hash = await sha256Hex(utf8Bytes(stableStringify(content)));
  return `ent_${hash.slice(0, 16)}`;
}

// ---------- HTTP sobre el backend (forma compatible ?op=) ----------

interface EntityRecord {
  id: string;
  updatedAt: string;
  data: unknown;
}

async function request(
  username: string,
  op: string,
  opts: { id?: string; type?: PortfolioEntityType; method?: string; body?: unknown }
): Promise<Response> {
  const token = getVaultToken(username);
  if (!token) throw new VaultAuthError("No hay sesión del almacenamiento remoto para este usuario.");
  const url =
    vaultOperationUrl(op, opts.id) +
    (opts.type ? `&type=${encodeURIComponent(opts.type)}` : "");
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch {
    throw new VaultUnavailableError(
      "No se ha podido conectar con el almacenamiento remoto de la aplicación. La cartera no se ha guardado."
    );
  }
  if (res.status === 401) {
    throw new VaultAuthError("La sesión del almacenamiento remoto no es válida o ha caducado. Inicia sesión de nuevo.");
  }
  return res;
}

async function listEntitiesRemote(username: string, type: PortfolioEntityType): Promise<EntityRecord[]> {
  const res = await request(username, "entities.list", { type });
  if (!res.ok) throw new VaultError(`Error ${res.status} al leer entidades (${type}) del almacenamiento remoto.`);
  const body = (await res.json()) as { entities?: EntityRecord[] };
  return body.entities ?? [];
}

async function putEntityRemote(username: string, type: PortfolioEntityType, id: string, entity: unknown): Promise<void> {
  const res = await request(username, "entities.put", { method: "POST", body: { type, id, entity } });
  if (!res.ok) {
    let detail = `Error ${res.status}`;
    try {
      detail = ((await res.json()) as any)?.error || detail;
    } catch {
      /* sin cuerpo */
    }
    throw new VaultError(`El almacén remoto no ha confirmado la entidad ${type}:${id}. ${detail}`);
  }
}

async function deleteEntityRemote(username: string, type: PortfolioEntityType, id: string): Promise<void> {
  const res = await request(username, "entities.delete", { id, type, method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    throw new VaultError(`El almacén remoto no ha confirmado el borrado de ${type}:${id} (error ${res.status}).`);
  }
}

// ---------- caché de sincronización (solo cambia lo que cambia) ----------

/** Último contenido sincronizado por usuario: `type/id` → hash estable del JSON. */
const syncedHashes = new Map<string, Map<string, string>>();

export function clearPortfolioSyncCache(username?: string): void {
  if (username) syncedHashes.delete(username);
  else syncedHashes.clear();
}

function cacheKey(type: string, id: string): string {
  return `${type}/${id}`;
}

// ---------- división y recomposición de la cartera ----------

interface SettingsEntity {
  syncEvents: SyncEvent[];
  syncEnabled: boolean;
  isOnboarded: boolean;
  currentYear: number;
  yearlyProfiles: NonNullable<AppState["yearlyProfiles"]>;
  theme: string;
  order?: Record<string, string[]>;
}

function splitSettings(body: PortfolioBody, order: Record<string, string[]>): SettingsEntity {
  return {
    syncEvents: (body.syncEvents ?? []) as SyncEvent[],
    syncEnabled: body.syncEnabled ?? true,
    isOnboarded: body.isOnboarded ?? true,
    currentYear: body.currentYear || 2026,
    yearlyProfiles: body.yearlyProfiles ?? {},
    theme: body.theme || "slate-indigo",
    order,
  };
}

/** Divide el cuerpo de la cartera en entidades con identificador propio. */
export async function portfolioToEntities(body: PortfolioBody): Promise<PortfolioEntity[]> {
  const out: PortfolioEntity[] = [];
  out.push({ type: "owners", id: "user1", entity: body.user1 });
  out.push({ type: "owners", id: "user2", entity: body.user2 });

  const properties = (body.properties ?? []) as Property[];
  const payments = (body.payments ?? []) as RentPayment[];
  const contracts = (body.contracts ?? []) as unknown[];

  for (const p of properties) {
    out.push({ type: "properties", id: await stableEntityId(p?.id, p), entity: p });
  }
  for (const [i, c] of contracts.entries()) {
    const id = await stableEntityId((c as any)?.id, c);
    out.push({ type: "contracts", id, entity: c });
  }
  for (const p of payments) {
    out.push({ type: "payments", id: await stableEntityId(p?.id, p), entity: p });
  }

  const order: Record<string, string[]> = {
    properties: [],
    contracts: [],
    payments: [],
  };
  for (const e of out) {
    if (e.type in order) order[e.type].push(e.id);
  }
  out.push({ type: "settings", id: "app", entity: splitSettings(body, order) });
  return out;
}

function orderByIds<T extends { id?: string }>(items: T[], order: string[] | undefined, fallback: (t: T) => string): T[] {
  if (!order || order.length === 0) return items;
  const position = new Map(order.map((id, i) => [id, i]));
  return [...items].sort((a, b) => {
    const ia = position.get(fallback(a)) ?? Number.MAX_SAFE_INTEGER;
    const ib = position.get(fallback(b)) ?? Number.MAX_SAFE_INTEGER;
    return ia - ib;
  });
}

/** Recompone el cuerpo de la cartera desde las entidades remotas. */
export async function entitiesToPortfolio(groups: Record<PortfolioEntityType, EntityRecord[]>): Promise<PortfolioBody> {
  const settings = (groups.settings.find((e) => e.id === "app")?.data as SettingsEntity | undefined) ?? {
    syncEvents: [],
    syncEnabled: true,
    isOnboarded: true,
    currentYear: 2026,
    yearlyProfiles: {},
    theme: "slate-indigo",
  };
  const user1 = (groups.owners.find((e) => e.id === "user1")?.data as UserProfile) ?? {
    name: "",
    dni: "",
    brutoTrabajo: 0,
    netoTrabajo: 0,
  };
  const user2 = (groups.owners.find((e) => e.id === "user2")?.data as PartnerProfile) ?? {
    name: "",
    dni: "",
    brutoTrabajo: 0,
    netoTrabajo: 0,
    hasPartner: false,
  };
  const properties = orderByIds(
    groups.properties.map((e) => e.data as Property),
    settings.order?.properties,
    (p) => (typeof p?.id === "string" ? p.id : "")
  );
  const contracts = orderByIds(
    groups.contracts.map((e) => e.data),
    settings.order?.contracts,
    (c) => (typeof (c as any)?.id === "string" ? (c as any).id : "")
  );
  const payments = orderByIds(
    groups.payments.map((e) => e.data as RentPayment),
    settings.order?.payments,
    (p) => (typeof p?.id === "string" ? p.id : "")
  );
  return {
    user1,
    user2,
    properties,
    payments,
    expenses: [],
    contracts,
    syncEvents: settings.syncEvents ?? [],
    syncEnabled: settings.syncEnabled ?? true,
    isOnboarded: settings.isOnboarded ?? true,
    currentYear: settings.currentYear || 2026,
    yearlyProfiles: settings.yearlyProfiles ?? {},
    theme: settings.theme || "slate-indigo",
  } as PortfolioBody;
}

// ---------- sincronización e hidratación ----------

export interface PortfolioSyncResult {
  saved: number;
  deleted: number;
}

/**
 * Sincroniza la cartera con el almacén remoto (DEFINITIVO). Solo escribe lo que cambió y
 * elimina las entidades remotas que ya no existen en el estado local. La promesa se resuelve
 * únicamente cuando el almacén ha confirmado TODAS las escrituras: si no se resuelve, el
 * guardado NO se ha completado.
 */
export async function syncPortfolioEntities(username: string, body: PortfolioBody): Promise<PortfolioSyncResult> {
  const desired = await portfolioToEntities(body);
  const cache = syncedHashes.get(username) ?? new Map<string, string>();
  const seen = new Set<string>();

  // 1. Escritura de lo presente (solo si cambió respecto de la última sincronización).
  let saved = 0;
  for (const e of desired) {
    const key = cacheKey(e.type, e.id);
    seen.add(key);
    const hash = await sha256Hex(utf8Bytes(stableStringify(e.entity)));
    if (cache.get(key) === hash) continue;
    await putEntityRemote(username, e.type, e.id, e.entity);
    cache.set(key, hash);
    saved++;
  }

  // 2. Borrado de lo que ya no existe en el estado local (el settings "app" es el marcador
  //    de estado remoto y nunca se borra aquí).
  let deleted = 0;
  for (const type of PORTFOLIO_ENTITY_TYPES) {
    if (type === "settings") continue;
    const remote = await listEntitiesRemote(username, type);
    for (const rec of remote) {
      const key = cacheKey(type, rec.id);
      if (seen.has(key)) continue;
      await deleteEntityRemote(username, type, rec.id);
      cache.delete(key);
      deleted++;
    }
  }

  syncedHashes.set(username, cache);
  return { saved, deleted };
}

/**
 * Hidrata la cartera desde el almacén remoto. Devuelve `null` si la cuenta todavía no tiene
 * estado remoto (cuenta nueva o primera migración desde el legado): en ese caso el llamante
 * conserva su estado local y debe hacer una primera sincronización para sembrar el remoto.
 */
export async function loadPortfolioEntities(username: string): Promise<PortfolioBody | null> {
  const groups = {} as Record<PortfolioEntityType, EntityRecord[]>;
  for (const type of PORTFOLIO_ENTITY_TYPES) {
    groups[type] = await listEntitiesRemote(username, type);
  }
  if (groups.settings.length === 0) return null; // sin marcador: aún no hay estado remoto

  // Caché de sincronización: lo cargado ya está en el remoto.
  const cache = new Map<string, string>();
  for (const type of PORTFOLIO_ENTITY_TYPES) {
    for (const rec of groups[type]) {
      cache.set(cacheKey(type, rec.id), await sha256Hex(utf8Bytes(stableStringify(rec.data))));
    }
  }
  syncedHashes.set(username, cache);
  return entitiesToPortfolio(groups);
}
