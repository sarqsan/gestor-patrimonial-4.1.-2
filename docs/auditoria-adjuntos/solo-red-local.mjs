// Barrera de AUDITORÍA LOCAL. No es configuración de preview/producción.
// Usar: node --import ./docs/auditoria-adjuntos/solo-red-local.mjs --import tsx ...
// No permite conexiones de red fuera de loopback, incluso si una prueba reemplaza fetch.
import net from 'node:net';

globalThis[Symbol.for('attachments.audit.loopback-only')] = true;
const stats = { testFile: process.argv.find((a) => /\.test\.(ts|tsx)$/.test(a))?.split('/').slice(-3).join('/') ?? null, externalFetchBlocked: 0, externalSocketBlocked: 0 };
const allowed = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
const nativeFetch = globalThis.fetch;
if (nativeFetch) globalThis.fetch = async (input, init) => {
  const value = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  let parsed;
  try { parsed = new URL(value); } catch { return nativeFetch(input, init); }
  if (['data:', 'blob:'].includes(parsed.protocol)) return nativeFetch(input, init);
  if (!allowed(parsed.hostname)) {
    stats.externalFetchBlocked++;
    throw new Error('AUDIT_NETWORK_DENIED: proveedor externo bloqueado; no se envió la petición.');
  }
  return nativeFetch(input, init);
};
const nativeConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host = 'localhost';
  if (first && typeof first === 'object') {
    if (first.path && !first.port) return nativeConnect.apply(this, args); // IPC local
    host = first.host ?? first.hostname ?? first.servername ?? host;
  } else if (typeof first === 'number') {
    if (typeof args[1] === 'string') host = args[1];
  } else if (typeof first === 'string' && first.startsWith('/')) {
    return nativeConnect.apply(this, args); // IPC local
  }
  if (!allowed(host)) {
    stats.externalSocketBlocked++;
    throw new Error('AUDIT_NETWORK_DENIED: conexión fuera de loopback bloqueada.');
  }
  return nativeConnect.apply(this, args);
};
process.on('exit', () => {
  console.log('AUDIT_NETWORK_GUARD ' + JSON.stringify(stats)); // nunca URLs, headers ni credenciales
});
