// Rutas HTTP del vault. Se montan en /api/vault dentro de la aplicación Express existente
// (server/apiApp.ts), compartida por Vercel (api/[...route].ts) y el servidor local (server.ts).
//
// Enrutado compatible con Vercel:
//  - En Vercel, las rutas ANIDADAS (/api/vault/files/:id, ...) devolvían un 404 de la propia
//    plataforma ANTES de alcanzar Express. La forma que siempre llega al router es la de UN
//    solo segmento de ruta con la operación en la consulta: `/api/vault?op=<operación>[&id=…]`.
//  - Este router incluye la capa de compatibilidad que TRADUCE `?op=` a la ruta interna
//    equivalente (misma petición, mismos controles de autenticación y autorización). La forma
//    anidada clásica sigue funcionando donde sí alcanza Express (local/Render): nada del
//    montaje existente cambia.
//
// Seguridad:
//  - Todas las operaciones de datos exigen token de sesión (Bearer). Los recursos se resuelven
//    SIEMPRE bajo el directorio del usuario del token: no existe ruta que permita leer o
//    escribir datos de otra cuenta.
//  - El contenido binario vive en el almacén remoto PRIVADO; el cliente nunca recibe su URL ni
//    credencial alguna del almacén. Las descargas se sirven autenticadas por este router.
//  - Las subidas directas (archivos grandes) usan una firma de un solo objeto, con operación,
//    tipo y tamaño acotados y caducidad corta; el servidor recalcula el SHA-256 de lo recibido.
//  - Los errores no incluyen datos fiscales ni secretos; la auditoría guarda solo identificadores.
import { Router, Request, Response, NextFunction } from "express";
import { createSessionToken, verifySessionToken, verifySessionClaims, normalizeUsername, passwordProblem, hashPassword } from "./auth.js";
import { VaultConflictError, expenseReferences, propertyReferences, type RemoteDocumentReference } from "./attachmentSafety.js";
import { verifyStorageReference, VaultAttachmentPolicyError, type ServerStorageVerifier } from "./storageVerification.js";
import { buildZip, type ZipEntry } from "./zip.js";
import {
  VaultStorageUnavailableError,
  auditId,
  safeSegment,
  sha256Hex,
  VAULT_MAX_FILE_BYTES,
} from "./persistence.js";
import { isVaultEntityType } from "./persistenceTypes.js";
import type { VaultAuditEvent, VaultFileMeta, VaultPersistence } from "./persistenceTypes.js";

export interface VaultRouterOptions {
  persistence: VaultPersistence;
  storageVerifier?: ServerStorageVerifier;
  /** Secreto HMAC para firmar sesiones. Si no se pasa, se genera/persiste en el almacén. */
  secret?: string;
  /** Firma de subidas directas (solo disponible con almacén remoto). */
  presign?: (opts: {
    username: string;
    fileId: string;
    contentType: string;
    maxBytes: number;
    validUntil: number;
  }) => Promise<{ url: string; headers: Record<string, string>; validUntil: number } | null>;
}

/** Tipos admitidos: espejo de storage.rules (PDF, imágenes y .doc de contratos). */
export function vaultContentTypeProblem(contentType: string): string | null {
  const t = (contentType || "").toLowerCase();
  if (t === "application/pdf" || t === "application/msword") return null;
  if (t.startsWith("image/")) return null;
  return `Tipo no admitido por el vault (${t || "sin tipo"}). Usa PDF, imágenes o .doc de contratos.`;
}

export function vaultFileId(): string {
  return `file_${Date.now()}_${Math.floor(Math.random() * 1e12).toString(36)}`;
}

// ---------- capa de compatibilidad de enrutado (`?op=`) ----------

type VaultOpSpec = {
  /** Métodos HTTP admitidos para la operación. */
  methods: string[];
  /** Ruta interna del router; con `id`, plantilla que lo recibe ya validado. */
  path: string | ((id: string) => string);
  /** La operación necesita `id` en la consulta. */
  requiresId?: boolean;
};

/**
 * Operaciones de la forma compatible `/api/vault?op=<operación>[&id=…]`. Cada una se traduce a
 * la ruta interna equivalente; los nombres explícitos (`files.get`, `files.delete`, ...) y los
 * nombres cortos por recurso+Método (`files`, `backups`, `movimientos`) son equivalentes.
 */
export const VAULT_OPERATION_SPECS: Record<string, VaultOpSpec> = {
  health: { methods: ["GET"], path: "/health" },
  "auth.register": { methods: ["POST"], path: "/auth/register" },
  "auth.login": { methods: ["POST"], path: "/auth/login" },
  "auth.logout": { methods: ["POST"], path: "/auth/logout" },
  "movimientos.get": { methods: ["GET"], path: (id) => `/movimientos/${id}`, requiresId: true },
  "entities.get": { methods: ["GET"], path: (id) => `/entities/${id}`, requiresId: true },
  session: { methods: ["GET"], path: "/session" },
  movimientos: { methods: ["GET", "PUT"], path: "/movimientos" },
  "movimientos.save": { methods: ["PUT"], path: (id) => `/movimientos/${id}`, requiresId: true },
  "entities.list": { methods: ["GET"], path: "/entities" },
  "entities.put": { methods: ["POST"], path: "/entities" },
  "entities.delete": { methods: ["DELETE"], path: (id) => `/entities/${id}`, requiresId: true },
  files: { methods: ["GET", "POST"], path: "/files" },
  "files.list": { methods: ["GET"], path: "/files" },
  "files.upload": { methods: ["POST"], path: "/files" },
  "files.presign": { methods: ["POST"], path: "/files/presign" },
  "files.commit": { methods: ["POST"], path: (id) => `/files/${id}/commit`, requiresId: true },
  "files.verify": { methods: ["GET"], path: (id) => `/files/${id}/verify`, requiresId: true },
  "files.get": { methods: ["GET"], path: (id) => `/files/${id}`, requiresId: true },
  "files.delete": { methods: ["DELETE"], path: (id) => `/files/${id}`, requiresId: true },
  expediente: { methods: ["GET"], path: "/expediente" },
  "expediente.zip": { methods: ["GET"], path: "/expediente.zip" },
  backups: { methods: ["GET", "POST"], path: "/backups" },
  "backups.list": { methods: ["GET"], path: "/backups" },
  "backups.create": { methods: ["POST"], path: "/backups" },
  "backups.get": { methods: ["GET"], path: (id) => `/backups/${id}`, requiresId: true },
  audit: { methods: ["GET"], path: "/audit" },
};

