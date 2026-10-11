// AUDITORÍA REPRODUCIBLE EXCLUSIVAMENTE EN MEMORIA Y LOOPBACK.
// NO es una preview ni demuestra almacenamiento remoto permanente.
// No carga facturas reales ni imprime credenciales/variables de entorno.
// Ejecutar con la barrera de red obligatoria:
// node --import ./docs/auditoria-adjuntos/solo-red-local.mjs --import tsx ./docs/auditoria-adjuntos/comprobaciones-locales.mjs
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createApiApp } from '../../server/apiApp.ts';
import { BlobVaultPersistence } from '../../server/vault/persistence.ts';
import { MemoryBlobPort } from '../../server/vault/memoryBlobPort.ts';
import { syntheticIbiPdf, TEST_PROPERTY, installTestLocalStorage } from '../../src/lib/attachmentTestFixtures.ts';
import { storeVaultToken, clearVaultToken, getVaultToken, setActiveVaultUser } from '../../src/lib/vaultClient.ts';

if (!globalThis[Symbol.for('attachments.audit.loopback-only')]) throw new Error('Debe cargar la barrera de red antes de ejecutar esta auditoría local.');
const port = new MemoryBlobPort();
const persistence = new BlobVaultPersistence(port); // proveedor SIMULADO, no Blob de Vercel
const app = createApiApp({ vaultPersistence: persistence });
const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const outcomes = [];
const bytes = syntheticIbiPdf();
const sha = (b) => createHash('sha256').update(b).digest('hex');
const originalSha = sha(bytes);
function record(id, invariant, ok, observed) { outcomes.push({ id, invariant, ok, observed }); }
async function request(op, method = 'GET', body, credential, id) {
  const [operation, ...extra] = op.split('&');
  const query = new URLSearchParams({ op: operation });
  for (const [k, v] of new URLSearchParams(extra.join('&'))) query.set(k, v);
  if (id) query.set('id', id);
  const response = await fetch(base + '/api/vault?' + query, {
    method, headers: { 'content-type': 'application/json', ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await response.json() : new Uint8Array(await response.arrayBuffer());
  return { status: response.status, data };
}
async function account(name) {
  const password = randomBytes(24).toString('hex');
  const created = await request('auth.register', 'POST', { username: name, password });
  if (created.status !== 201) throw new Error('Fallo de preparación de cuenta SINTÉTICA.');
  const login = await request('auth.login', 'POST', { username: name, password });
  if (login.status !== 200) throw new Error('Fallo de login SINTÉTICO.');
  return login.data.token; // valor solo en memoria, nunca se imprime ni se guarda en artefactos
}
async function upload(credential, id, movementId, propertyId = TEST_PROPERTY.id, withId = true) {
  return request('files.upload', 'POST', {
    ...(withId ? { id } : {}), name: 'IBI_FICTICIO_SIN_VALIDEZ.pdf', contentType: 'application/pdf',
    bytesBase64: Buffer.from(bytes).toString('base64'), movementId, propertyId,
  }, credential);
}
const movement = (id, receipt) => ({ id, propertyId: TEST_PROPERTY.id, category: 'ibi', type: 'gasto', amount: 1,
  date: '2026-10-11', description: 'PRUEBA SINTETICA SIN VALIDEZ', ...receipt });
try {
  const a = 'audit_owner_a', b = 'audit_owner_b';
  const ca = await account(a), cb = await account(b);
  const property = structuredClone(TEST_PROPERTY);
  await request('entities.put', 'POST', { type: 'properties', id: property.id, entity: property }, ca);
  const up = await upload(ca, 'file_audit_good', 'mov_good');
  if (up.status !== 201) throw new Error('No se pudo preparar el PDF FICTICIO.');
  const noAuth = await request('files.get', 'GET', undefined, undefined, 'file_audit_good');
  record('L01', 'Descarga Vault sin credencial debe ser rechazada.', noAuth.status === 401, { status: noAuth.status });
  const cross = await request('files.get', 'GET', undefined, cb, 'file_audit_good');
  record('L02', 'Otra cuenta no debe recuperar el documento de la cuenta propietaria.', cross.status === 404 || cross.status === 403, { status: cross.status });
  const download = await request('files.get', 'GET', undefined, ca, 'file_audit_good');
  record('L03', 'Descarga autorizada e íntegra del objeto persistido SIMULADO.', download.status === 200 && sha(download.data) === originalSha,
    { status: download.status, sameBytes: sha(download.data) === originalSha });

  const good = movement('mov_good', { receiptVaultId: 'file_audit_good', receiptName: 'IBI_FICTICIO_SIN_VALIDEZ.pdf', receiptType: 'application/pdf' });
  const commit = await request('movimientos.save', 'PUT', { movement: good }, ca, good.id);
  record('L04', 'El commit válido debe confirmar el mismo gasto/documento/inmueble.', commit.status === 200 && commit.data.movement?.receiptVaultId === good.receiptVaultId,
    { status: commit.status, associationMatches: commit.data.movement?.receiptVaultId === good.receiptVaultId });
  const retry = await upload(ca, 'file_audit_good', 'mov_good');
  const files = await request('files.list', 'GET', undefined, ca);
  record('L05', 'Reintento por el mismo ID no duplica el objeto en servidor.', retry.status === 201 && files.data.files.filter((f) => f.id === 'file_audit_good').length === 1,
    { status: retry.status, sameIdCount: files.data.files.filter((f) => f.id === 'file_audit_good').length });

  const fake = movement('mov_fake_storage', { receiptPath: `users/${b}/attachments/expenses/no_existe/IBI.pdf` });
  const fakeCommit = await request('movimientos.save', 'PUT', { movement: fake }, ca, fake.id);
  record('L06', 'No confirmar un receiptPath inexistente/de otra cuenta confiando en el cliente.', fakeCommit.status >= 400,
    { status: fakeCommit.status, storageOk: fakeCommit.data.storageOk === true });

  await upload(ca, 'file_no_parent', 'mov_no_parent', 'prop_no_existe');
  const orphan = { ...movement('mov_no_parent', { receiptVaultId: 'file_no_parent' }), propertyId: 'prop_no_existe' };
  const orphanCommit = await request('movimientos.save', 'PUT', { movement: orphan }, ca, orphan.id);
  record('L07', 'El padre patrimonial debe existir/estar autorizado en el remoto antes de confirmar asociación.', orphanCommit.status >= 400,
    { status: orphanCommit.status, propertyExists: (await request('entities.list&type=properties', 'GET', undefined, ca)).data.entities?.some((e) => e.id === orphan.propertyId) ?? false });

  // Simula una copia capturada ANTES del commit y enviada DESPUÉS por otra sesión/cliente.
  const staleMovement = movement(good.id, {});
  const bulk = await request('movimientos', 'PUT', { movements: [staleMovement] }, ca);
  const afterBulk = (await request('movimientos', 'GET', undefined, ca)).data.movements.find((m) => m.id === good.id);
  record('L08', 'Una sincronización vieja no debe borrar la referencia de un comprobante confirmado.', afterBulk?.receiptVaultId === good.receiptVaultId,
    { status: bulk.status, confirmedReferenceRetained: afterBulk?.receiptVaultId === good.receiptVaultId });

  const upb = await upload(cb, 'file_only_account_b', undefined);
  if (upb.status !== 201) throw new Error('Preparación sintética de cuenta B fallida.');
  const wrongProperty = { ...property, documents: [{ id: 'doc_foreign', vaultId: 'file_only_account_b', name: 'FICTICIO.pdf', type: 'application/pdf', size: '1 KB', category: 'ibi', year: 2026, uploadDate: '2026-10-11' }] };
  const uncheckedEntity = await request('entities.put', 'POST', { type: 'properties', id: property.id, entity: wrongProperty }, ca);
  record('L09', 'Omitir attachmentIds no debe eludir verificación de referencias privadas ajenas.', uncheckedEntity.status >= 400,
    { status: uncheckedEntity.status });

  const attached = { ...property, documents: [{ id: 'doc_good', vaultId: 'file_audit_good', name: 'FICTICIO.pdf', type: 'application/pdf', size: '1 KB', category: 'ibi', year: 2026, uploadDate: '2026-10-11' }] };
  const attachedCommit = await request('entities.put', 'POST', { type: 'properties', id: property.id, entity: attached, attachmentIds: ['file_audit_good'] }, ca);
  if (attachedCommit.status !== 201) throw new Error('Preparación de asociación válida fallida.');
  const stale = await request('entities.put', 'POST', { type: 'properties', id: property.id, entity: property }, ca);
  const listed = await fetch(base + '/api/vault?op=entities.list&type=properties', { headers: { authorization: `Bearer ${ca}` } });
  const afterEntity = (await listed.json()).entities.find((e) => e.id === property.id)?.data;
  record('L10', 'Snapshot viejo de inmueble no debe desvincular un documento confirmado.', afterEntity?.documents?.some((d) => d.vaultId === 'file_audit_good') === true,
    { status: stale.status, confirmedReferenceRetained: afterEntity?.documents?.some((d) => d.vaultId === 'file_audit_good') === true });

  installTestLocalStorage(); storeVaultToken(a, ca); setActiveVaultUser(a);
  clearVaultToken(a); setActiveVaultUser(null); // mismas operaciones de credencial usadas por logout de App
  const replay = await request('files.get', 'GET', undefined, ca, 'file_audit_good');
  record('L11', 'Logout debe invalidar una credencial conservada también en servidor, no solo borrar el navegador.', replay.status === 401 || replay.status === 403,
    { clientCredentialRemoved: getVaultToken(a) === null, statusWithPreservedCredential: replay.status });
  delete globalThis.localStorage;

  // Corrupción INSTRUMENTADA del proveedor simulado; no existe operación contra Blob real.
  const corrupted = new TextEncoder().encode('CONTENIDO ALTERADO SINTETICO');
  await port.putBytes(persistence.contentPathFor(a, 'file_audit_good'), corrupted, 'application/pdf');
  const guardedDownload = await request('files.get', 'GET', undefined, ca, 'file_audit_good');
  record('L12', 'Download normal rechaza bytes que no concuerdan con SHA almacenado.', guardedDownload.status >= 400,
    { status: guardedDownload.status });
  const archive = await request('expediente.zip', 'GET', undefined, ca);
  const zipHasCorruption = archive.data instanceof Uint8Array && Buffer.from(archive.data).includes(Buffer.from(corrupted));
  record('L13', 'ZIP fiscal debe aplicar la misma verificación de integridad que download individual.', !(archive.status === 200 && zipHasCorruption),
    { status: archive.status, containsAlteredBytes: zipHasCorruption });

  const legacy1 = await upload(ca, undefined, 'mov_legacy_repeat', property.id, false);
  const legacy2 = await upload(ca, undefined, 'mov_legacy_repeat', property.id, false);
  record('L14', 'Reintento legacy sin ID no debería crear dos objetos para el mismo archivo/intención.', legacy1.data.file?.id === legacy2.data.file?.id,
    { statuses: [legacy1.status, legacy2.status], sameObjectId: legacy1.data.file?.id === legacy2.data.file?.id });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
const summary = { simulatedProvider: 'MemoryBlobPort', remoteAcceptance: false, total: outcomes.length,
  passedInvariants: outcomes.filter((r) => r.ok).length, failedInvariants: outcomes.filter((r) => !r.ok).length, outcomes };
writeFileSync('docs/correccion-bloqueantes-adjuntos/antes-invariantes.json', JSON.stringify(summary, null, 2) + '\n');
for (const r of outcomes) console.log(`${r.id} ${r.ok ? 'PASS' : 'FAIL'} ${r.invariant} ${JSON.stringify(r.observed)}`);
console.log(`AUDIT_SUMMARY ${summary.total} invariantes; ${summary.passedInvariants} PASS; ${summary.failedInvariants} FAIL. Proveedor SIMULADO; cero aceptación remota.`);
if (summary.failedInvariants) process.exitCode = 1;
