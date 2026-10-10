// Vercel (funciones serverless Node): envía todas las rutas /api/* a la misma aplicación Express
// que usa server.ts en local/Render. Ver vercel.json (maxDuration y reescritura de SPA).
import type { IncomingMessage, ServerResponse } from "http";
import { createApiApp } from "../server/apiApp";

const app = createApiApp();

export default function handler(req: IncomingMessage & { body?: unknown }, res: ServerResponse) {
  // Si Vercel ya parseó el cuerpo JSON, evitamos que express.json intente leer el stream de nuevo.
  if (req.body !== undefined) (req as any)._body = true;
  return app(req as any, res as any);
}