export type VaultOpResolution = { path: string } | { status: number; error: string };

/**
 * Resuelve `?op=<operación>[&id=…]` a la ruta interna del router, o a un error explícito.
 * No hay silencio: operación desconocida, método no admitido o identificador ausente/manipulado
 * se rechazan con un mensaje claro (nunca se degradan a un 404 genérico de plataforma).
 */
export function resolveVaultOperation(op: string, method: string, id: string): VaultOpResolution {
  const spec = VAULT_OPERATION_SPECS[op];
  const httpMethod = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  if (!spec) {
    return {
      status: 400,
      error: `Operación no admitida en el almacén remoto (${op}). Usa /api/vault?op=<operación>[&id=…].`,
    };
  }
  if (!spec.methods.includes(httpMethod)) {
    return {
      status: 405,
      error: `La operación ${op} no admite el método ${httpMethod} (admitidos: ${spec.methods.join(", ")}).`,
    };
  }
  if (typeof spec.path === "string") return { path: spec.path };
  const clean = safeSegment(id);
  if (!clean) {
    return {
      status: 400,
      error: `La operación ${op} necesita un identificador válido (?id=…: letras, números, guiones).`,
    };
  }
  return { path: spec.path(encodeURIComponent(clean)) };
}

/** Extrae y valida el usuario del token Bearer. */
async function authedUser(req: Request, persistence: VaultPersistence, secret: string): Promise<string | null> {
  const header = req.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const user = verifySessionToken(secret, m[1].trim());
  if (!user) return null;
  // Defensa en profundidad: el usuario del token debe existir.
  const record = await persistence.getUser(user);
  if (!record || await persistence.isSessionRevoked(user, sha256Hex(new TextEncoder().encode(m[1].trim())))) return null;
  return user;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ ok: false, error: message });
}

