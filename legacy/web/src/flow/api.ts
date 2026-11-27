/**
 * The browser's only door to the server. Same-origin requests carry the
 * httpOnly session cookie automatically; the custom header marks them as
 * coming from this app (the server's CSRF guard requires it).
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Called whenever the server says the session is gone (expired, signed out elsewhere). */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "X-Flow-Request": "1",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Cannot reach the server. Check the network connection and try again.");
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; code?: string };
    if (res.status === 401 && !path.startsWith("/auth/login")) {
      unauthorizedListeners.forEach((fn) => fn());
    }
    throw new ApiError(res.status, err.error ?? `Request failed (${res.status}).`, err.code);
  }
  return data as T;
}

/** Sends one JPEG (the gate photo) as the request body. */
export async function apiUpload(path: string, photo: Blob): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-Flow-Request": "1", "Content-Type": "image/jpeg" },
      body: photo,
    });
  } catch {
    throw new ApiError(0, "Cannot reach the server. Check the network connection and try again.");
  }
  if (!res.ok) {
    const err = ((await res.json().catch(() => null)) ?? {}) as { error?: string };
    if (res.status === 401) unauthorizedListeners.forEach((fn) => fn());
    throw new ApiError(res.status, err.error ?? `The photo was not saved (${res.status}).`);
  }
}
