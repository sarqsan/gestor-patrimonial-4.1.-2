// Comprueba la aplicación API real (mismo código que Vercel y Render) levantada en HTTP local.
// No requiere red ni clave de Gemini: solo rutas de salud, validación y errores en JSON.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createApiApp } from "../../server/apiApp";
import handler from "../../api/[...route]";

let server: http.Server;
let base = "";

before(async () => {
  server = http.createServer(handler as any);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

test("createApiApp devuelve una aplicación Express utilizable", () => {
  assert.equal(typeof createApiApp(), "function");
});

test("GET /api/health responde JSON 200", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  const body = await res.json();
  assert.equal(body.status, "ok");
});

test("POST /api/extract sin documentos responde 400 en JSON", async () => {
  const res = await fetch(`${base}/api/extract`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /al menos un documento/);
});

test("POST /api/extract con documento pero sin GEMINI_API_KEY responde 500 en JSON (no HTML)", async () => {
  const prev = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const res = await fetch(`${base}/api/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text1: "Renta de prueba" }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /GEMINI_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
  }
});

test("ruta /api inexistente responde 404 en JSON", async () => {
  const res = await fetch(`${base}/api/no-existe`);
  assert.equal(res.status, 404);
  assert.match(res.headers.get("content-type") || "", /application\/json/);
  const body = await res.json();
  assert.ok(body.error);
});

// Regresión: el runtime ESM de Vercel (Node) no resuelve imports relativos sin extensión.
// Con "import ... from '../server/apiApp'" la función no arrancaba y Vercel devolvía un 500 sin JSON.
test("los imports relativos de api/ y server/ llevan extensión .js", async () => {
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(import.meta.dirname, "..", "..");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(root, "api"));
  walk(join(root, "server"));
  const offenders: string[] = [];
  for (const f of files) {
    for (const m of readFileSync(f, "utf-8").matchAll(/(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]*)"/g)) {
      if (!m[1].endsWith(".js")) offenders.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(offenders, []);
});
