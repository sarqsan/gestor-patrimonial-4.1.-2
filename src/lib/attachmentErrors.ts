// Errores y plazos del flujo de adjuntos. Nunca incluyen bytes ni tokens de sesión.
export type AttachmentPhase = "validation" | "session" | "authorization" | "preflight" | "upload" | "verification" | "association" | "persistence" | "download";
export type AttachmentBackend = "firebase" | "vault";

export interface AttachmentFailure {
  phase?: AttachmentPhase;
  backend?: AttachmentBackend;
  code?: string;
  retryable?: boolean;
  cause?: unknown;
}

export class AttachmentError extends Error {
  readonly phase?: AttachmentPhase;
  readonly backend?: AttachmentBackend;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(message: string, failure: AttachmentFailure = {}) {
    super(message, { cause: failure.cause });
    this.name = "AttachmentError";
    this.phase = failure.phase;
    this.backend = failure.backend;
    this.code = failure.code;
    this.retryable = failure.retryable ?? false;
  }
}

export const ATTACHMENT_TIMEOUTS = {
  session: 15_000,
  preflight: 15_000,
  upload: 60_000,
  verification: 15_000,
  persistence: 20_000,
  download: 60_000,
} as const;

const PHASE_LABEL: Record<AttachmentPhase, string> = {
  validation: "validación", session: "sesión", authorization: "autorización",
  preflight: "consulta previa del objeto", upload: "subida", verification: "verificación",
  association: "asociación", persistence: "guardado de la operación", download: "descarga",
};

/** Conserva la causa y el código original. Un rechazo de permisos NO es un fallo de red. */
export function attachmentFailure(err: unknown, phase: AttachmentPhase, backend: AttachmentBackend): AttachmentError {
  if (err instanceof AttachmentError) return err;
  const code = (err as { code?: string })?.code || "unknown";
  const detail = err instanceof Error ? err.message : String(err);
  return new AttachmentError(
    `Fallo en ${PHASE_LABEL[phase]} (${backend}, ${code}): ${detail}. No se ha confirmado el guardado; conserva el formulario y vuelve a intentarlo.`,
    { phase, backend, code, cause: err, retryable: /network|timeout|retry-limit|unavailable|^vault\/http-5/.test(code) }
  );
}

export function logAttachmentFailure(err: AttachmentError): void {
  const original = err.cause as { code?: string; message?: string } | undefined;
  console.error("[attachments]", {
    phase: err.phase, backend: err.backend, code: err.code, retryable: err.retryable,
    message: err.message, originalCode: original?.code, originalMessage: original?.message,
  });
}

/**
 * El plazo aborta el transporte (fetch / UploadTask.cancel), no solo la espera del llamante.
 * Si un proveedor llegó a escribir antes de la cancelación, el resultado sigue SIN confirmar:
 * el siguiente intento debe reconciliar la MISMA referencia, nunca crear otra ni borrar esta.
 */
export function attachmentPhase<T>(
  phase: AttachmentPhase,
  backend: AttachmentBackend,
  ms: number,
  action: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", cancel);
    };
    const cancel = () => {
      if (done) return;
      done = true;
      const reason = parentSignal?.reason instanceof AttachmentError ? parentSignal.reason : new AttachmentError(
        `Se ha agotado el tiempo de espera en ${PHASE_LABEL[phase]} (${backend}). No se ha confirmado el guardado. Los datos del formulario se conservan; reintenta para comprobar el mismo archivo.`,
        { phase, backend, code: "attachment/timeout", retryable: true }
      );
      controller.abort(reason);
      cleanup();
      reject(reason);
    };
    const timer = setTimeout(cancel, ms);
    parentSignal?.addEventListener("abort", cancel, { once: true });
    if (parentSignal?.aborted) { cancel(); return; }
    Promise.resolve().then(() => action(controller.signal)).then(
      (value) => { if (!done) { done = true; cleanup(); resolve(value); } },
      (err) => { if (!done) { done = true; cleanup(); reject(attachmentFailure(err, phase, backend)); } }
    );
  });
}
