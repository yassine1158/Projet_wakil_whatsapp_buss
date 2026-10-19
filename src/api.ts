import { createToken, samePassword, verifyToken } from "./auth";
import { loadCatalog } from "./catalog";
import { checkClaude } from "./diagnostic";
import { LEAD_STATUSES, ORDER_STATUSES, type LeadStatus, type OrderStatus } from "./inbox-do";
import { INBOX_NAME, webConversation } from "./names";
import { allTenants, findTenantById } from "./tenants";
import type { Env } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * API de l'application (/app). Tout passe par un jeton obtenu avec ADMIN_PASSWORD,
 * sauf /api/login.
 */
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const password = env.ADMIN_PASSWORD;
  if (!password) return json({ error: "not_configured" }, 503);
  const route = url.pathname.slice("/api/".length).split("/").map(decodeURIComponent);
  const method = request.method;

  if (route[0] === "login" && method === "POST") {
    if (env.CHAT_LIMITER) {
      const { success } = await env.CHAT_LIMITER.limit({ key: `login:${request.headers.get("cf-connecting-ip") ?? "inconnu"}` });
      if (!success) return json({ error: "rate_limited" }, 429);
    }
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    if (typeof body.password !== "string" || !(await samePassword(body.password, password))) {
      return json({ error: "wrong_password" }, 401);
    }
    return json({ token: await createToken(password, Date.now()) });
  }

  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!(await verifyToken(password, token, Date.now()))) return json({ error: "unauthorized" }, 401);

  const inbox = env.INBOX.get(env.INBOX.idFromName(INBOX_NAME));
  const body = method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const tenantParam = url.searchParams.get("tenant") ?? (typeof body.tenant === "string" ? body.tenant : "");
  const found = findTenantById(tenantParam);

  switch (`${method} ${route[0]}`) {
    case "GET tenants":
      return json(
        allTenants().map(({ tenant }) => ({
          id: tenant.id,
          businessName: tenant.businessName,
          assistantName: tenant.assistantName,
          demo: !!tenant.demo,
        })),
      );

    case "GET overview":
      if (!found) return json({ error: "unknown_tenant" }, 404);
      return json(await inbox.overview(found.tenant.id, Date.now()));

    case "GET conversations": {
      if (route[1]) {
        const key = route[1];
        const row = await inbox.getConversation(key);
        if (!row) return json({ error: "not_found" }, 404);
        const transcript = await env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(key)).transcript();
        return json({ ...row, log: transcript.log, handoffUntil: transcript.handoffUntil });
      }
      if (!found) return json({ error: "unknown_tenant" }, 404);
      return json(await inbox.listConversations(found.tenant.id, url.searchParams.get("q") ?? ""));
    }

    case "POST conversations": {
      const [, key, action] = route;
      const row = key ? await inbox.getConversation(key) : null;
      if (!row) return json({ error: "not_found" }, 404);
      const conversation = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(key));
      if (action === "pause") {
        const tenant = findTenantById(row.tenant)?.tenant;
        await conversation.pause(tenant?.handoffHours ?? 12);
        return json({ ok: true });
      }
      if (action === "resume") {
        await conversation.resume();
        return json({ ok: true });
      }
      if (action === "reply") {
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (!text || text.length > 4000) return json({ error: "bad_request" }, 400);
        const result = await conversation.teamReply(text);
        return json(result, result.ok ? 200 : 409);
      }
      return json({ error: "not_found" }, 404);
    }

    case "GET orders":
      if (!found) return json({ error: "unknown_tenant" }, 404);
      return json(await inbox.listOrders(found.tenant.id));

    case "POST orders": {
      const status = body.status as OrderStatus;
      if (!route[1] || !ORDER_STATUSES.includes(status)) return json({ error: "bad_request" }, 400);
      return (await inbox.setOrderStatus(route[1], status)) ? json({ ok: true }) : json({ error: "not_found" }, 404);
    }

    case "GET leads":
      return json(await inbox.listLeads());

    case "POST leads": {
      const status = body.status as LeadStatus;
      if (!/^\d+$/.test(route[1] ?? "") || !LEAD_STATUSES.includes(status)) return json({ error: "bad_request" }, 400);
      return (await inbox.setLeadStatus(Number(route[1]), status)) ? json({ ok: true }) : json({ error: "not_found" }, 404);
    }

    case "POST test-chat": {
      if (!found) return json({ error: "unknown_tenant" }, 404);
      const session = typeof body.session === "string" ? body.session : "";
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!SESSION_RE.test(session) || !text || text.length > 1000) return json({ error: "bad_request" }, 400);
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(webConversation(found.tenant.id, `test-${session}`)));
      return json({ replies: await stub.chat(found.phoneNumberId, `test-${session}`, text, { test: true }) });
    }

    case "GET diagnostic":
      return json(await checkClaude(env));

    case "GET settings": {
      if (!found) return json({ error: "unknown_tenant" }, 404);
      const { tenant, phoneNumberId } = found;
      let products: { name: string; available: boolean; price: string; unit: string }[] = [];
      let catalogError = false;
      try {
        products = (await loadCatalog(tenant)).products.map(({ name, available, price, unit }) => ({ name, available, price, unit }));
      } catch {
        catalogError = true;
      }
      return json({
        businessName: tenant.businessName,
        assistantName: tenant.assistantName,
        whatsappConfigured: !/^REMPLACER|^DEMO$/.test(phoneNumberId),
        ownerPhone: tenant.ownerPhone,
        webhookUrl: `${url.origin}/webhook`,
        widgetSnippet: `<script src="${url.origin}/wakil-chat.js" data-tenant="${tenant.id}" defer></script>`,
        webOrigins: tenant.webOrigins ?? [],
        catalogUrl: tenant.catalog.productsUrl,
        products,
        catalogError,
        model: env.CLAUDE_MODEL ?? "claude-opus-5-5",
      });
    }
  }
  return json({ error: "not_found" }, 404);
}
