// Respuestas simuladas (sin red): el helper no debe interpretar páginas de error como JSON.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readApiJson, ApiResponseError } from "./apiResponse";

const text = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/plain" } });
const json = (obj: unknown, status: number) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

test("404 con página de texto (Vercel sin función /api) da un error comprensible, no el de JSON", async () => {
  const res = text("The page could not be found\n\nNOT_FOUND", 404);
  await assert.rejects(readApiJson(res, "Fallo."), (err: any) => {
    assert.ok(err instanceof ApiResponseError);
    assert.equal(err.status, 404);
    assert.match(err.message, /no está disponible en este despliegue/);
    assert.match(err.message, /HTTP 404/);
    assert.doesNotMatch(err.message, /Unexpected token|not valid JSON|The page/);
    return true;
  });
});

test("500 con JSON de error muestra el mensaje del servidor", async () => {
  await assert.rejects(readApiJson(json({ error: "La clave GEMINI_API_KEY no está configurada." }, 500), "Fallo."), /GEMINI_API_KEY/);
});

test("500 sin cuerpo JSON usa el mensaje de respaldo con el estado HTTP", async () => {
  await assert.rejects(readApiJson(text("Internal error", 500), "Fallo al analizar."), /Fallo al analizar\. \(HTTP 500\)/);
});

test("200 con HTML (no JSON) se rechaza sin exponer el HTML", async () => {
  const res = new Response("<!doctype html><html>SPA</html>", { status: 200, headers: { "content-type": "text/html" } });
  await assert.rejects(readApiJson(res, "Fallo."), (err: any) => {
    assert.match(err.message, /no es JSON/);
    assert.doesNotMatch(err.message, /doctype|html/i);
    return true;
  });
});

test("200 con JSON devuelve los datos sin modificar", async () => {
  const data = await readApiJson<{ text: string }>(json({ text: "Contrato" }, 200), "Fallo.");
  assert.deepEqual(data, { text: "Contrato" });
});

test("413 (petición demasiado grande en Vercel) explica el límite en lugar de un error genérico", async () => {
  await assert.rejects(readApiJson(text("Request Entity Too Large", 413), "Fallo."), (err: any) => {
    assert.equal(err.status, 413);
    assert.match(err.message, /4,5 MB/);
    assert.doesNotMatch(err.message, /Request Entity/);
    return true;
  });
});
