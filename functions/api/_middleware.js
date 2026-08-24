import { isAuthorized, json } from "../_lib/auth.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.pathname === "/api/auth") {
    return context.next();
  }

  if (!(await isAuthorized(context.request, context.env))) {
    return json({ error: "Sign in with the tester password." }, 401);
  }

  return context.next();
}
