// Lectura segura de respuestas de la API (/api/*).
// Regla: primero se comprueba el estado HTTP; solo después se interpreta el cuerpo como JSON.
// Nunca se muestra al usuario el cuerpo crudo (puede ser una página HTML o de texto del proveedor).

export class ApiResponseError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ApiResponseError";
  }
}

const NOT_AVAILABLE_HINT =
  "El servicio de análisis no está disponible en este despliegue. Revisa que las funciones /api estén desplegadas.";

const TOO_LARGE_HINT =
  "El documento supera el tamaño que admite el servicio de análisis en este despliegue (límite de 4,5 MB de la petición en Vercel).";

/** Devuelve el JSON de la respuesta o lanza un ApiResponseError con un mensaje comprensible. */
export async function readApiJson<T = any>(response: Response, fallbackMessage: string): Promise<T> {
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = undefined; // cuerpo no JSON
  }

  if (!response.ok) {
    if (data && typeof data.error === "string" && data.error) {
      throw new ApiResponseError(data.error, response.status);
    }
    const detail =
      response.status === 404 ? NOT_AVAILABLE_HINT
      : response.status === 413 ? TOO_LARGE_HINT
      : fallbackMessage;
    throw new ApiResponseError(`${detail} (HTTP ${response.status})`, response.status);
  }

  if (data === undefined || data === null) {
    throw new ApiResponseError(
      `${fallbackMessage} La respuesta del servidor no es válida (no es JSON).`,
      response.status
    );
  }
  return data as T;
}
