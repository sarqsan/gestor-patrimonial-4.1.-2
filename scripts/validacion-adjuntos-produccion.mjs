#!/usr/bin/env node
// Prueba REAL autorizada, solo en Actions/main y solo contra el alias de producción.
// Registros NUEVOS ficticios por cuenta aislada; nunca importa/lista/modifica datos de otra cuenta.
// Credenciales únicamente en memoria. No se alteran reglas, entorno, configuración ni originales.
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { syntheticIbiPdf, TEST_PROPERTY } from '../src/lib/attachmentTestFixtures.ts';

const base = 'https://gestor-patrimonial-4-1-2.vercel.app';
const expected = process.argv[2];
const report = { target: base, expectedCommit: expected, actualCommit: null, realProvider: false, ok: false, checks: [], resources: [], cleanup: 'No se eliminan registros asociados ni bytes. Todo registro nuevo está identificado como PRUEBA SIN VALIDEZ FISCAL.' };
const secrets = [];
const redact = (v) => secrets.reduce((s, value) => value ? s.split(value).join('[redacted]') : s, String(v)).replace(/Bearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [redacted]').replace(/vercel_blob_rw_[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 600);
const hash = (b) => createHash('sha256').update(b).digest('hex');
function check(name, ok, observed = {}) {
  report.checks.push({ name, ok: Boolean(ok), observed });
  if (!ok) throw new Error(name);
}
async function request(path, { method = 'GET', token, body, raw = false } = {}) {
  const response = await fetch(base + path, {
    method, redirect: 'manual', signal: AbortSignal.timeout(45_000),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') ?? '';
  let data;
  if (!raw && contentType.includes('application/json')) { try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch {} }
  return { status: response.status, data, bytes, contentType, serverSha: response.headers.get('x-vault-sha256') };
}
async function api(op, { method = 'GET', token, body, id, type, raw } = {}) {
  const q = new URLSearchParams({ op }); if (id) q.set('id', id); if (type) q.set('type', type);
  return request('/api/vault?' + q, { method, token, body, raw });
}
function validReply(name, r, status) {
  const ok = r.status === status;
  report.checks.push({ name, ok, observed: { status: r.status, code: r.data?.code, contentType: r.contentType, error: ok ? undefined : redact(r.data?.error ?? '') } });
  if (!ok) throw new Error(name);
  return r.data;
}
async function account(name) {
  const password = randomBytes(24).toString('hex'); secrets.push(password);
  validReply('alta de cuenta ficticia propia ' + name, await api('auth.register', { method: 'POST', body: { username: name, password } }), 201);
  report.resources.push({ username: name, kind: 'cuenta ficticia nueva' });
  const body = validReply('autenticación real ' + name, await api('auth.login', { method: 'POST', body: { username: name, password } }), 200);
  if (typeof body?.token !== 'string') throw new Error('auth/token-missing');
  secrets.push(body.token); return body.token;
}
const deadline = async (promise, name) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('La prueba no alcanzó la fase ' + name)), 90_000); })]); }
  finally { clearTimeout(timer); }
};
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
let browser;
const uploadsObserved = [];
let ownerToken, otherToken;
try {
  check('ejecución de producción explícita', process.env.GITHUB_ACTIONS === 'true' && process.env.GITHUB_REF_NAME === 'main' && /^[a-f0-9]{40}$/.test(expected ?? ''));
  const health = validReply('API del despliegue', await request('/api/health'), 200);
  report.actualCommit = health?.commit ?? null;
  check('commit desplegado coincide exactamente', health?.commit === expected, { expected, actual: report.actualCommit });
  const caps = validReply('capacidad del almacén real', await api('health'), 200);
  check('Vault persistente privado operativo', caps?.driver === 'vercel-blob' && caps.durable === true && caps.storageOk === true,
    { driver: caps?.driver, durable: caps?.durable, storageOk: caps?.storageOk, detail: redact(caps?.detail ?? '') });

  report.realProvider = true;
  const key = randomBytes(6).toString('hex');
  const owner = 'test_ibi_' + key, other = 'test_ibi_other_' + key;
  ownerToken = await account(owner); otherToken = await account(other);
  const property = { ...TEST_PROPERTY, id: 'prop_ibi_' + key, address: 'PRUEBA IBI ' + key + ' SIN VALIDEZ FISCAL', registrationDate: '2026-10-12' };
  validReply('inmueble NUEVO y ficticio de cuenta de prueba', await api('entities.put', { method: 'POST', token: ownerToken, body: { type: 'properties', id: property.id, entity: property } }), 201);
  report.resources.push({ owner, other, propertyId: property.id, note: 'cuentas e inmueble nuevos; sin datos personales' });
  const pdf = syntheticIbiPdf(), originalSha = hash(pdf);
  report.pdf = { bytes: pdf.length, sha256: originalSha, fictional: true };
  const label = 'PRUEBA IBI ' + key + ' SIN VALIDEZ FISCAL';
  const timeoutLabel = label + ' TIMEOUT';
  const initialState = { user1: { name: 'PRUEBA', dni: '', brutoTrabajo: 0, netoTrabajo: 0 }, user2: { name: '', dni: '', brutoTrabajo: 0, netoTrabajo: 0, hasPartner: false }, properties: [property], payments: [], expenses: [], syncEvents: [], syncEnabled: false, isOnboarded: true, isAuthenticated: true, currentUser: owner, registeredUsers: {}, currentYear: 2026, yearlyProfiles: {}, theme: 'slate-indigo' };
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Restauración normal de una sesión de NUESTRA cuenta; el Bearer fue emitido por
  // auth.login real. No suplantación, mock de servidor ni desactivación de autorización.
  await context.addInitScript(({ username, token, state }) => {
    if (location.origin !== 'https://gestor-patrimonial-4-1-2.vercel.app') return;
    localStorage.setItem('rentasync_session', JSON.stringify({ currentUser: username, isAuthenticated: true }));
    localStorage.setItem('rentasync_state_' + username, JSON.stringify(state));
    localStorage.setItem('rentasync_vault_token_' + username, token);
    localStorage.setItem('rentasync_vault_active_user', username);
  }, { username: owner, token: ownerToken, state: initialState });
  const page = await context.newPage(); page.setDefaultTimeout(35_000);
  page.on('response', (response) => {
    const u = new URL(response.url());
    if (u.origin !== base || u.pathname !== '/api/vault' || u.searchParams.get('op') !== 'files.upload' || response.status() !== 201) return;
    uploadsObserved.push(response.json().then((body) => {
      if (body?.file?.id) report.resources.push({ vaultId: body.file.id, movementId: body.file.movementId, propertyId: body.file.propertyId, kind: 'archivo nuevo confirmado por HTTP real' });
    }).catch(() => {}));
  });
  const normalReached = deferred(), normalRelease = deferred(), timeoutReached = deferred(), timeoutRelease = deferred();
  let normalRequest, timeoutRequest, normalCommitted = false, timedOutOnce = false;
  const routeErrors = [];
  await page.route('**/api/vault?op=movimientos.save*', async (route) => {
    const body = route.request().postDataJSON();
    const m = body?.movement;
    try {
      if (m?.description === label && !normalRequest) {
        normalRequest = m; normalReached.resolve();
        // Demostrar espera antes de persistencia REAL, sin respuesta falsa del servidor.
        await normalRelease.promise;
        const response = await route.fetch(); normalCommitted = response.status() === 200;
        await route.fulfill({ response }); return;
      }
      if (m?.description === timeoutLabel && !timedOutOnce) {
        timedOutOnce = true; timeoutRequest = m;
        const response = await route.fetch();
        if (response.status() !== 200) { routeErrors.push('commit real HTTP ' + response.status()); timeoutReached.resolve(); await route.fulfill({ response }); return; }
        timeoutReached.resolve();
        // El servidor ya guardó REALMENTE; se retiene solo su respuesta al navegador
        // para simular un timeout del cliente y comprobar el mismo ID al reintentar.
        await timeoutRelease.promise;
        await route.fulfill({ response }).catch(() => {}); return;
      }
      await route.continue();
    } catch { routeErrors.push('intercepción HTTP de prueba fallida'); normalReached.resolve(); timeoutReached.resolve(); }
  });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Panel de Control/ }).first().click();
  await page.getByRole('button', { name: 'Gestión de Gastos de Alquiler', exact: true }).click();
  async function formFor(description) {
    await page.getByRole('button', { name: /Registrar Transacción/ }).click();
    const form = page.locator('form');
    await form.locator('select:has(option[value="' + property.id + '"])').selectOption(property.id);
    await form.locator('select:has(option[value="ibi"])').selectOption('ibi');
    await form.locator('input[inputmode="decimal"]').fill('1,00');
    await form.locator('input[type="date"]').fill('2026-10-12');
    await form.locator('input[placeholder*="Ej. Factura"]').fill(description);
    await form.locator('input[type="file"]').setInputFiles({ name: 'IBI_FICTICIO_' + key + '.pdf', mimeType: 'application/pdf', buffer: Buffer.from(pdf) });
    return form;
  }
  let form = await formFor(label);
  await form.getByRole('button', { name: 'Guardar Operación', exact: true }).click();
  await deadline(normalReached.promise, 'commit de formulario');
  check('formulario espera persistencia; no declara éxito prematuro', normalRequest && await form.isVisible() && (await form.locator('fieldset').getAttribute('disabled')) !== null);
  let moves = validReply('lectura antes del commit retenido', await api('movimientos', { token: ownerToken }), 200).movements;
  check('operación aún no persistida antes de permitir envío', !moves.some((m) => m.id === normalRequest.id));
  normalRelease.resolve();
  await page.locator('form').waitFor({ state: 'detached' });
  check('formulario cierra solamente después del 200 real', normalCommitted && routeErrors.length === 0);
  moves = validReply('operación persistida', await api('movimientos', { token: ownerToken }), 200).movements;
  const stored = moves.find((m) => m.id === normalRequest.id);
  check('asociación real del IBI al gasto e inmueble correctos', stored?.propertyId === property.id && stored?.receiptVaultId === normalRequest.receiptVaultId && stored?.category === 'ibi' && stored?.amount === 1, { movementId: stored?.id, propertyId: stored?.propertyId, vaultId: stored?.receiptVaultId });
  report.resources.push({ movementId: stored.id, vaultId: stored.receiptVaultId });
  const verified = validReply('servidor verifica contenido persistido real', await api('files.verify', { token: ownerToken, id: stored.receiptVaultId }), 200);
  check('hash independiente del servidor', verified.file?.sha256 === originalSha && verified.file?.size === pdf.length);
  let downloaded = await api('files.get', { token: ownerToken, id: stored.receiptVaultId, raw: true });
  check('recuperación remota byte a byte', downloaded.status === 200 && Buffer.from(downloaded.bytes).equals(Buffer.from(pdf)) && downloaded.serverSha === originalSha, { status: downloaded.status, sha256: hash(downloaded.bytes) });
  const viewerResponse = page.waitForResponse((r) => { const u = new URL(r.url()); return u.pathname === '/api/vault' && u.searchParams.get('op') === 'files.get' && u.searchParams.get('id') === stored.receiptVaultId; });
  await page.locator('tr').filter({ hasText: label }).getByRole('button', { name: 'Ver Factura', exact: true }).click();
  const viewed = await viewerResponse;
  check('visor de la aplicación recupera los bytes auténticos', viewed.status() === 200 && hash(await viewed.body()) === originalSha);
  await page.locator('.fixed.inset-0').filter({ has: page.locator('iframe[title="Vista previa PDF"]') }).getByRole('button').first().click();

  const unauth = await api('files.get', { id: stored.receiptVaultId });
  check('sin credencial no accede', unauth.status === 401, { status: unauth.status, code: unauth.data?.code });
  const invalid = await api('files.get', { token: 'invalid.synthetic.test', id: stored.receiptVaultId });
  check('token manipulado no accede', invalid.status === 401, { status: invalid.status, code: invalid.data?.code });
  const foreign = await api('files.get', { token: otherToken, id: stored.receiptVaultId });
  check('otra cuenta autenticada no accede', foreign.status === 404, { status: foreign.status, code: foreign.data?.code });
  const badHash = await api('files.commit', { method: 'POST', token: ownerToken, id: stored.receiptVaultId, body: { size: pdf.length, sha256: '0'.repeat(64) } });
  check('checksum falso no modifica ni confirma el original', badHash.status === 400, { status: badHash.status, code: badHash.data?.code });
  downloaded = await api('files.get', { token: ownerToken, id: stored.receiptVaultId, raw: true });
  check('original íntegro después de rechazo', downloaded.status === 200 && hash(downloaded.bytes) === originalSha);

  form = await formFor(timeoutLabel);
  await form.getByRole('button', { name: 'Guardar Operación', exact: true }).click();
  await deadline(timeoutReached.promise, 'persistencia anterior al timeout');
  check('servidor sí persistió antes de simular respuesta perdida', Boolean(timeoutRequest) && routeErrors.length === 0);
  await form.getByText(/Se ha agotado el tiempo de espera/).waitFor({ state: 'visible', timeout: 30_000 });
  check('timeout no borra campos ni anuncia éxito', await form.isVisible() && await form.locator('input[inputmode="decimal"]').inputValue() === '1,00' && await form.locator('input[placeholder*="Ej. Factura"]').inputValue() === timeoutLabel && await form.getByText('IBI_FICTICIO_' + key + '.pdf', { exact: true }).isVisible());
  timeoutRelease.resolve();
  await form.getByRole('button', { name: 'Guardar Operación', exact: true }).click();
  await page.locator('form').waitFor({ state: 'detached' });
  moves = validReply('lectura tras timeout/reintento real', await api('movimientos', { token: ownerToken }), 200).movements;
  const files = validReply('lista propia tras reintento', await api('files.list', { token: ownerToken }), 200).files;
  check('retry mantiene una sola operación y un solo archivo', moves.length === 2 && files.length === 2 && moves.filter((m) => m.description === timeoutLabel).length === 1 && moves.filter((m) => m.id === timeoutRequest.id).length === 1 && files.filter((f) => f.movementId === timeoutRequest.id).length === 1 && files.filter((f) => f.id === timeoutRequest.receiptVaultId).length === 1 && moves.find((m) => m.id === timeoutRequest.id)?.receiptVaultId === timeoutRequest.receiptVaultId);
  downloaded = await api('files.get', { token: ownerToken, id: timeoutRequest.receiptVaultId, raw: true });
  check('recuperación íntegra después de timeout/retry', downloaded.status === 200 && hash(downloaded.bytes) === originalSha);
  report.resources.push({ movementId: timeoutRequest.id, vaultId: timeoutRequest.receiptVaultId, timeoutSimulatedOnlyInClientResponse: true });
  check('no error en instrumentación de navegador', routeErrors.length === 0);
  report.ok = true;
} catch (err) {
  report.error = redact(err instanceof Error ? err.message : 'Error no identificado');
} finally {
  await Promise.all(uploadsObserved);
  if (browser) await browser.close().catch(() => {});
  // Cerrar nuestras sesiones, no borrar cuentas, cartera, originales ni referencias.
  for (const token of [ownerToken, otherToken].filter(Boolean)) {
    try {
      const r = await api('auth.logout', { method: 'POST', token });
      if (r.status !== 204 && r.status !== 401) { report.sessionCleanupError = { status: r.status, code: r.data?.code, error: redact(r.data?.error ?? '') }; report.ok = false; continue; }
      const revoked = await api('session', { token });
      report.checks.push({ name: 'sesión propia revocada en servidor', ok: revoked.status === 401, observed: { status: revoked.status } });
      if (revoked.status !== 401) report.ok = false;
    } catch { report.sessionCleanupError = { code: 'logout/network-unavailable' }; report.ok = false; }
  }
  writeFileSync('/tmp/adjuntos-produccion.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
