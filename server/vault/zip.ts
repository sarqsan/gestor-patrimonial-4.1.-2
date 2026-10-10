// Escritor ZIP mínimo sin dependencias externas (método "store": sin compresión).
// Suficiente para el expediente fiscal: los PDF/imágenes ya vienen comprimidos y el
// objetivo es un artefacto único, íntegro y abrible por cualquier descompresor estándar.

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Codificación DOS de fecha/hora (el ZIP clásico la usa en cabeceras). */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const year = Math.max(1980, d.getFullYear());
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

export interface ZipEntry {
  name: string;
  bytes: Uint8Array;
  mtime?: Date;
}

/** Construye un ZIP completo (cabeceras locales + directorio central + EOCD). */
export function buildZip(entries: ZipEntry[]): Buffer {
  const encoder = new TextEncoder();
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const when = dosDateTime(new Date());

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.bytes);
    const size = entry.bytes.length;

    // Cabecera local (30 bytes + nombre).
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // firma
    local.writeUInt16LE(20, 4); // versión necesaria
    local.writeUInt16LE(0x0800, 6); // flags: nombres UTF-8
    local.writeUInt16LE(0, 8); // método: store
    local.writeUInt16LE(when.time, 10);
    local.writeUInt16LE(when.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // tamaño comprimido
    local.writeUInt32LE(size, 22); // tamaño descomprimido
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra
    localParts.push(local, Buffer.from(nameBytes), Buffer.from(entry.bytes));

    // Entrada del directorio central (46 bytes + nombre).
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // firma
    central.writeUInt16LE(20, 4); // versión creador
    central.writeUInt16LE(20, 6); // versión necesaria
    central.writeUInt16LE(0x0800, 8); // flags
    central.writeUInt16LE(0, 10); // método
    central.writeUInt16LE(when.time, 12);
    central.writeUInt16LE(when.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comentario
    central.writeUInt16LE(0, 34); // disco
    central.writeUInt16LE(0, 36); // atributos internos
    central.writeUInt32LE(0, 38); // atributos externos
    central.writeUInt32LE(offset, 42); // desplazamiento de la cabecera local
    centralParts.push(central, Buffer.from(nameBytes));

    offset += 30 + nameBytes.length + size;
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);

  // Fin del directorio central (EOCD, 22 bytes).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disco
  eocd.writeUInt16LE(0, 6); // disco del directorio
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20); // comentario

  return Buffer.concat([localBuf, centralBuf, eocd]);
}
