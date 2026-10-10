// Rutas HTTP del vault. Se montan en /api/vault dentro de la aplicación Express existente
// (server/apiApp.ts), compartida por Render (server.ts) y Vercel (api/[...route].ts).
//
// Seguridad: todas las operaciones de datos exigen token de sesión (Bearer). Los recursos
// se resuelven SIEMPRE bajo el directorio del usuario del token: no existe ninguna ruta que
// permita leer o escribir datos de otra cuenta. Registro y login son los únicos endpoints
// abiertos (junto con health), y no exponen información de cuentas ajenas.
import { Router, Request, Response, NextFunction } from "express";
import { VaultStore, VAULT_MAX_FILE_BYTES } from "./store.js";
import { createSessionToken, verifySessionToken, normalizeUsername, passwordProblem } from "./auth.js";
import { buildZip, type ZipEntry } from "./zip.js";

export interface VaultRouterOptions {
  store: VaultStore;
  /** Secreto HMAC para firmar sesiones. Si no se pasa, se genera/persiste en el almacén. */
  secret?: string;
}

/** Extrae y valida el usuario del token Bearer. */
async function authedUser(req: Request, store: VaultStore, secret: string): Promise<string | null> {
  const header = req.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) return null;
  const user = verifySessionToken(secret, m[1].trim());
  if (!user) return null;
  // Defensa en profundidad: el usuario del token debe existir en el índice.
  const record = await store.getUser(user);
  return record ? user : null;
}

function badRequest(res: Response, message: string): void {
  res.status(400).json({ ok: false, error: message });
}

