import { hashesEqual, json, sessionCookie, signSession } from "../_lib/auth.js";

export async function onRequestPost(context) {
  const expected = context.env.DOWNLOADS_PASSWORD || "";
  if (!expected) {
    return json({ error: "Downloads are not configured yet." }, 503);
  }

  let password = "";
  try {
    const body = await context.request.json();
    password = typeof body.password === "string" ? body.password : "";
  } catch {
    return json({ error: "Send the password as JSON." }, 400);
  }

  if (!(await hashesEqual(password, expected))) {
    return json({ error: "That password is not correct." }, 401);
  }

  const token = await signSession(expected);
  return json(
    { ok: true },
    200,
    { "Set-Cookie": sessionCookie(token, context.request.url) },
  );
}
