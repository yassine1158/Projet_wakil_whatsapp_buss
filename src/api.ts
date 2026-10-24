import { createToken, hashPassword, samePassword, verifyPassword, verifyToken, type Role } from "./auth";
import { loadCatalog } from "./catalog";
import { completeWhatsappSignup, parseTenantInput, TENANT_ID_RE } from "./companies";
import { defaultBrain } from "./brain";
import { checkClaude } from "./diagnostic";
import { LEAD_STATUSES, ORDER_STATUSES, type LeadStatus, type OrderStatus } from "./inbox-types";
import { INBOX_NAME, webConversation } from "./names";
import { configTenantIds, invalidateTenants, listTenants, tenantById } from "./registry";
import type { Env, Tenant } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const SESSION_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * API de l'application (/app). Tout passe par un jeton de session, sauf /api/login.
 * L'administrateur voit toutes les entreprises ; un patron ne voit que la sienne.
 */
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const secret = env.ADMIN_PASSWORD;
  if (!secret) return json({ error: "not_configured" }, 503);
  const route = url.pathname.slice("/api/".length).split("/").map(decodeURIComponent);
  const method = request.method;
  const inbox = env.INBOX.get(env.INBOX.idFromName(INBOX_NAME));
  const body = method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

  if (route[0] === "login" && method === "POST") {
    if (env.CHAT_LIMITER) {
      const { success } = await env.CHAT_LIMITER.limit({ key: `login:${request.headers.get("cf-connecting-ip") ?? "inconnu"}` });
      if (!success) return json({ error: "rate_limited" }, 429);
    }
    const login = typeof body.login === "string" ? body.login.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    let role: Role | null = null;
    if (!login || login === "admin") {
      if (await samePassword(password, secret)) role = { kind: "admin" };
    } else if (TENANT_ID_RE.test(login)) {
      const stored = await inbox.tenantSecrets(login);
      if (stored?.passwordHash && (await verifyPassword(password, stored.passwordHash))) role = { kind: "tenant", tenantId: login };
    }
    if (!role) return json({ error: "wrong_password" }, 401);
    return json({ token: await createToken(secret, role, Date.now()) });
  }

  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const role = await verifyToken(secret, token, Date.now());
  if (!role) return json({ error: "unauthorized" }, 401);
  const isAdmin = role.kind === "admin";
  // Un patron dont l'entreprise a été supprimée n'a plus accès.
  if (role.kind === "tenant" && !(await tenantById(env, role.tenantId))) return json({ error: "unauthorized" }, 401);

  const asked = url.searchParams.get("tenant") ?? (typeof body.tenant === "string" ? body.tenant : "");
  const tenant = await tenantById(env, role.kind === "tenant" ? role.tenantId : asked);
  const mine = (tenantId: string) => isAdmin || (role.kind === "tenant" && role.tenantId === tenantId);
  const adminOnly = () => json({ error: "forbidden" }, 403);

  switch (`${method} ${route[0]}`) {
    case "GET me":
      return json({
        role: role.kind,
        tenantId: role.kind === "tenant" ? role.tenantId : null,
        metaSignup: isAdmin && env.META_APP_ID && env.META_CONFIG_ID ? { appId: env.META_APP_ID, configId: env.META_CONFIG_ID } : null,
      });

    case "GET tenants":
      return json(
        (await listTenants(env))
          .filter((t) => mine(t.id))
          .map((t) => ({ id: t.id, businessName: t.businessName, assistantName: t.assistantName, demo: !!t.demo })),
      );

    case "GET overview": {
      if (!tenant) return json({ error: "unknown_tenant" }, 404);
      const overview = await inbox.overview(tenant.id, Date.now());
      return json(isAdmin ? overview : { ...overview, newLeads: 0 });
    }

    case "GET conversations": {
      if (route[1]) {
        const key = route[1];
        const row = await inbox.getConversation(key);
        if (!row || !mine(row.tenant)) return json({ error: "not_found" }, 404);
        const transcript = await env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(key)).transcript();
        return json({ ...row, log: transcript.log, handoffUntil: transcript.handoffUntil });
      }
      if (!tenant) return json({ error: "unknown_tenant" }, 404);
      return json(await inbox.listConversations(tenant.id, url.searchParams.get("q") ?? ""));
    }

    case "POST conversations": {
      const [, key, action] = route;
      const row = key ? await inbox.getConversation(key) : null;
      if (!row || !mine(row.tenant)) return json({ error: "not_found" }, 404);
      const conversation = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(key));
      if (action === "pause") {
        await conversation.pause((await tenantById(env, row.tenant))?.handoffHours ?? 12);
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
      if (!tenant) return json({ error: "unknown_tenant" }, 404);
      return json(await inbox.listOrders(tenant.id));

    case "POST orders": {
      const status = body.status as OrderStatus;
      if (!route[1] || !ORDER_STATUSES.includes(status)) return json({ error: "bad_request" }, 400);
      const owner = await inbox.orderTenant(route[1]);
      if (!owner || !mine(owner)) return json({ error: "not_found" }, 404);
      return (await inbox.setOrderStatus(route[1], status)) ? json({ ok: true }) : json({ error: "not_found" }, 404);
    }

    case "GET leads":
      return isAdmin ? json(await inbox.listLeads()) : adminOnly();

    // Wakil Brain en mode ombre : accord avec Claude (route[1] vide) ou export pour l'entraîner (route[1] = "export").
    case "GET brain": {
      if (!isAdmin) return adminOnly();
      const only = url.searchParams.get("tenant") || null;
      if (route[1] === "export") {
        const samples = (await inbox.brainSamples(only, 20000)).map(({ context, text, predicted, teacher, at }) => ({ context, text, predicted, teacher, at }));
        return json({ format: "wakil-brain-samples-1", samples });
      }
      return json({ stats: await inbox.brainStats(only), model: defaultBrain().metadata });
    }

    case "POST leads": {
      if (!isAdmin) return adminOnly();
      const status = body.status as LeadStatus;
      if (!/^\d+$/.test(route[1] ?? "") || !LEAD_STATUSES.includes(status)) return json({ error: "bad_request" }, 400);
      return (await inbox.setLeadStatus(Number(route[1]), status)) ? json({ ok: true }) : json({ error: "not_found" }, 404);
    }

    case "POST test-chat": {
      if (!tenant) return json({ error: "unknown_tenant" }, 404);
      const session = typeof body.session === "string" ? body.session : "";
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!SESSION_RE.test(session) || !text || text.length > 1000) return json({ error: "bad_request" }, 400);
      const stub = env.CONVERSATIONS.get(env.CONVERSATIONS.idFromName(webConversation(tenant.id, `test-${session}`)));
      return json({ replies: await stub.chat(tenant.id, `test-${session}`, text, { test: true }) });
    }

    case "GET diagnostic":
      return isAdmin ? json(await checkClaude(env)) : adminOnly();

    case "GET settings": {
      if (!tenant) return json({ error: "unknown_tenant" }, 404);
      let products: { name: string; available: boolean; price: string; unit: string }[] = [];
      let catalogError = false;
      try {
        products = (await loadCatalog(tenant)).products.map(({ name, available, price, unit }) => ({ name, available, price, unit }));
      } catch {
        catalogError = true;
      }
      return json({
        isAdmin,
        businessName: tenant.businessName,
        assistantName: tenant.assistantName,
        whatsappConfigured: !!tenant.whatsapp,
        whatsappPhone: tenant.whatsapp?.displayPhone ?? null,
        ownerPhone: tenant.ownerPhone,
        webhookUrl: `${url.origin}/webhook`,
        widgetSnippet: `<script src="${url.origin}/wakil-chat.js" data-tenant="${tenant.id}" defer></script>`,
        webOrigins: tenant.webOrigins ?? [],
        catalogUrl: tenant.catalog.productsUrl ?? null,
        products,
        catalogError,
        model: env.CLAUDE_MODEL ?? "claude-opus-5-5",
      });
    }

    case "GET companies":
    case "POST companies":
      if (!isAdmin) return adminOnly();
      return handleCompanies(method, route.slice(1), body, env, url);
  }
  return json({ error: "not_found" }, 404);
}