export function createVaultRouter(options: VaultRouterOptions): Router {
  const { persistence } = options;
  const router = Router();
  let secretPromise: Promise<string> | null = options.secret ? Promise.resolve(options.secret) : null;

  const getSecret = (): Promise<string> => {
    if (!secretPromise) secretPromise = persistence.ensureSecret();
    return secretPromise;
  };

  const audit = async (
    username: string,
    event: Omit<VaultAuditEvent, "id" | "at" | "actor">
  ): Promise<void> => {
    try {
      await persistence.appendAudit(username, {
        id: auditId(),
        at: new Date().toISOString(),
        actor: username,
        ...event,
      });
    } catch {
      // La auditoría es accesoria: su fallo no debe tumbar la operación principal ni
      // provocar un falso éxito (la operación ya se ha confirmado con el almacén).
    }
  };

  const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const secret = await getSecret();
      const user = await authedUser(req, persistence, secret);
      if (!user) {
        res.status(401).json({ ok: false, error: "Sesión no válida o caducada. Inicia sesión de nuevo." });
        return;
      }
      (req as any).vaultUser = user;
      next();
    } catch (err) {
      next(err);
    }
  };

  const verifyReference = async (actor: string, source: RemoteDocumentReference): Promise<void> => {
    if (source.vaultId && source.storagePath) throw new VaultAttachmentPolicyError("attachment/ambiguous-provider", "El documento mezcla proveedores; no se confirma.");
    if (source.vaultId) {
      if (!safeSegment(source.vaultId)) throw new VaultAttachmentPolicyError("attachment/invalid-reference", "Identificador de documento no válido.");
      const stored = await readVerifiedFile(persistence, actor, source.vaultId);
      if (!stored) throw new VaultAttachmentPolicyError("attachment/required", "El documento obligatorio no existe o no está confirmado para esta cuenta.");
      if ((stored.meta.propertyId && source.propertyId && stored.meta.propertyId !== source.propertyId) ||
          (stored.meta.movementId && source.movementId && stored.meta.movementId !== source.movementId))
        throw new VaultAttachmentPolicyError("attachment/association-conflict", "El documento pertenece a otro inmueble o gasto.");
    } else if (source.storagePath) await verifyStorageReference(actor, source, options.storageVerifier);
    else throw new VaultAttachmentPolicyError("attachment/required", "Falta el documento remoto obligatorio.");
  };
  const verifyMovement = async (actor: string, movement: any): Promise<void> => {
    const refs = expenseReferences(movement); if (!refs.length) return;
    if (!safeSegment(movement?.id) || !safeSegment(movement?.propertyId)) throw new VaultAttachmentPolicyError("attachment/invalid-reference", "ID de gasto/inmueble no válido.");
    const property = await persistence.getEntity(actor, "properties", movement.propertyId);
    if (!property || (property.data as any)?.id !== movement.propertyId) throw new VaultAttachmentPolicyError("attachment/parent-not-found", "El inmueble no existe en la cartera autorizada.");
    for (const ref of refs) await verifyReference(actor, ref);
  };
  const verifyProperty = async (actor: string, id: string, entity: any): Promise<void> => {
    const refs = propertyReferences(entity);
    if (!refs.length) return;
    if (entity.id !== id) throw new VaultAttachmentPolicyError("attachment/invalid-reference", "La entidad y los documentos no corresponden al mismo inmueble.");
    for (const ref of refs) await verifyReference(actor, { ...ref, propertyId: id });
  };

  // ---------- traducción de la forma compatible (?op=) ----------
  // Debe registrarse ANTES que ninguna ruta: traduce `/api/vault?op=…&id=…` a la ruta interna
  // equivalente y continúa el despacho normal del router (mismos middlewares y controles).
  router.use((req: Request, res: Response, next: NextFunction) => {
    try {
      const opValue = req.query.op;
      if (opValue === undefined) return next(); // forma anidada clásica: sin traducción
      // La forma compatible es de un solo segmento: no se admite combinarla con una ruta anidada.
      const residual = (req.url.split("?")[0] || "/").replace(/\/+$/, "") || "/";
      if (residual !== "/") {
        return res.status(400).json({
          ok: false,
          error: "Usa /api/vault?op=<operación>[&id=…] (sin ruta anidada) o la ruta anidada clásica, no ambas.",
        });
      }
      if (typeof opValue !== "string") {
        return res.status(400).json({ ok: false, error: "Indica una única operación (?op=…)." });
      }
      const idValue = req.query.id;
      if (idValue !== undefined && typeof idValue !== "string") {
        return res.status(400).json({ ok: false, error: "Indica un único identificador (?id=…)." });
      }
      const resolved = resolveVaultOperation(opValue, req.method, typeof idValue === "string" ? idValue : "");
      if ("error" in resolved) {
        return res.status(resolved.status).json({ ok: false, error: resolved.error });
      }
      // El resto de la consulta (from, to, limit…) se conserva; op e id ya van en la ruta.
      const rest = new URLSearchParams();
      for (const key of Object.keys(req.query)) {
        if (key === "op" || key === "id") continue;
        const value = (req.query as Record<string, unknown>)[key];
        if (typeof value === "string") rest.set(key, value);
      }
      const qs = rest.toString();
      req.url = resolved.path + (qs ? `?${qs}` : "");
      next();
    } catch (err) {
      next(err);
    }
  });

  // ---------- abiertos ----------

  /**
   * Salud y capacidades. No expone información de cuentas: solo el estado del destino y los
   * límites admitidos, para que la interfaz pueda avisar antes de intentar una subida.
   */
  router.get("/health", async (_req, res) => {
    const probe = await persistence.probe().catch((err) => ({ ok: false, detail: String(err?.message || err) }));
    res.json({
      ok: true,
      vault: "ok",
      durable: persistence.durable,
      driver: persistence.driver,
      storageOk: probe.ok,
      ...(probe.ok ? {} : { detail: probe.detail }),
      maxFileBytes: VAULT_MAX_FILE_BYTES,
      directUpload: Boolean(options.presign),
    });
  });

  router.post("/auth/register", async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const password = req.body?.password;
      if (!username) return badRequest(res, "Nombre de usuario no válido (3-64 caracteres: letras, números, guiones).");
      const passProblem = passwordProblem(password);
      if (passProblem) return badRequest(res, passProblem);
      const { salt, hash } = hashPassword(password);
      const created = await persistence.createUser(username, {
        salt,
        hash,
        createdAt: new Date().toISOString(),
      });
      if (!created) return res.status(409).json({ ok: false, error: "Este nombre de usuario ya está registrado." });
      await audit(username, { action: "user.register", ok: true });
      res.status(201).json({ ok: true, username });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/login", async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const password = req.body?.password;
      if (!username || typeof password !== "string") return badRequest(res, "Credenciales incompletas.");
      const record = await persistence.getUser(username);
      const { verifyPassword } = await import("./auth.js");
      const ok = record ? verifyPassword(password, record.salt, record.hash) : false;
      if (!ok) {
        // Solo se audita el intento fallido si la cuenta existe: así no se puede escribir
        // en la trazabilidad de otra cuenta conociendo su nombre.
        if (record) await audit(username, { action: "user.login", ok: false, detail: "credenciales" });
        return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrectos." });
      }
      const secret = await getSecret();
      const token = createSessionToken(secret, username);
      await audit(username, { action: "user.login", ok: true });
      res.json({ ok: true, username, token });
    } catch (err) {
      next(err);
    }
  });

  router.post("/auth/logout", requireAuth, async (req: Request, res, next) => {
    try {
      const raw = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "")?.[1]?.trim();
      if (!raw) return res.status(401).json({ ok: false, error: "Sesión no válida." });
      const claims = verifySessionClaims(await getSecret(), raw);
      if (!claims || claims.sub !== (req as any).vaultUser) return res.status(401).json({ ok: false, error: "Sesión no válida." });
      // Nunca usa token/usuario del body ni rota una clave compartida.
      await persistence.revokeSession({ username: claims.sub, tokenHash: sha256Hex(new TextEncoder().encode(raw)), expiresAt: claims.exp });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ---------- autenticados ----------
  router.get("/session", requireAuth, (req: Request, res) => {
    res.json({
      ok: true,
      username: (req as any).vaultUser,
      durable: persistence.durable,
      driver: persistence.driver,
    });
  });

  router.get("/movimientos", requireAuth, async (req: Request, res, next) => {
    try {
      const movements = await persistence.getMovements((req as any).vaultUser);
      res.json({ ok: true, movements });
    } catch (err) {
      next(err);
    }
  });

  router.get("/movimientos/:movementId", requireAuth, async (req: Request, res, next) => {
    try {
      const row = await persistence.getMovement((req as any).vaultUser, req.params.movementId);
      if (!row) return res.status(404).json({ ok: false, error: "El gasto no existe en esta cartera." });
      res.setHeader("etag", row.version); res.setHeader("cache-control", "private, no-store");
      res.json({ ok: true, movement: row.data, version: row.version });
    } catch (err) { next(err); }
  });

  router.put("/movimientos", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const movements = req.body?.movements;
      if (!Array.isArray(movements)) return badRequest(res, "Se espera una lista de movimientos.");
      if (movements.length > 20_000) return badRequest(res, "Demasiados movimientos en una sola sincronización.");
      // Prevalidación de todo el batch; no confiar en flags opcionales de validación.
      for (const movement of movements) await verifyMovement(user, movement);
      const saved = await persistence.putMovements(user, movements, {
        validate: async () => { for (const movement of movements) await verifyMovement(user, movement); },
      });
      await audit(user, { action: "movements.put", ok: true, detail: `${saved} movimientos` });
      res.json({ ok: true, saved });
    } catch (err) {
      next(err);
    }
  });

  /** Guarda UN movimiento con adjunto. Comprueba archivo/asociación y relee la escritura. */
  router.put("/movimientos/:movementId", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const movement = req.body?.movement;
      if (!safeSegment(req.params.movementId) || !movement || movement.id !== req.params.movementId ||
          typeof movement.propertyId !== "string" || !movement.propertyId) {
        return badRequest(res, "Identificador de operación o inmueble no válido.");
      }
      if (!expenseReferences(movement).length) return badRequest(res, "Falta el comprobante remoto obligatorio.");
      await verifyMovement(user, movement);
      await persistence.putMovements(user, [movement], { expectedVersion: req.get("if-match") || undefined,
        validate: async () => verifyMovement(user, movement) });
      const persisted = (await persistence.getMovements(user)).find((m) => m.id === movement.id);
      if (!persisted || JSON.stringify(persisted) !== JSON.stringify(movement)) {
        throw new VaultStorageUnavailableError("El almacén no ha confirmado la asociación y persistencia de la operación.");
      }
      await verifyMovement(user, persisted);
      await audit(user, { action: "movements.put", ok: true, target: movement.id, detail: "adjunto y operación confirmados" });
      res.json({ ok: true, storageOk: true, movement: persisted });
    } catch (err) { next(err); }
  });

  /**
   * Entidades estructuradas de la cartera (titulares, inmuebles, contratos, recibos, ajustes).
   * Una entidad es un objeto JSON por identificador bajo la cuenta del token: reintentar es
   * idempotente y las relaciones viajan por identificador dentro del objeto (propertyId, …).
   */
  router.get("/entities", requireAuth, async (req: Request, res, next) => {
    try {
      const type = req.query.type;
      if (!isVaultEntityType(type)) {
        return badRequest(res, "Tipo de entidad no admitido (owners, properties, contracts, payments, settings).");
      }
      res.json({ ok: true, type, entities: await persistence.listEntities((req as any).vaultUser, type) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/entities/:id", requireAuth, async (req: Request, res, next) => {
    try {
      if (!isVaultEntityType(req.query.type)) return badRequest(res, "Tipo de entidad no admitido.");
      const row = await persistence.getEntity((req as any).vaultUser, req.query.type, req.params.id);
      if (!row) return res.status(404).json({ ok: false, error: "La entidad no existe en esta cartera." });
      res.setHeader("etag", row.version!); res.setHeader("cache-control", "private, no-store");
      res.json({ ok: true, entity: row });
    } catch (err) { next(err); }
  });

  router.post("/entities", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const { type, id, entity } = req.body ?? {};
      if (!isVaultEntityType(type)) {
        return badRequest(res, "Tipo de entidad no admitido (owners, properties, contracts, payments, settings).");
      }
      const clean = safeSegment(id);
      if (!clean) return badRequest(res, "Identificador de entidad no válido (letras, números, guiones).");
      if (entity === null || typeof entity !== "object") {
        return badRequest(res, "Falta el contenido de la entidad (entity: objeto JSON).");
      }
      const attachmentIds = req.body?.attachmentIds;
      if (attachmentIds !== undefined && (type !== "properties" || entity.id !== clean || !Array.isArray(attachmentIds) || attachmentIds.length > 20))
        return badRequest(res, "La asociación requiere una entidad válida.");
      if (type === "properties") {
        await verifyProperty(user, clean, entity);
        // El parámetro sigue como comprobación adicional; NO selecciona qué referencias verificar.
        const all = new Set(propertyReferences(entity).map((r) => r.vaultId).filter(Boolean));
        if (attachmentIds?.some((fileId: any) => !all.has(fileId))) return badRequest(res, "El documento no está asociado al inmueble.");
      }
      const record = await persistence.putEntity(user, type, clean, entity, { expectedVersion: req.get("if-match") || undefined,
        validate: async () => { if (type === "properties") await verifyProperty(user, clean, entity); } });
      if (type === "properties" && propertyReferences(entity).length) {
        const persisted = await persistence.getEntity(user, type, clean);
        if (!persisted || JSON.stringify(persisted.data) !== JSON.stringify(entity)) throw new VaultStorageUnavailableError("No se han confirmado los documentos del inmueble.");
        await verifyProperty(user, clean, persisted.data);
      }
      await audit(user, { action: "entity.put", ok: true, target: `${type}:${clean}` });
      res.status(201).json({ ok: true, entity: record });
    } catch (err: any) {
      if (err instanceof Error && /no admitido|no válido|límite/i.test(err.message)) return badRequest(res, err.message);
      next(err);
    }
  });

  router.delete("/entities/:id", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const type = req.query.type;
      if (!isVaultEntityType(type)) {
        return badRequest(res, "Tipo de entidad no admitido (owners, properties, contracts, payments, settings).");
      }
      const deleted = await persistence.deleteEntity(user, type, req.params.id, { expectedVersion: req.get("if-match") || undefined,
        validate: async () => {
          if (type === "properties" && (await persistence.getMovements(user)).some((m) => m.propertyId === req.params.id && expenseReferences(m).length))
            throw new VaultConflictError("El inmueble mantiene gastos con documentos; no se borra desde un snapshot.");
        } });
      if (!deleted) {
        res.status(404).json({ ok: false, error: "La entidad no existe para esta cuenta." });
        return;
      }
      await audit(user, { action: "entity.delete", ok: true, target: `${type}:${req.params.id}` });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.get("/files", requireAuth, async (req: Request, res, next) => {
    try {
      const files = await persistence.listFiles((req as any).vaultUser);
      res.json({ ok: true, files: files.map(publicFileMeta) });
    } catch (err) {
      next(err);
    }
  });

  /** Subida en el cuerpo de la petición (archivos pequeños/medianos): el servidor calcula el hash. */
  router.post("/files", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const { name, contentType, bytesBase64, movementId, propertyId, id } = req.body ?? {};
      if (typeof bytesBase64 !== "string" || !bytesBase64) return badRequest(res, "Falta el contenido del archivo (bytesBase64).");
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(Buffer.from(bytesBase64, "base64"));
      } catch {
        return badRequest(res, "Contenido Base64 no válido.");
      }
      if (bytes.length === 0) return badRequest(res, "El archivo está vacío.");
      if (bytes.length > VAULT_MAX_FILE_BYTES) {
        return res.status(413).json({ ok: false, error: "El archivo supera el límite de 10 MB." });
      }
      const meta = await storeNewFile(persistence, {
        username: user,
        id: typeof id === "string" ? id : undefined,
        name: typeof name === "string" ? name : "archivo",
        contentType: typeof contentType === "string" ? contentType : "",
        bytes,
        movementId: typeof movementId === "string" ? movementId : undefined,
        propertyId: typeof propertyId === "string" ? propertyId : undefined,
      });
      await audit(user, { action: "file.upload", ok: true, target: meta.id, detail: `${meta.size} bytes` });
      res.status(201).json({ ok: true, file: publicFileMeta(meta), storageOk: true });
    } catch (err: any) {
      if (!(err instanceof VaultConflictError) && err instanceof Error && /límite|tipo no admitido|identificador|sobrescribe/i.test(err.message)) {
        return badRequest(res, err.message);
      }
      next(err);
    }
  });

  /**
   * Firma de una subida directa: el servidor decide el pathname, reserva el identificador y
   * acota operación, tipo, tamaño y caducidad. El navegador nunca ve credenciales del almacén.
   */
  router.post("/files/presign", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      if (!options.presign) {
        return res.status(501).json({ ok: false, error: "La subida directa no está disponible en este despliegue." });
      }
      const { name, contentType, size, movementId, propertyId, id, sha256 } = req.body ?? {};
      const typeProblem = vaultContentTypeProblem(typeof contentType === "string" ? contentType : "");
      if (typeProblem) return badRequest(res, typeProblem);
      const sizeNum = Number(size);
      if (!Number.isInteger(sizeNum) || sizeNum <= 0) return badRequest(res, "Tamaño de archivo no válido.");
      if (sizeNum > VAULT_MAX_FILE_BYTES) return res.status(413).json({ ok: false, error: "El archivo supera el límite de 10 MB." });
      if (id !== undefined && !safeSegment(id)) return badRequest(res, "Identificador de archivo no válido.");
      if (sha256 !== undefined && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))) {
        return badRequest(res, "Resumen SHA-256 no válido.");
      }
      if (id === undefined && !sha256) return badRequest(res, "La subida directa legacy requiere SHA-256 antes de reservar; no se genera un ID aleatorio.");
      const fileId = id ?? legacyFileId({ name, contentType, sha256, movementId, propertyId });
      const existing = await persistence.getFileMeta(user, fileId);
      if (existing) {
        if (existing.size !== sizeNum || existing.contentType !== contentType ||
            (existing.sha256 && existing.sha256 !== sha256) ||
            (existing.uploadSha256 && existing.uploadSha256 !== sha256) ||
            (typeof movementId === "string" && existing.movementId !== movementId) ||
            (typeof propertyId === "string" && existing.propertyId !== propertyId)) {
          return res.status(409).json({ ok: false, error: "La reserva corresponde a otro archivo o asociación; no se sobrescribe." });
        }
        const bytes = await persistence.readFileBytes(user, fileId);
        if (bytes) {
          if (bytes.length !== sizeNum || (sha256 && sha256Hex(bytes) !== sha256)) {
            return res.status(409).json({ ok: false, error: "El objeto existente no coincide con el archivo; no se sobrescribe ni elimina." });
          }
          return res.json({ ok: true, fileId, ...(existing.sha256 ? { alreadyCommitted: true } : { readyToCommit: true }) });
        }
        if (existing.sha256) return res.status(409).json({ ok: false, error: "El objeto confirmado ya no está disponible." });
      }
      const validUntil = Date.now() + 10 * 60 * 1000;
      const signed = await options.presign({ username: user, fileId, contentType,
        maxBytes: Math.min(VAULT_MAX_FILE_BYTES, sizeNum), validUntil });
      if (!signed) return res.status(501).json({ ok: false, error: "La subida directa no está disponible en este despliegue." });
      if (!existing) {
        try { await persistence.putFileMeta(user, {
          id: fileId, name: typeof name === "string" ? name.slice(0, 200) : "archivo",
          contentType, size: sizeNum, sha256: "", createdAt: new Date().toISOString(),
          ...(typeof movementId === "string" ? { movementId } : {}),
          ...(typeof propertyId === "string" ? { propertyId } : {}),
          ...(sha256 ? { uploadSha256: sha256 } : {}), sha256VerifiedBy: "server",
        }); } catch (err) {
          if (!(err instanceof VaultConflictError)) throw err;
          const concurrent = await persistence.getFileMeta(user, fileId);
          if (!concurrent || concurrent.size !== sizeNum || concurrent.contentType !== contentType || concurrent.uploadSha256 !== sha256 ||
              concurrent.movementId !== movementId || concurrent.propertyId !== propertyId) throw err;
        }
      }
      await audit(user, { action: "file.upload.direct", ok: true, target: fileId, detail: "firma emitida" });
      res.status(201).json({ ok: true, fileId, upload: signed });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Confirma una subida directa: el servidor descarga el objeto del almacén privado, recalcula
   * el SHA-256 y solo entonces consolida los metadatos. Si el objeto no está o el hash no
   * coincide, la subida NO se declara completada.
   */
  router.post("/files/:fileId/commit", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const meta = await persistence.getFileMeta(user, req.params.fileId);
      if (!meta) return res.status(404).json({ ok: false, error: "La subida no está reservada para esta cuenta." });

      const bytes = await persistence.readFileBytes(user, req.params.fileId);
      if (!bytes || bytes.length === 0) {
        return res.status(409).json({
          ok: false,
          error: "El archivo no está en el almacenamiento remoto: la subida no se ha completado.",
        });
      }
      const declared = Number(req.body?.size);
      if (Number.isFinite(declared) && declared > 0 && declared !== bytes.length) {
        return badRequest(res, "El tamaño declarado no coincide con el archivo recibido.");
      }
      const clientSha = typeof req.body?.sha256 === "string" ? req.body.sha256.toLowerCase() : "";
      const serverSha = sha256Hex(bytes);
      if ((clientSha && clientSha !== serverSha) || (meta.uploadSha256 && meta.uploadSha256 !== serverSha) ||
          (meta.sha256 && meta.sha256 !== serverSha) || bytes.length !== meta.size) {
        return badRequest(res, "El archivo recibido no coincide con su resumen SHA-256 o tamaño. No se confirma, sobrescribe ni elimina el objeto.");
      }
      if (meta.sha256) return res.json({ ok: true, file: publicFileMeta(meta), storageOk: true, alreadyCommitted: true });
      const committed: VaultFileMeta = { ...meta, size: bytes.length, sha256: serverSha, sha256VerifiedBy: "server" };
      await persistence.putFileMeta(user, committed);
      const persisted = await persistence.getFileMeta(user, committed.id);
      if (!persisted || persisted.sha256 !== serverSha) throw new VaultStorageUnavailableError("No se han confirmado los metadatos del archivo.");
      await audit(user, { action: "file.upload", ok: true, target: meta.id, detail: `${bytes.length} bytes (directa, verificada)` });
      res.json({ ok: true, file: publicFileMeta(committed), storageOk: true, sha256: serverSha });
    } catch (err) {
      next(err);
    }
  });

  router.get("/files/:fileId/verify", requireAuth, async (req: Request, res, next) => {
    try {
      const stored = await readVerifiedFile(persistence, (req as any).vaultUser, req.params.fileId);
      if (!stored) return res.status(404).json({ ok: false, error: "El archivo no está confirmado o no existe para esta cuenta." });
      res.setHeader("cache-control", "private, no-store");
      res.json({ ok: true, storageOk: true, file: publicFileMeta(stored.meta) });
    } catch (err) { next(err); }
  });

  router.get("/files/:fileId", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const meta = await persistence.getFileMeta(user, req.params.fileId);
      if (!meta || !meta.sha256) {
        res.status(404).json({ ok: false, error: "El archivo no existe para esta cuenta." });
        return;
      }
      const bytes = await persistence.readFileBytes(user, req.params.fileId);
      if (!bytes) {
        res.status(404).json({ ok: false, error: "El archivo no existe para esta cuenta." });
        return;
      }
      // Integridad a la salida: si el objeto almacenado no coincide con su hash, no se sirve.
      const actual = sha256Hex(bytes);
      if (actual !== meta.sha256) {
        res.status(502).json({ ok: false, error: "El archivo almacenado no supera la verificación de integridad." });
        return;
      }
      res.setHeader("content-type", meta.contentType || "application/octet-stream");
      res.setHeader("content-length", String(bytes.length));
      res.setHeader("content-disposition", `attachment; filename="${encodeURIComponent(meta.name).replace(/["\\]/g, "")}"`);
      res.setHeader("x-vault-sha256", meta.sha256);
      res.setHeader("cache-control", "private, no-store");
      await audit(user, { action: "file.download", ok: true, target: meta.id });
      res.status(200).end(Buffer.from(bytes));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/files/:fileId", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      // Compatibilidad legacy: las referencias anteriores al pin también se conservan.
      const movements = await persistence.getMovements(user);
      const properties = await persistence.listEntities(user, "properties");
      if (movements.some((m) => expenseReferences(m).some((r) => r.vaultId === req.params.fileId)) ||
          properties.some((p) => propertyReferences(p.data).some((r) => r.vaultId === req.params.fileId)))
        throw new VaultConflictError("El documento mantiene una asociación confirmada; no se retira.");
      const deleted = await persistence.deleteFileMeta(user, req.params.fileId);
      if (!deleted) return res.status(404).json({ ok: false, error: "El archivo no existe para esta cuenta." });
      // Retirada lógica: el CAS protege contra un enlace concurrente. No borrar bytes.
      await audit(user, { action: "file.delete", ok: true, target: req.params.fileId, detail: "retirada lógica, bytes conservados" });
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // ---------- expediente fiscal ----------
  const filterByRange = (movements: Record<string, any>[], from: string, to: string) =>
    movements.filter((m: any) => {
      const date = typeof m?.date === "string" ? m.date : "";
      if (from && date < from) return false;
      if (to && date > to) return false;
      return true;
    });

  router.get("/expediente", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const from = typeof req.query.from === "string" ? req.query.from : "";
      const to = typeof req.query.to === "string" ? req.query.to : "";
      const movements = filterByRange(await persistence.getMovements(user), from, to);
      const files = await persistence.listFiles(user);
      await audit(user, { action: "expediente.export", ok: true, detail: `${movements.length} movimientos` });
      res.json({ ok: true, username: user, from, to, movements, files: files.map(publicFileMeta) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/expediente.zip", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const from = typeof req.query.from === "string" ? req.query.from : "";
      const to = typeof req.query.to === "string" ? req.query.to : "";
      const filtered = filterByRange(await persistence.getMovements(user), from, to);
      for (const movement of filtered) await verifyMovement(user, movement);
      const allFiles = await persistence.listFiles(user);
      const hasRange = Boolean(from || to);
      let included = allFiles;
      if (hasRange) {
        const movementIds = new Set(filtered.map((m: any) => m?.id).filter(Boolean));
        // Referencias reales, no una expresión regular ligada al prefijo histórico file_.
        const referenced = new Set(filtered.flatMap((m: any) => expenseReferences(m).flatMap((r) => r.vaultId ? [r.vaultId] : [])));
        included = allFiles.filter((f) => (f.movementId && movementIds.has(f.movementId)) || referenced.has(f.id));
      }

      const entries: ZipEntry[] = [
        {
          name: "movimientos.json",
          bytes: new TextEncoder().encode(
            JSON.stringify({ username: user, from, to, exportedAt: new Date().toISOString(), movements: filtered }, null, 2)
          ),
        },
        { name: "archivos.json", bytes: new TextEncoder().encode(JSON.stringify({ files: included.map(publicFileMeta) }, null, 2)) },
      ];
      const usedNames = new Set<string>();
      for (const meta of included) {
        const verified = await readVerifiedFile(persistence, user, meta.id);
        if (!verified) throw new VaultAttachmentPolicyError("attachment/unconfirmed", "El expediente contiene una reserva o documento no confirmado.");
        if (verified.meta.propertyId) {
          const parent = await persistence.getEntity(user, "properties", verified.meta.propertyId);
          if (!parent) throw new VaultAttachmentPolicyError("attachment/parent-not-found", "El documento del expediente no tiene inmueble autorizado.");
          if (!verified.meta.movementId && !propertyReferences(parent.data).some((r) => r.vaultId === meta.id))
            throw new VaultAttachmentPolicyError("attachment/association-conflict", "El documento no figura en las asociaciones confirmadas de su inmueble.");
        }
        if (!verified.meta.movementId && !verified.meta.propertyId)
          throw new VaultAttachmentPolicyError("attachment/association-conflict", "El objeto carece de contexto patrimonial confirmado; no se exporta como documento asociado.");
        if (verified.meta.movementId) {
          const related = await persistence.getMovement(user, verified.meta.movementId);
          if (!related || !expenseReferences(related.data).some((r) => r.vaultId === meta.id) || (meta.propertyId && related.data.propertyId !== meta.propertyId))
            throw new VaultAttachmentPolicyError("attachment/association-conflict", "El documento no corresponde al gasto del expediente.");
        }
        const got = verified.bytes;
        const clean = (meta.name || "archivo").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 80);
        let entryName = `archivos/${meta.id}_${clean}`;
        let n = 1;
        while (usedNames.has(entryName)) entryName = `archivos/${meta.id}_${n++}_${clean}`;
        usedNames.add(entryName);
        entries.push({ name: entryName, bytes: got });
      }

      const zip = buildZip(entries);
      await audit(user, { action: "expediente.export", ok: true, detail: `ZIP con ${included.length} documentos` });
      res.setHeader("content-type", "application/zip");
      res.setHeader(
        "content-disposition",
        `attachment; filename="expediente_${user}_${from || "inicio"}_${to || "fin"}.zip"`
      );
      res.send(zip);
    } catch (err) {
      next(err);
    }
  });

  // ---------- copias de seguridad y auditoría ----------
  router.post("/backups", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const portfolio = req.body?.portfolio;
      if (portfolio == null) return badRequest(res, "Falta la cartera a copiar.");
      const createdAt = new Date().toISOString();
      const id = safeSegment(req.body?.id) || `backup_${createdAt.replace(/[^0-9]/g, "")}`;
      const created = await persistence.createBackup(user, id, portfolio);
      await audit(user, { action: "backup.create", ok: true, target: created.id, detail: `${created.size} bytes` });
      res.status(201).json({ ok: true, ...created });
    } catch (err: any) {
      if (err instanceof Error && /límite/i.test(err.message)) return badRequest(res, err.message);
      next(err);
    }
  });

  router.get("/backups", requireAuth, async (req: Request, res, next) => {
    try {
      res.json({ ok: true, backups: await persistence.listBackups((req as any).vaultUser) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/backups/:id", requireAuth, async (req: Request, res, next) => {
    try {
      const portfolio = await persistence.getBackup((req as any).vaultUser, req.params.id);
      if (portfolio == null) {
        res.status(404).json({ ok: false, error: "La copia no existe para esta cuenta." });
        return;
      }
      res.json({ ok: true, portfolio });
    } catch (err) {
      next(err);
    }
  });

  /** Trazabilidad de las operaciones relevantes de la propia cuenta. */
  router.get("/audit", requireAuth, async (req: Request, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
      res.json({ ok: true, events: await persistence.listAudit((req as any).vaultUser, limit) });
    } catch (err) {
      next(err);
    }
  });

  router.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof VaultConflictError) return res.status(409).json({ ok: false, code: err.code, error: err.message });
    if (err instanceof VaultAttachmentPolicyError) return res.status(err.status).json({ ok: false, code: err.code, error: err.message });
    next(err);
  });
  return router;
}

