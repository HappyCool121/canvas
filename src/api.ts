export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
    });
  } catch (error) {
    if ((error as Error).name === "AbortError")
      throw new Error(
        "This request was interrupted. Your prompt is saved; you can retry.",
      );
    throw new Error(
      "Cannot reach the local server. Make sure Canvas is running (npm run dev), then retry.",
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data)
    throw Object.assign(
      new Error(
        data?.error?.message ||
          "The server could not complete the request. Please retry.",
      ),
      { code: data?.error?.code as string | undefined },
    );
  return data as T;
}
