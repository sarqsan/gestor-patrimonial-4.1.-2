// Contraejemplo adicional de ciclo de vida MULTIOBJETO. No forma parte de la afirmación 14/14.
// Si falla, bloquea el cierre de la corrección aunque npm test sea verde.
// Ejecutar exclusivamente con barrera: node --import ./docs/auditoria-adjuntos/solo-red-local.mjs --import tsx ./docs/correccion-bloqueantes-adjuntos/comprobacion-ciclo-vida.mjs
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createApiApp } from '../../server/apiApp.ts';
import { BlobVaultPersistence } from '../../server/vault/persistence.ts';
import { MemoryBlobPort } from '../../server/vault/memoryBlobPort.ts';
import { TEST_PROPERTY, syntheticIbiPdf } from '../../src/lib/attachmentTestFixtures.ts';
if (!globalThis[Symbol.for('attachments.audit.loopback-only')]) throw new Error('Barrera local obligatoria.');
const port = new MemoryBlobPort(), first = new BlobVaultPersistence(port), second = new BlobVaultPersistence(port);
const servers = [];
async function start(persistence) {
  const app = createApiApp({ vaultPersistence: persistence });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server); return `http://127.0.0.1:${server.address().port}`;
}
async function request(base, op, method = 'GET', body, bearer, id) {
  const query = new URLSearchParams({ op }); if (id) query.set('id', id);
  if (op.startsWith('entities.')) query.set('type', 'properties');
  const res = await fetch(base + '/api/vault?' + query, { method, headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (res.headers.get('content-type') ?? '').includes('application/json') ? await res.json() : null };
}
let report;
try {
  const baseA = await start(first), baseB = await start(second);
  const username = 'test_lifecycle_race_only', password = randomBytes(24).toString('hex');
  const register = await request(baseA, 'auth.register', 'POST', { username, password });
  const login = await request(baseA, 'auth.login', 'POST', { username, password });
  if (register.status !== 201 || login.status !== 200) throw new Error('Preparación sintética fallida.');
  const bearer = login.data.token; // solo memoria, jamás reporte, logs ni archivos
  const property = structuredClone(TEST_PROPERTY), movementId = 'm_lifecycle_race';
  const parent = await request(baseA, 'entities.put', 'POST', { type: 'properties', id: property.id, entity: property }, bearer);
  const upload = await request(baseA, 'files.upload', 'POST', { id: 'file_lifecycle_race', name: 'FICTICIO.pdf', contentType: 'application/pdf', bytesBase64: Buffer.from(syntheticIbiPdf()).toString('base64'), propertyId: property.id, movementId }, bearer);
  if (parent.status !== 201 || upload.status !== 201) throw new Error('Preparación de padre/bytes sintéticos fallida.');
  let reached, release;
  const atDelete = new Promise((r) => { reached = r; }), unlock = new Promise((r) => { release = r; });
  const originalDelete = port.del.bind(port);
  port.del = async (pathname, options) => {
    if (pathname.includes('/entities/properties/') && pathname.endsWith('/' + property.id + '.json')) { reached(); await unlock; }
    return originalDelete(pathname, options);
  };
  // La instancia B ya terminó su prevalidación; aún no ejecutó la eliminación CAS.
  const deleting = request(baseB, 'entities.delete', 'DELETE', undefined, bearer, property.id);
  await atDelete;
  const committing = await request(baseA, 'movimientos.save', 'PUT', { movement: { id: movementId, propertyId: property.id, type: 'gasto', category: 'ibi', amount: 1, date: '2026-10-11', receiptVaultId: 'file_lifecycle_race', status: 'synced' } }, bearer, movementId);
  release();
  const deletion = await deleting;
  const finalParent = await request(baseA, 'entities.get', 'GET', undefined, bearer, property.id);
  const finalMovement = await request(baseA, 'movimientos.get', 'GET', undefined, bearer, movementId);
  const ok = committing.status === 200 && deletion.status === 409 && finalParent.status === 200 && finalMovement.status === 200 && finalMovement.data?.movement?.receiptVaultId === 'file_lifecycle_race';
  report = { case: 'CICLO-01', invariant: 'Un borrado de padre prevalidado no debe destruirlo tras un commit de adjunto concurrente confirmado en otra instancia', ok, isolatedSimulation: true, instances: 2, remoteAcceptance: false, observed: { commitStatus: committing.status, deletionStatus: deletion.status, parentReadStatus: finalParent.status, movementReadStatus: finalMovement.status, confirmedReferenceRetained: finalMovement.data?.movement?.receiptVaultId === 'file_lifecycle_race' }, consequence: ok ? 'invariante retenida en esta simulación' : 'STOP: atomicidad CAS por objeto no basta; autorización independiente de ciclo de vida/transacciones necesaria' };
} finally {
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
}
writeFileSync(process.argv[2] || 'docs/publicacion-adjuntos/despues-ciclo.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