/** Metadatos que SÍ pueden salir al cliente (nunca la ruta interna del objeto). */
export function publicFileMeta(meta: VaultFileMeta): Omit<VaultFileMeta, "blobPathname" | "uploadSha256"> {
  const { blobPathname: _omit, uploadSha256: _reservation, attachmentProtected: _pin, deletedAt: _retired, ...rest } = meta;
  return rest;
}

async function readVerifiedFile(persistence: VaultPersistence, user: string, id: string): Promise<{ meta: VaultFileMeta; bytes: Uint8Array } | null> {
  const meta = await persistence.getFileMeta(user, id);
  if (!meta || !meta.sha256) return null;
  const bytes = await persistence.readFileBytes(user, id);
  if (!bytes) return null;
  if (bytes.length !== meta.size || sha256Hex(bytes) !== meta.sha256) {
    throw new VaultStorageUnavailableError("El archivo almacenado no supera la verificación de integridad.");
  }
  return { meta, bytes };
}

function legacyFileId(opts: { name?: unknown; contentType?: unknown; sha256?: unknown; movementId?: unknown; propertyId?: unknown }): string {
  return `file_${sha256Hex(new TextEncoder().encode(JSON.stringify([
    opts.name ?? "archivo", opts.contentType ?? "", opts.movementId ?? "", opts.propertyId ?? "", opts.sha256,
  ])))}`;
}

