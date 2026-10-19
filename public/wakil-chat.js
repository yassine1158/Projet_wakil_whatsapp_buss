/*
 * Wakil — chat du site web.
 * À coller avant </body> :
 *   <script src="https://VOTRE-WORKER/wakil-chat.js" data-tenant="sicar" defer></script>
 * Options (attributs data-) : tenant (obligatoire), accent (couleur, ex. #e30613),
 * on-accent (couleur du texte posé sur l'accent, blanc par défaut),
 * position (left | right), offset (distance au bas de l'écran en px, par défaut 24),
 * title (titre de la fenêtre), teaser (bulle d'invitation).
 * La page peut piloter le chat : WakilChat.open(), WakilChat.send("Bonjour").
 */
(() => {
  const script = document.currentScript;
  if (!script || window.__wakilChat) return;
  window.__wakilChat = true;

  const API = new URL(script.src).origin;
  const tenant = script.dataset.tenant;
  if (!tenant) return console.warn("Wakil : attribut data-tenant manquant");
  const accent = /^#[0-9a-f]{3,8}$/i.test(script.dataset.accent || "") ? script.dataset.accent : "#2d3a9e";
  const onAccent = /^#[0-9a-f]{3,8}$/i.test(script.dataset.onAccent || "") ? script.dataset.onAccent : "#ffffff";
  const side = script.dataset.position === "right" ? "right" : "left";
  const offset = Math.max(0, Math.min(400, parseInt(script.dataset.offset, 10) || 24));
  // Reprend la police du site (les fichiers de police sont partagés avec le shadow DOM).
  const font = (getComputedStyle(document.body || document.documentElement).fontFamily || "").replace(/[<>{};]/g, "");
  const KEY = `wakil:${tenant}:`;
  const MAX_LOG = 60;

  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem(KEY + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(KEY + k); } catch {} },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(KEY + k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(KEY + k, v); } catch {} },
  };
  const newId = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""))
      .replace(/[^A-Za-z0-9_-]/g, "");

  let sessionId = store.get("session", null) || newId();
  store.set("session", sessionId);
  let log = store.get("log", []);
  let config = { businessName: "", assistantName: "Wakil" };
  let busy = false;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Mise en forme façon WhatsApp : *gras*, _italique_, liens, retours à la ligne.
  const format = (text) =>
    esc(text)
      .replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<strong>$2</strong>")
      .replace(/(^|[\s(])_([^_\n]+)_/g, "$1<em>$2</em>")
      .replace(/\n/g, "<br>");

  const host = document.createElement("div");
  host.id = "wakil-chat";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wk { --accent: ${accent}; --on-accent: ${onAccent}; --ink: #16181d; --muted: #5b616b; --line: #e3e5e8; --bot: #f1f2f4; --paper: #ffffff;
        font-family: ${font ? font + ", " : ""}system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 15px; line-height: 1.45; color: var(--ink); }
  @media (prefers-color-scheme: dark) {
    .wk { --ink: #eceef1; --muted: #a9aeb6; --line: #2c3038; --bot: #23262c; --paper: #17191d; }
  }
  .launcher { position: fixed; ${side}: 24px; bottom: ${offset}px; z-index: 2147483000; width: 60px; height: 60px;
              border: 0; border-radius: 50%; background: var(--accent); color: var(--on-accent); cursor: pointer;
              display: grid; place-items: center; box-shadow: 0 12px 28px -8px rgba(0,0,0,.45);
              transition: transform .25s ease; }
  .launcher:hover { transform: scale(1.06); }
  .launcher:focus-visible, button:focus-visible, textarea:focus-visible, a:focus-visible { outline: 3px solid #f5b400; outline-offset: 2px; }
  .launcher svg { width: 28px; height: 28px; }
  .teaser { position: fixed; ${side}: 96px; bottom: ${offset + 10}px; z-index: 2147483000; max-width: 270px; text-wrap: pretty;
            background: var(--paper); color: var(--ink); border: 1px solid var(--line); border-radius: 14px;
            padding: 10px 34px 10px 14px; box-shadow: 0 10px 30px -10px rgba(0,0,0,.3); font-size: 14px; cursor: pointer; }
  .teaser .x { position: absolute; top: 2px; right: 2px; width: 30px; height: 30px; border: 0; background: none;
               color: var(--muted); cursor: pointer; font-size: 18px; line-height: 1; }
  .panel { position: fixed; ${side}: 24px; bottom: ${offset + 72}px; z-index: 2147483001; width: 370px;
           height: min(580px, calc(100vh - ${offset + 96}px)); background: var(--paper); border: 1px solid var(--line);
           border-radius: 18px; box-shadow: 0 24px 60px -16px rgba(0,0,0,.4); display: flex; flex-direction: column; overflow: hidden; }
  .panel[hidden], .teaser[hidden] { display: none; }
  header { background: var(--accent); color: var(--on-accent); padding: 14px 10px 14px 18px; display: flex; align-items: center; gap: 10px; }
  header .t { flex: 1; min-width: 0; }
  header b { display: block; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header small { display: block; font-size: 12.5px; opacity: .9; }
  header button { width: 44px; height: 44px; border: 0; border-radius: 10px; background: transparent; color: var(--on-accent); cursor: pointer; display: grid; place-items: center; }
  header button:hover { background: color-mix(in srgb, var(--on-accent) 15%, transparent); }
  header svg { width: 20px; height: 20px; }
  .log { flex: 1; overflow-y: auto; padding: 16px 14px; display: flex; flex-direction: column; gap: 8px; overscroll-behavior: contain; }
  .msg { max-width: 85%; padding: 9px 13px; border-radius: 16px; overflow-wrap: anywhere; }
  .bot { align-self: flex-start; background: var(--bot); border-bottom-left-radius: 5px; }
  .me { align-self: flex-end; background: var(--accent); color: var(--on-accent); border-bottom-right-radius: 5px; }
  .me a { color: var(--on-accent); }
  .bot a { color: inherit; text-decoration: underline; }
  .err { align-self: center; color: var(--muted); font-size: 13px; text-align: center; }
  .img { padding: 4px; }
  .img img { display: block; width: 100%; max-width: 260px; border-radius: 12px; }
  .img span { display: block; padding: 6px 8px 4px; font-size: 14px; }
  .typing { align-self: flex-start; background: var(--bot); border-radius: 16px; padding: 12px 14px; display: flex; gap: 4px; }
  .typing i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); animation: wk-dot 1.2s infinite ease-in-out; }
  .typing i:nth-child(2) { animation-delay: .15s; } .typing i:nth-child(3) { animation-delay: .3s; }
  @keyframes wk-dot { 0%, 60%, 100% { opacity: .3; transform: none; } 30% { opacity: 1; transform: translateY(-3px); } }
  @media (prefers-reduced-motion: reduce) { .typing i { animation: none; opacity: .6; } .launcher { transition: none; } }
  form { border-top: 1px solid var(--line); padding: 10px; display: flex; gap: 8px; align-items: flex-end; }
  textarea { flex: 1; resize: none; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; font: inherit;
             color: var(--ink); background: var(--paper); max-height: 120px; min-height: 44px; }
  .send { width: 44px; height: 44px; border: 0; border-radius: 12px; background: var(--accent); color: var(--on-accent); cursor: pointer; display: grid; place-items: center; flex: none; }
  .send:disabled { opacity: .5; cursor: default; }
  .send svg { width: 20px; height: 20px; }
  .foot { padding: 0 12px 10px; font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; gap: 8px; }
  .foot button { border: 0; background: none; padding: 0; color: var(--muted); text-decoration: underline; cursor: pointer; font: inherit; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  @media (max-width: 480px) {
    .panel { inset: 0; width: auto; height: 100%; border-radius: 0; border: 0; }
    .teaser { ${side}: 92px; max-width: calc(100vw - 120px); }
  }
</style>
<div class="wk">
  <div class="teaser" hidden><span class="tx"></span><button class="x" type="button" aria-label="Fermer">×</button></div>
  <button class="launcher" type="button" aria-expanded="false" aria-controls="wk-panel" aria-label="Ouvrir le chat">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg>
  </button>
  <section class="panel" id="wk-panel" role="dialog" aria-label="Chat" hidden>
    <header>
      <div class="t"><b class="title">Assistant</b><small>Assistant virtuel · répond en quelques secondes</small></div>
      <button class="close" type="button" aria-label="Fermer le chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </header>
    <div class="log" role="log" aria-live="polite"></div>
    <form>
      <label class="sr" for="wk-input">Votre message</label>
      <textarea id="wk-input" rows="1" maxlength="1000" placeholder="Écrivez votre message…"></textarea>
      <button class="send" type="submit" aria-label="Envoyer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </button>
    </form>
    <div class="foot"><span>Assistant virtuel : l'équipe confirme prix et livraison.</span><button class="reset" type="button">Effacer</button></div>
  </section>
</div>`;
  (document.body || document.documentElement).appendChild(host);

  const $ = (s) => root.querySelector(s);
  const launcher = $(".launcher"), panel = $(".panel"), logEl = $(".log"), form = $("form"), input = $("textarea"),
        send = $(".send"), teaser = $(".teaser");

  const greeting = () =>
    script.dataset.greeting ||
    `Bonjour 👋 Je suis ${config.assistantName}, l'assistant virtuel${config.businessName ? ` de ${config.businessName}` : ""}. ` +
      "Une question sur nos produits, une quantité à estimer ou un devis ?";

  function bubble(entry) {
    const el = document.createElement("div");
    if (entry.type === "image") {
      el.className = "msg bot img";
      el.innerHTML = `<img src="${esc(entry.url)}" alt="${esc(entry.caption || "Photo du produit")}" loading="lazy">` +
        (entry.caption ? `<span>${format(entry.caption)}</span>` : "");
    } else if (entry.from === "error") {
      el.className = "err";
      el.textContent = entry.text;
    } else {
      el.className = `msg ${entry.from === "me" ? "me" : "bot"}`;
      el.innerHTML = format(entry.text);
    }
    return el;
  }

  function render() {
    logEl.replaceChildren(bubble({ from: "bot", text: greeting() }), ...log.map(bubble));
    logEl.scrollTop = logEl.scrollHeight;
  }

  function push(entry) {
    if (entry.from !== "error") {
      log.push(entry);
      log = log.slice(-MAX_LOG);
      store.set("log", log);
    }
    logEl.appendChild(bubble(entry));
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setOpen(open) {
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    launcher.setAttribute("aria-label", open ? "Fermer le chat" : "Ouvrir le chat");
    session.set("open", open ? "1" : "0");
    if (open) {
      teaser.hidden = true;
      session.set("teased", "1");
      render();
      setTimeout(() => input.focus(), 50);
    }
  }

  const ERRORS = {
    429: "Trop de messages d'un coup : patientez une minute, puis réessayez.",
    default: "Connexion impossible pour le moment. Réessayez dans un instant.",
  };

  async function sendMessage(text) {
    if (busy || !text) return;
    busy = true;
    send.disabled = true;
    push({ from: "me", text });
    const typing = document.createElement("div");
    typing.className = "typing";
    typing.setAttribute("aria-label", "L'assistant écrit");
    typing.innerHTML = "<i></i><i></i><i></i>";
    logEl.appendChild(typing);
    logEl.scrollTop = logEl.scrollHeight;
    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenant, session: sessionId, text }),
      });
      typing.remove();
      if (!res.ok) throw Object.assign(new Error("http"), { status: res.status });
      const data = await res.json();
      for (const r of data.replies || []) {
        if (r.type === "image") push({ type: "image", url: r.url, caption: r.caption });
        else push({ from: "bot", text: r.text });
      }
    } catch (err) {
      typing.remove();
      push({ from: "error", text: ERRORS[err.status] || ERRORS.default });
    } finally {
      busy = false;
      send.disabled = false;
      input.focus();
    }
  }

  launcher.addEventListener("click", () => setOpen(panel.hidden));
  $(".close").addEventListener("click", () => { setOpen(false); launcher.focus(); });
  // Sur le document : Échap ferme le chat même quand le focus est ailleurs dans la page.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { setOpen(false); launcher.focus(); } });
  teaser.addEventListener("click", (e) => {
    if (e.target.closest(".x")) { teaser.hidden = true; session.set("teased", "1"); return; }
    setOpen(true);
  });
  $(".reset").addEventListener("click", () => {
    log = [];
    store.del("log");
    sessionId = newId();
    store.set("session", sessionId);
    render();
    input.focus();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim().slice(0, 1000);
    input.value = "";
    input.style.height = "";
    sendMessage(text);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  // Pour la page hôte : WakilChat.open(), WakilChat.send("question").
  window.WakilChat = {
    open: () => setOpen(true),
    close: () => setOpen(false),
    send: (text) => { setOpen(true); sendMessage(String(text || "").trim().slice(0, 1000)); },
  };

  fetch(`${API}/chat/config?tenant=${encodeURIComponent(tenant)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((c) => {
      config = { ...config, ...c };
      $(".title").textContent = script.dataset.title || `Assistant ${config.businessName}`.trim();
      panel.setAttribute("aria-label", $(".title").textContent);
      if (!panel.hidden) render();
    })
    .catch(() => {});

  if (session.get("open") === "1") setOpen(true);
  else if (!session.get("teased") && !log.length) {
    // Propose le chat une fois par visite, après quelques secondes.
    setTimeout(() => {
      if (!panel.hidden) return;
      $(".tx").textContent = script.dataset.teaser || "Une question ? Je vous réponds tout de suite.";
      teaser.hidden = false;
    }, 6000);
  }
})();
