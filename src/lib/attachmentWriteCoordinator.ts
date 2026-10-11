// Solo coordinación de ESCRITURAS en este cliente: no cambia registros ni modelos.
// Evita que una copia de cartera capturada antes/durante un commit de adjunto
// borre su asociación después de la confirmación. NO es una transacción distribuida.
export class AttachmentWriteCoordinator {
  private tails = new Map<string, Promise<unknown>>();
  private epochs = new Map<string, number>();

  capture(user: string): number { return this.epochs.get(user) ?? 0; }
  private invalidate(user: string) { this.epochs.set(user, this.capture(user) + 1); }
  private enqueue<T>(user: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(user) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(work);
    // Un fallo no envenena la cola; el llamante conserva el rechazo original.
    this.tails.set(user, pending);
    void pending.then(() => {}, () => {}).then(() => {
      if (this.tails.get(user) === pending) this.tails.delete(user);
    });
    return pending;
  }

  /** false = copia obsoleta descartada SIN escribir ni anunciar éxito. */
  snapshot(user: string, epoch: number, work: () => Promise<void>): Promise<boolean> {
    return this.enqueue(user, async () => {
      if (epoch !== this.capture(user)) return false;
      await work();
      return true;
    });
  }

  attachment<T>(user: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.invalidate(user); // descarta copias anteriores todavía en cola
    return this.enqueue(user, async () => {
      try {
        signal?.throwIfAborted(); // un timeout mientras se esperaba NO escribe tarde
        const result = await work();
        signal?.throwIfAborted();
        return result;
      } finally {
        this.invalidate(user); // descarta copias capturadas durante el commit
      }
    });
  }
}