export function createVaultRouter(options: VaultRouterOptions): Router {
  const { store } = options;
  const router = Router();
  let secretPromise: Promise<string> | null = options.secret ? Promise.resolve(options.secret) : null;

  const getSecret = (): Promise<string> => {
    if (!secretPromise) secretPromise = store.ensureSecret();
    return secretPromise;
  };

  const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const secret = await getSecret();
      const user = await authedUser(req, store, secret);
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

  // ---------- abiertos ----------
  router.get("/health", (_req, res) => {
    res.json({ ok: true, vault: "ok", maxFileBytes: VAULT_MAX_FILE_BYTES });
  });

  router.post("/auth/register", async (req, res, next) => {
    try {
      const username = normalizeUsername(req.body?.username);
      const password = req.body?.password;
      if (!username) return badRequest(res, "Nombre de usuario no válido (3-64 caracteres: letras, números, guiones).");
      const passProblem = passwordProblem(password);
      if (passProblem) return badRequest(res, passProblem);
      const created = await store.createUser(username, password);
      if (!created) return res.status(409).json({ ok: false, error: "Este nombre de usuario ya está registrado." });
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
      const ok = await store.verifyUser(username, password);
      if (!ok) return res.status(401).json({ ok: false, error: "Usuario o contraseña incorrectos." });
      const secret = await getSecret();
      const token = createSessionToken(secret, username);
      res.json({ ok: true, username, token });
    } catch (err) {
      next(err);
    }
  });

  // ---------- autenticados ----------
  router.get("/session", requireAuth, (req: Request, res) => {
    res.json({ ok: true, username: (req as any).vaultUser });
  });

  router.get("/movimientos", requireAuth, async (req: Request, res, next) => {
    try {
      const movements = await store.getMovements((req as any).vaultUser);
      res.json({ ok: true, movements });
    } catch (err) {
      next(err);
    }
  });

  router.put("/movimientos", requireAuth, async (req: Request, res, next) => {
    try {
      const movements = req.body?.movements;
      if (!Array.isArray(movements)) return badRequest(res, "Se espera una lista de movimientos.");
      if (movements.length > 20_000) return badRequest(res, "Demasiados movimientos en una sola sincronización.");
      const saved = await store.putMovements((req as any).vaultUser, movements);
      res.json({ ok: true, saved });
    } catch (err) {
      next(err);
    }
  });

  router.get("/files", requireAuth, async (req: Request, res, next) => {
    try {
      const files = await store.listFiles((req as any).vaultUser);
      res.json({ ok: true, files });
    } catch (err) {
      next(err);
    }
  });

  router.post("/files", requireAuth, async (req: Request, res, next) => {
    try {
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
      const meta = await store.putFile((req as any).vaultUser, {
        id: typeof id === "string" ? id : undefined,
        name: typeof name === "string" ? name : "archivo",
        contentType: typeof contentType === "string" ? contentType : "",
        bytes,
        movementId: typeof movementId === "string" ? movementId : undefined,
        propertyId: typeof propertyId === "string" ? propertyId : undefined,
      });
      res.status(201).json({ ok: true, file: meta });
    } catch (err: any) {
      if (err instanceof Error && /límite|tipo no admitido|identificador|sobrescribe/i.test(err.message)) {
        return badRequest(res, err.message);
      }
      next(err);
    }
  });

  router.get("/files/:fileId", requireAuth, async (req: Request, res, next) => {
    try {
      const got = await store.getFile((req as any).vaultUser, req.params.fileId);
      if (!got) {
        res.status(404).json({ ok: false, error: "El archivo no existe para esta cuenta." });
        return;
      }
      res.setHeader("content-type", got.meta.contentType || "application/octet-stream");
      res.setHeader("content-length", String(got.bytes.length));
      res.setHeader(
        "content-disposition",
        `attachment; filename="${encodeURIComponent(got.meta.name).replace(/["\\]/g, "")}"`
      );
      res.setHeader("x-vault-sha256", got.meta.sha256);
      res.status(200).end(Buffer.from(got.bytes));
    } catch (err) {
      next(err);
    }
  });

  router.delete("/files/:fileId", requireAuth, async (req: Request, res, next) => {
    try {
      const deleted = await store.deleteFile((req as any).vaultUser, req.params.fileId);
      if (!deleted) {
        res.status(404).json({ ok: false, error: "El archivo no existe para esta cuenta." });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Expediente fiscal: movimientos y metadatos de archivos en un rango de fechas.
  router.get("/expediente", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const from = typeof req.query.from === "string" ? req.query.from : "";
      const to = typeof req.query.to === "string" ? req.query.to : "";
      const movements = await store.getMovements(user);
      const filtered = movements.filter((m: any) => {
        const date = typeof m?.date === "string" ? m.date : "";
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      });
      const files = await store.listFiles(user);
      res.json({ ok: true, username: user, from, to, movements: filtered, files });
    } catch (err) {
      next(err);
    }
  });

  // Expediente fiscal completo: un único ZIP con movimientos + documentos vinculados.
  router.get("/expediente.zip", requireAuth, async (req: Request, res, next) => {
    try {
      const user = (req as any).vaultUser;
      const from = typeof req.query.from === "string" ? req.query.from : "";
      const to = typeof req.query.to === "string" ? req.query.to : "";
      const movements = await store.getMovements(user);
      const filtered = movements.filter((m: any) => {
        const date = typeof m?.date === "string" ? m.date : "";
        if (from && date < from) return false;
        if (to && date > to) return false;
        return true;
      });
      const allFiles = await store.listFiles(user);
      const hasRange = Boolean(from || to);
      let included = allFiles;
      if (hasRange) {
        // Solo documentos del periodo: vinculados por movimiento o referenciados en ellos.
        const movementIds = new Set(filtered.map((m: any) => m?.id).filter(Boolean));
        const referenced = new Set<string>();
        for (const m of filtered) {
          for (const v of Object.values(m ?? {})) {
            if (typeof v === "string" && /^file_[A-Za-z0-9_-]+$/.test(v)) referenced.add(v);
          }
        }
        included = allFiles.filter(
          (f) => (f.movementId && movementIds.has(f.movementId)) || referenced.has(f.id)
        );
      }

      const entries: ZipEntry[] = [
        {
          name: "movimientos.json",
          bytes: new TextEncoder().encode(
            JSON.stringify({ username: user, from, to, exportedAt: new Date().toISOString(), movements: filtered }, null, 2)
          ),
        },
        {
          name: "archivos.json",
          bytes: new TextEncoder().encode(JSON.stringify({ files: included }, null, 2)),
        },
      ];
      const usedNames = new Set<string>();
      for (const meta of included) {
        const got = await store.getFile(user, meta.id);
        if (!got) continue;
        const clean = (meta.name || "archivo").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 80);
        let entryName = `archivos/${meta.id}_${clean}`;
        let n = 1;
        while (usedNames.has(entryName)) entryName = `archivos/${meta.id}_${n++}_${clean}`;
        usedNames.add(entryName);
        entries.push({ name: entryName, bytes: got.bytes });
      }

      const zip = buildZip(entries);
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

  // ---------- copias de seguridad ----------
  router.post("/backups", requireAuth, async (req: Request, res, next) => {
    try {
      const portfolio = req.body?.portfolio;
      if (portfolio == null) return badRequest(res, "Falta la cartera a copiar.");
      const created = await store.createBackup((req as any).vaultUser, portfolio);
      res.status(201).json({ ok: true, ...created });
    } catch (err: any) {
      if (err instanceof Error && /límite/i.test(err.message)) return badRequest(res, err.message);
      next(err);
    }
  });

  router.get("/backups", requireAuth, async (req: Request, res, next) => {
    try {
      const backups = await store.listBackups((req as any).vaultUser);
      res.json({ ok: true, backups });
    } catch (err) {
      next(err);
    }
  });

  router.get("/backups/:id", requireAuth, async (req: Request, res, next) => {
    try {
      const portfolio = await store.getBackup((req as any).vaultUser, req.params.id);
      if (portfolio == null) {
        res.status(404).json({ ok: false, error: "La copia no existe para esta cuenta." });
        return;
      }
      res.json({ ok: true, portfolio });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
