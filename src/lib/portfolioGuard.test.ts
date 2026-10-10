// Pruebas puras de la guardia de escritura y del hash estable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { stableStringify, portfolioRawHash, sha256Hex, utf8Bytes } from "./stableHash";
import { collectInlineDataUrls, NEAR_LIMIT_RATIO } from "./portfolioGuard";
import { PORTFOLIO_DOC_SAFE_BYTES } from "./attachmentRules";

test("stableStringify ordena claves, omite undefined y es independiente del orden de inserción", () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: undefined } }), '{"a":{"d":2},"b":1}');
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
});

test("sha256 conocido y hash de cartera que ignora updatedAt", async () => {
  assert.equal(await sha256Hex(utf8Bytes("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const a = await portfolioRawHash({ x: 1, updatedAt: "2026-01-01" });
  const b = await portfolioRawHash({ x: 1, updatedAt: "2027-02-02" });
  const c = await portfolioRawHash({ x: 2, updatedAt: "2026-01-01" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("collectInlineDataUrls encuentra data URLs anidadas con su ruta", () => {
  const found = collectInlineDataUrls({ a: [{ b: "data:application/pdf;base64,QUJD" }], c: "https://x" });
  assert.deepEqual(found.map((f) => f.path), ["$.a[0].b"]);
});

test("el margen de precaución (NEAR_LIMIT_RATIO) es el 80% del límite seguro", () => {
  assert.equal(NEAR_LIMIT_RATIO, 0.8);
  assert.equal(PORTFOLIO_DOC_SAFE_BYTES * NEAR_LIMIT_RATIO, 800_000);
});