/**
 * Guarda un archivo nuevo: valida, comprueba idempotencia por hash y NO escribe metadatos
 * hasta que el contenido está en el almacén remoto.
 */
export async function storeNewFile(
  persistence: VaultPersistence,
  opts: {
    username: string;
    id?: string;
    name: string;
    contentType: string;
    bytes: Uint8Array;
    movementId?: string;
    propertyId?: string;
  }
): Promise<VaultFileMeta> {
  if (opts.bytes.length > VAULT_MAX_FILE_BYTES) throw new Error("El archivo supera el límite de 10 MB del vault.");
  const typeProblem = vaultContentTypeProblem(opts.contentType);
  if (typeProblem) throw new Error(typeProblem);

  const id = opts.id ? safeSegment(opts.id) : legacyFileId({ ...opts, sha256: sha256Hex(opts.bytes) });
  if (!id) throw new Error("Identificador de archivo no válido.");
  const sha = sha256Hex(opts.bytes);

  const existing = await persistence.getFileMeta(opts.username, id);
  if (existing && (existing.size !== opts.bytes.length || existing.contentType !== opts.contentType ||
      (existing.sha256 && existing.sha256 !== sha) || (existing.uploadSha256 && existing.uploadSha256 !== sha) ||
      (opts.movementId !== undefined && existing.movementId !== opts.movementId) ||
      (opts.propertyId !== undefined && existing.propertyId !== opts.propertyId))) {
    throw new Error("Ya existe un archivo distinto o asociado a otra operación/inmueble; no se sobrescribe.");
  }
  const storedBytes = await persistence.readFileBytes(opts.username, id);
  if (storedBytes) {
    if (storedBytes.length !== opts.bytes.length || sha256Hex(storedBytes) !== sha) {
      throw new Error("Ya existe un archivo distinto con ese identificador; no se sobrescribe.");
    }
    if (existing?.sha256) return existing;
  } else {
    if (existing?.sha256) throw new VaultStorageUnavailableError("El documento confirmado ya no está en el almacén. No se sustituye automáticamente.");
    try { await persistence.writeFileBytes(opts.username, id, opts.bytes, opts.contentType, true); }
    catch (err) {
      if (!(err instanceof VaultConflictError) && (err as any)?.code !== "EEXIST") throw err;
      const concurrent = await persistence.readFileBytes(opts.username, id);
      if (!concurrent || sha256Hex(concurrent) !== sha) throw err;
    }
  }
  const readBack = await persistence.readFileBytes(opts.username, id);
  if (!readBack || sha256Hex(readBack) !== sha) {
    throw new VaultStorageUnavailableError(
      "El archivo no se ha podido confirmar en el almacenamiento remoto; la subida no se ha completado."
    );
  }

  const meta: VaultFileMeta = {
    id,
    name: String(opts.name || "archivo").slice(0, 200),
    contentType: opts.contentType,
    size: opts.bytes.length,
    sha256: sha,
    createdAt: new Date().toISOString(),
    sha256VerifiedBy: "server",
  };
  // Cliente histórico puede omitir la asociación al reintentar: omitir no significa borrarla.
  const movementId = opts.movementId ?? existing?.movementId;
  const propertyId = opts.propertyId ?? existing?.propertyId;
  if (movementId) meta.movementId = String(movementId).slice(0, 128);
  if (propertyId) meta.propertyId = String(propertyId).slice(0, 128);
  try { await persistence.putFileMeta(opts.username, meta); }
  catch (err) {
    if (!(err instanceof VaultConflictError)) throw err;
    const concurrent = await persistence.getFileMeta(opts.username, id);
    if (!concurrent || concurrent.sha256 !== sha || concurrent.size !== meta.size || concurrent.contentType !== meta.contentType ||
        concurrent.movementId !== meta.movementId || concurrent.propertyId !== meta.propertyId) throw err;
  }
  const persisted = await persistence.getFileMeta(opts.username, id);
  if (!persisted || persisted.sha256 !== sha || persisted.size !== opts.bytes.length) {
    throw new VaultStorageUnavailableError("Los metadatos del archivo no se han confirmado en el almacén.");
  }
  return persisted;
}
