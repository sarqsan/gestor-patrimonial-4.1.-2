// Vercel (funciones serverless Node): envía todas las rutas /api/* a la misma aplicación Express
// que usa server.ts en local/Render. Ver vercel.json (maxDuration y reescritura de SPA).
//
// Los imports relativos llevan extensión .js: el runtime ESM nativo de Node no resuelve rutas sin extensión.
// La aplicación se carga de forma diferida para que un fallo de carga devuelva JSON con su causa,
// en lugar de una página de error genérica del proveedor.
import type { IncomingMessage, ServerResponse } from "http";

type ApiApp = (req: IncomingMessage, res: ServerResponse) => void;

let appPromise: Promise<ApiApp> | null = null;

function loadApp(): Promise<ApiApp> {
  if (!appPromise) {
    appPromise = import("../server/apiApp.js").then((m) => m.createApiApp() as unknown as ApiApp);
    // Si falla, se reintenta en la siguiente petición en lugar de quedar bloqueado.
    appPromise.catch(() => {
      appPromise = null;
    });
  }
  return appPromise;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export default async function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  let app: ApiApp;
  try {
    app = await loadApp();
  } catch (err: any) {
    console.error("[api] La aplicación API no pudo cargarse:", err);
    sendJson(res, 500, {
      error: `La función de API no pudo iniciarse (${err?.code || err?.name || "error desconocido"}). Revisa los logs de Vercel.`,
    });
    return;
  }

  try {
    // Si Vercel ya parseó el cuerpo JSON, evitamos que express.json intente leer el stream de nuevo.
    if (req.body !== undefined) (req as any)._body = true;
    app(req, res);
  } catch (err: any) {
    console.error("[api] Error no controlado en la petición:", err);
    sendJson(res, 500, { error: "Error interno de la API. Revisa los logs de Vercel." });
  }
}
