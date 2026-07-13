export async function onRequestError(
  error: unknown,
  request: {
    path: string;
    method: string;
    headers: { [key: string]: string | string[] };
  },
  context: {
    routerKind: "Pages Router" | "App Router";
    routePath: string;
    routeType: "render" | "route" | "action" | "proxy";
  }
): Promise<void> {
  // instrumentation is bundled for Edge too — never statically import Node-only modules
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  const err = error instanceof Error ? error : new Error(String(error));
  const path = request.path || context.routePath || "unknown";
  const isCriticalAuthPath =
    path.includes("/api/web-token") || path.includes("/api/get-token") || path.includes("/api/chat/");
  const code = (err as NodeJS.ErrnoException).code;
  const isModuleInterop =
    code === "ERR_REQUIRE_ESM" ||
    err.message.includes("ERR_REQUIRE_ESM") ||
    err.message.includes("require() of ES Module");

  if (!isCriticalAuthPath && !isModuleInterop) {
    return;
  }

  const { sendOpsAlert } = await import("@/utils/server/emailOps");
  await sendOpsAlert(
    `Unhandled ${request.method || "REQ"} ${path}`,
    `Unhandled error on ${path}: ${err.message}`,
    {
      error: err,
      stack: err.stack,
      context: {
        path,
        method: request.method,
        routePath: context.routePath,
        routerKind: context.routerKind,
        routeType: context.routeType,
        errorCode: code,
      },
    },
    {
      throttleKey: `onRequestError:${path}:${code || err.name}`,
      throttleMs: 15 * 60 * 1000,
    }
  ).catch((alertError) => {
    console.error("Failed to send onRequestError ops alert:", alertError);
  });
}