/** Entreprises (administrateur seulement) : liste, fiche, mot de passe du patron, WhatsApp. */
async function handleCompanies(
  method: string,
  [id, action, step]: string[],
  body: Record<string, unknown>,
  env: Env,
  url: URL,
): Promise<Response> {
  const inbox = env.INBOX.get(env.INBOX.idFromName(INBOX_NAME));
  const fromConfig = configTenantIds();
  const stored = new Map((await inbox.listTenants()).map((s) => [s.tenant.id, s]));
  const describe = (t: Tenant) => ({
    tenant: t,
    inConfig: fromConfig.has(t.id),
    editedInApp: stored.has(t.id),
    hasPassword: !!stored.get(t.id)?.hasPassword,
    hasWhatsappToken: !!stored.get(t.id)?.hasWhatsappToken,
  });
  const saved = async (t: Tenant) => {
    await inbox.saveTenant(t, Date.now());
    invalidateTenants();
    return json(describe(t));
  };

  if (method === "GET") {
    if (!id) return json((await listTenants(env)).map(describe));
    const t = await tenantById(env, id);
    return t ? json(describe(t)) : json({ error: "not_found" }, 404);
  }

  // Création ou modification de la fiche
  if (!id || id === "new") {
    const creating = id === "new";
    const existing = creating ? undefined : await tenantById(env, String(body.id ?? ""));
    if (creating && (await tenantById(env, String(body.id ?? "")))) return json({ error: "already_exists", field: "id" }, 409);
    if (!creating && !existing) return json({ error: "not_found" }, 404);
    const parsed = parseTenantInput(body, existing);
    return "error" in parsed ? json(parsed, 400) : saved(parsed);
  }

  const tenant = await tenantById(env, id);
  if (!tenant) return json({ error: "not_found" }, 404);
  // Une entreprise du fichier de configuration a besoin d'une ligne en base pour ses secrets.
  if (!stored.has(id)) await inbox.saveTenant(tenant, Date.now());

  if (action === "password") {
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < 8 || password.length > 200) return json({ error: "weak_password", field: "password" }, 400);
    await inbox.setTenantPassword(id, await hashPassword(password));
    return json({ ok: true, login: id });
  }

  if (action === "delete") {
    await inbox.deleteTenant(id);
    invalidateTenants();
    // Une entreprise du fichier de configuration revient simplement à sa version d'origine.
    return json({ ok: true, revertedToConfig: fromConfig.has(id) });
  }

  if (action === "whatsapp") {
    const others = (await listTenants(env)).filter((t) => t.id !== id);
    if (step === "disconnect") {
      await inbox.setTenantWhatsappSecrets(id, null, null);
      const { whatsapp: _removed, ...rest } = tenant;
      return saved(rest);
    }
    if (step === "signup") {
      if (!env.META_APP_ID || !env.WHATSAPP_APP_SECRET) return json({ error: "meta_not_configured" }, 400);
      const code = String(body.code ?? ""), phoneNumberId = String(body.phoneNumberId ?? ""), wabaId = String(body.wabaId ?? "");
      if (!code || !/^\d{5,25}$/.test(phoneNumberId) || !/^\d{5,25}$/.test(wabaId)) return json({ error: "bad_request" }, 400);
      if (others.some((t) => t.whatsapp?.phoneNumberId === phoneNumberId)) return json({ error: "number_in_use" }, 409);
      try {
        const result = await completeWhatsappSignup({
          appId: env.META_APP_ID,
          appSecret: env.WHATSAPP_APP_SECRET,
          apiVersion: env.GRAPH_API_VERSION ?? "v23.0",
          code,
          phoneNumberId,
          wabaId,
        });
        await inbox.setTenantWhatsappSecrets(id, result.token, result.pin);
        return saved({ ...tenant, whatsapp: { phoneNumberId, wabaId, displayPhone: result.displayPhone } });
      } catch (err) {
        return json({ error: "meta_error", message: (err as Error).message }, 502);
      }
    }
    // Liaison à la main : numéro géré dans le compte WhatsApp de la plateforme (ou jeton fourni).
    const phoneNumberId = String(body.phoneNumberId ?? "").trim();
    if (!/^\d{5,25}$/.test(phoneNumberId)) return json({ error: "invalid", field: "phoneNumberId" }, 400);
    if (others.some((t) => t.whatsapp?.phoneNumberId === phoneNumberId)) return json({ error: "number_in_use" }, 409);
    const token = typeof body.token === "string" && body.token.trim() ? body.token.trim() : null;
    await inbox.setTenantWhatsappSecrets(id, token, null);
    const displayPhone = typeof body.displayPhone === "string" ? body.displayPhone.trim().slice(0, 30) : "";
    return saved({ ...tenant, whatsapp: { phoneNumberId, ...(displayPhone ? { displayPhone } : {}) } });
  }

  void url;
  return json({ error: "not_found" }, 404);
}
