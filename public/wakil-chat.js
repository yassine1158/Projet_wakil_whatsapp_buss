/*
 * Wakil — chat du site web.
 * À coller avant </body> :
 *   <script src="https://VOTRE-WORKER/wakil-chat.js" data-tenant="sicar" defer></script>
 * Options (attributs data-) : tenant (obligatoire), accent (couleur, ex. #e30613),
 * on-accent (couleur du texte posé sur l'accent, blanc par défaut),
 * position (left | right), offset (distance au bas de l'écran en px, par défaut 24),
 * title (titre de la fenêtre), teaser (bulle d'invitation, « off » pour ne pas la montrer), greeting (message d'accueil),
 * suggestions (questions proposées au départ, séparées par « | »),
 * voice (« off » pour masquer le micro et le bouton « Appeler »).
 * La page peut piloter le chat : WakilChat.open(), WakilChat.send("Bonjour"), WakilChat.call().
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
  let call = null; // appel en direct en cours (voir plus bas)

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
  .cta { align-self: flex-start; display: inline-flex; align-items: center; gap: 8px; padding: 10px 16px; border-radius: 999px;
         background: #25d366; color: #fff; font-weight: 700; text-decoration: none; box-shadow: 0 6px 16px -8px rgba(0,0,0,.4); }
  .cta svg { width: 18px; height: 18px; flex: none; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; }
  .chips button { border: 1.5px solid var(--accent); background: var(--paper); color: var(--ink); border-radius: 999px;
                  padding: 8px 13px; font: inherit; font-size: 14px; cursor: pointer; text-align: left; }
  .chips button:hover { background: var(--accent); color: var(--on-accent); }
  .img { padding: 4px; }
  .img img { display: block; width: 100%; max-width: 260px; border-radius: 12px; }
  .img span { display: block; padding: 6px 8px 4px; font-size: 14px; }
  .typing { align-self: flex-start; background: var(--bot); border-radius: 16px; padding: 12px 14px; display: flex; gap: 4px; }
  .typing i { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); animation: wk-dot 1.2s infinite ease-in-out; }
  .typing i:nth-child(2) { animation-delay: .15s; } .typing i:nth-child(3) { animation-delay: .3s; }
  @keyframes wk-dot { 0%, 60%, 100% { opacity: .3; transform: none; } 30% { opacity: 1; transform: translateY(-3px); } }
  @media (prefers-reduced-motion: reduce) { .typing i { animation: none; opacity: .6; } .launcher { transition: none; } .mic.rec { animation: none; } }
  form { border-top: 1px solid var(--line); padding: 10px; display: flex; gap: 8px; align-items: flex-end; }
  textarea { flex: 1; resize: none; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; font: inherit;
             color: var(--ink); background: var(--paper); max-height: 120px; min-height: 44px; }
  .send { width: 44px; height: 44px; border: 0; border-radius: 12px; background: var(--accent); color: var(--on-accent); cursor: pointer; display: grid; place-items: center; flex: none; }
  .send:disabled { opacity: .5; cursor: default; }
  .send svg { width: 20px; height: 20px; }
  .mic { width: 44px; height: 44px; border: 1.5px solid var(--accent); border-radius: 12px; background: var(--paper); color: var(--accent);
         cursor: pointer; display: grid; place-items: center; flex: none; }
  .mic svg { width: 20px; height: 20px; }
  .mic[hidden] { display: none; }
  .mic.rec { background: #d93025; border-color: #d93025; color: #fff; animation: wk-pulse 1.2s infinite; }
  .mic.talk { background: var(--accent); color: var(--on-accent); }
  .mic:disabled { opacity: .5; cursor: default; animation: none; }
  @keyframes wk-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(217,48,37,.45); } 50% { box-shadow: 0 0 0 7px rgba(217,48,37,0); } }
  .status { padding: 0 12px; min-height: 0; font-size: 12.5px; color: var(--muted); }
  header .dial { width: auto; height: 36px; padding: 0 12px; gap: 6px; display: inline-flex; align-items: center; border-radius: 999px;
                 border: 1.5px solid color-mix(in srgb, var(--on-accent) 45%, transparent); font: inherit; font-size: 14px; font-weight: 600; }
  header .dial svg { width: 16px; height: 16px; }
  header .dial[hidden] { display: none; }
  form[hidden], .callbar[hidden] { display: none; }
  .callbar { border-top: 1px solid var(--line); padding: 12px; display: flex; align-items: center; gap: 12px; }
  .callbar .dot { width: 14px; height: 14px; border-radius: 50%; background: var(--accent); flex: none; transition: transform .08s linear; }
  .callbar[data-state="thinking"] .dot { animation: wk-blink 1s infinite; }
  .callbar .ci { flex: 1; min-width: 0; display: grid; }
  .callbar .ci b { font-size: 14px; font-weight: 600; }
  .callbar time { font-size: 12.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .hang { display: inline-flex; align-items: center; gap: 6px; height: 44px; padding: 0 16px; border: 0; border-radius: 999px;
          background: #d93025; color: #fff; font: inherit; font-weight: 600; cursor: pointer; flex: none; }
  .hang svg { width: 18px; height: 18px; }
  @keyframes wk-blink { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .callbar .dot { transition: none; animation: none !important; } }
  .status:empty { display: none; }
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
      <button class="dial" type="button" aria-label="Appeler l'assistant" title="Parler à l'assistant comme au téléphone" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>
        <span>Appeler</span>
      </button>
      <button class="close" type="button" aria-label="Fermer le chat">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </header>
    <div class="log" role="log" aria-live="polite"></div>
    <div class="callbar" hidden>
      <span class="dot" aria-hidden="true"></span>
      <div class="ci"><b class="cs" role="status" aria-live="polite">Connexion…</b><time>00:00</time></div>
      <button class="hang" type="button">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        <span>Raccrocher</span>
      </button>
    </div>
    <form>
      <label class="sr" for="wk-input">Votre message</label>
      <textarea id="wk-input" rows="1" maxlength="1000" placeholder="Écrivez votre message…"></textarea>
      <button class="mic" type="button" aria-label="Parler à l'assistant" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
      </button>
      <button class="send" type="submit" aria-label="Envoyer">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>
      </button>
    </form>
    <div class="status" role="status" aria-live="polite"></div>
    <div class="foot"><span>Assistant virtuel : l'équipe confirme prix et livraison.</span><button class="reset" type="button">Effacer</button></div>
  </section>
</div>`;
  (document.body || document.documentElement).appendChild(host);

  const $ = (s) => root.querySelector(s);
  const launcher = $(".launcher"), panel = $(".panel"), logEl = $(".log"), form = $("form"), input = $("textarea"),
        send = $(".send"), teaser = $(".teaser"), mic = $(".mic"), statusEl = $(".status");

  const greeting = () =>
    script.dataset.greeting ||
    `Bonjour 👋 Je suis ${config.assistantName}, l'assistant virtuel${config.businessName ? ` de ${config.businessName}` : ""}. ` +
      "Une question sur nos produits, une quantité à estimer ou un devis ?";

  const suggestions = (script.dataset.suggestions || "").split("|").map((x) => x.trim()).filter(Boolean).slice(0, 6);
  const WA_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 2.9 2.9 0 0 0-.9 2.2c0 1.3.9 2.5 1.1 2.7.1.2 1.8 2.8 4.4 3.9 1.6.7 2.3.8 3.1.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2l-.5-.3z"/></svg>';

  function bubble(entry) {
    const el = document.createElement("div");
    if (entry.type === "link") {
      // seuls les liens WhatsApp préparés par Wakil sont affichés
      if (!/^https:\/\/wa\.me\//.test(entry.url || "")) return document.createTextNode("");
      const a = document.createElement("a");
      a.className = "cta"; a.href = entry.url; a.target = "_blank"; a.rel = "noopener";
      a.innerHTML = `${WA_ICON}<span>${esc(entry.label)}</span>`;
      return a;
    }
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

  function chips() {
    const box = document.createElement("div");
    box.className = "chips";
    for (const q of suggestions) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = q;
      b.addEventListener("click", () => sendMessage(q));
      box.appendChild(b);
    }
    return box;
  }

  function render() {
    const start = [bubble({ from: "bot", text: greeting() })];
    if (!log.length && suggestions.length) start.push(chips());
    logEl.replaceChildren(...start, ...log.map(bubble));
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
    if (!open && call) endCall(call, "hangup");
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
    logEl.querySelector(".chips")?.remove();
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
        else if (r.type === "link") push({ type: "link", url: r.url, label: r.label });
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

  /* ---------- Appel vocal : le visiteur parle, Wakil répond à voix haute ---------- */
  const canTalk = script.dataset.voice !== "off" && !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  mic.hidden = !canTalk;
  const VOICE_ERRORS = {
    denied: "Autorisez le micro pour parler à l'assistant, ou écrivez votre message.",
    413: "Message trop long : parlez moins de 30 secondes.",
    422: "Je n'ai pas compris l'enregistrement. Réessayez, ou écrivez votre message.",
  };
  // Un son vide joué pendant le geste du visiteur : les navigateurs mobiles autorisent ensuite la réponse.
  const SILENCE = (() => {
    const samples = 800, buf = new ArrayBuffer(44 + samples), v = new DataView(buf);
    const text = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    text(0, "RIFF"); v.setUint32(4, 36 + samples, true); text(8, "WAVEfmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 8000, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true); text(36, "data"); v.setUint32(40, samples, true);
    new Uint8Array(buf, 44).fill(128);
    return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  })();
  const player = new Audio();
  let recorder = null, stopTimer = null, audioCtx = null;

  const setStatus = (text) => { statusEl.textContent = text || ""; };
  function setMic(state) {
    mic.classList.toggle("rec", state === "rec");
    mic.classList.toggle("talk", state === "talk");
    mic.disabled = state === "wait";
    mic.setAttribute("aria-label", { rec: "Arrêter et envoyer", talk: "Couper la voix et parler", wait: "Envoi en cours" }[state] || "Parler à l'assistant");
    mic.setAttribute("aria-pressed", String(state === "rec"));
  }

  async function startRecording() {
    player.pause();
    player.src = SILENCE;
    player.play().catch(() => {});
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      push({ from: "error", text: VOICE_ERRORS.denied });
      return setMic("idle");
    }
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"].find((t) => MediaRecorder.isTypeSupported?.(t));
    const chunks = [];
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(stopTimer);
      audioCtx?.close().catch(() => {});
      audioCtx = null;
      recorder = null;
      sendVoice(new Blob(chunks, { type: chunks[0]?.type || type || "audio/webm" }));
    };
    recorder.start();
    setMic("rec");
    setStatus("Je vous écoute… Parlez, puis touchez le bouton rouge (ou faites une pause).");

    // Arrêt automatique : après 1,3 s de silence une fois la parole commencée, ou au bout de 30 s.
    const started = Date.now();
    let spoke = false, quietSince = 0;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      stopTimer = setInterval(() => {
        analyser.getFloatTimeDomainData(data);
        const level = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
        const now = Date.now();
        if (level > 0.03) { spoke = true; quietSince = 0; }
        else if (spoke && !quietSince) quietSince = now;
        if ((spoke && quietSince && now - quietSince > 1300) || now - started > 30000) stopRecording();
      }, 100);
    } catch {
      stopTimer = setTimeout(stopRecording, 30000);
    }
  }

  function stopRecording() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  async function sendVoice(blob) {
    if (!blob.size) { setMic("idle"); return setStatus(""); }
    busy = true;
    send.disabled = true;
    setMic("wait");
    setStatus("");
    logEl.querySelector(".chips")?.remove();
    const typing = document.createElement("div");
    typing.className = "typing";
    typing.setAttribute("aria-label", "L'assistant vous a entendu et répond");
    typing.innerHTML = "<i></i><i></i><i></i>";
    logEl.appendChild(typing);
    logEl.scrollTop = logEl.scrollHeight;
    try {
      const res = await fetch(`${API}/voice?tenant=${encodeURIComponent(tenant)}&session=${encodeURIComponent(sessionId)}`, {
        method: "POST",
        headers: { "content-type": blob.type || "audio/webm" },
        body: blob,
      });
      typing.remove();
      if (!res.ok) throw Object.assign(new Error("http"), { status: res.status });
      const data = await res.json();
      if (data.transcript) push({ from: "me", text: "🎤 " + data.transcript });
      for (const r of data.replies || []) {
        if (r.type === "image") push({ type: "image", url: r.url, caption: r.caption });
        else if (r.type === "link") push({ type: "link", url: r.url, label: r.label });
        else push({ from: "bot", text: r.text });
      }
      if (data.audio) {
        player.src = "data:audio/mpeg;base64," + data.audio;
        setMic("talk");
        setStatus("L'assistant vous répond… Touchez le micro pour l'interrompre.");
        player.onended = () => { setMic("idle"); setStatus(""); };
        await player.play().catch(() => { setMic("idle"); setStatus(""); });
      } else setMic("idle");
    } catch (err) {
      typing.remove();
      setMic("idle");
      push({ from: "error", text: VOICE_ERRORS[err.status] || ERRORS[err.status] || ERRORS.default });
    } finally {
      busy = false;
      send.disabled = false;
    }
  }

  mic.addEventListener("click", () => {
    if (recorder) return stopRecording();
    if (mic.classList.contains("talk")) { player.pause(); setMic("idle"); setStatus(""); }
    if (busy) return;
    startRecording();
  });

  /* ---------- Appel en direct : on parle à l'assistant comme au téléphone, sans toucher de bouton ---------- */
  const AC = window.AudioContext || window.webkitAudioContext;
  const canCall = script.dataset.voice !== "off" && !!(AC && window.WebSocket && navigator.mediaDevices?.getUserMedia);
  const dial = $(".dial"), callbar = $(".callbar"), callStateEl = $(".callbar .cs"), callTime = $(".callbar time"),
        callDot = $(".callbar .dot");
  dial.hidden = true; // affiché quand le serveur confirme qu'une voix est prête (config.call)
  const CALL_RATE = 16000;            // le serveur attend du PCM 16 bits mono à 16 kHz
  const CHUNK = CALL_RATE / 10;       // envoyé par paquets de 100 ms
  const BARGE_LEVEL = 0.08;           // voix assez forte pour couper la parole à l'assistant
  const CALL_STATES = {
    connecting: "Connexion…",
    listening: "Je vous écoute…",
    thinking: "Un instant…",
    speaking: "L'assistant parle (parlez pour l'interrompre)",
  };
  const CALL_ENDS = {
    silence: "Appel terminé : je ne vous entendais plus. Vous pouvez rappeler ou écrire.",
    turns: "Appel terminé. Vous pouvez continuer par écrit.",
    time: "Appel terminé : 10 minutes au maximum. Vous pouvez rappeler ou écrire.",
    error: "L'appel a été coupé. Réessayez, ou écrivez votre message.",
    denied: "Autorisez le micro pour appeler l'assistant, ou écrivez votre message.",
  };
  const WORKLET = 'class T extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor("wakil-tap",T);';
  const level = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / (f.length || 1)); };
  const b64ToBuffer = (b64) => { const bin = atob(b64), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer; };

  function showCallState(c) {
    const state = c.playing ? "speaking" : c.state;
    callbar.dataset.state = state;
    callStateEl.textContent = CALL_STATES[state] || "";
  }

  function setCallUI(on) {
    callbar.hidden = !on;
    form.hidden = on;
    dial.hidden = on || !canCall || !config.call;
    if (on) setStatus("");
  }

  async function startCall() {
    if (call || recorder || busy) return;
    player.pause();
    const ctx = new AC();
    const c = { ctx, ws: null, stream: null, nodes: [], sources: [], nextAt: 0, playing: false, muted: false, state: "connecting",
                acc: 0, accN: 0, pos: 0, out: [], backlog: [], loud: 0, timer: null, chain: Promise.resolve() };
    call = c;
    setCallUI(true);
    showCallState(c);
    ctx.resume().catch(() => {});
    try {
      c.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch {
      return endCall(c, "denied");
    }
    if (call !== c) return c.stream.getTracks().forEach((t) => t.stop());
    try {
      const source = ctx.createMediaStreamSource(c.stream);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      let tap;
      if (ctx.audioWorklet && window.AudioWorkletNode) {
        const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        tap = new AudioWorkletNode(ctx, "wakil-tap");
        tap.port.onmessage = (e) => onMic(c, e.data);
      } else {
        tap = ctx.createScriptProcessor(2048, 1, 1);
        tap.onaudioprocess = (e) => onMic(c, e.inputBuffer.getChannelData(0).slice(0));
      }
      source.connect(tap);
      tap.connect(mute).connect(ctx.destination);
      c.nodes.push(source, tap, mute);
    } catch {
      return endCall(c, "error");
    }
    const ws = new WebSocket(`${API.replace(/^http/, "ws")}/call?tenant=${encodeURIComponent(tenant)}&session=${encodeURIComponent(sessionId)}`);
    ws.binaryType = "arraybuffer";
    c.ws = ws;
    ws.onmessage = (e) => { if (typeof e.data === "string") onCallMessage(c, e.data); };
    ws.onclose = () => endCall(c, "error");
  }

  // Micro : rééchantillonné à 16 kHz (moyenne par paquet), envoyé tant que l'assistant ne parle pas.
  function onMic(c, frame) {
    if (call !== c) return;
    const ratio = c.ctx.sampleRate / CALL_RATE;
    for (let i = 0; i < frame.length; i++) {
      c.acc += frame[i];
      c.accN++;
      if (++c.pos >= ratio) {
        c.pos -= ratio;
        c.out.push(c.acc / c.accN);
        c.acc = 0;
        c.accN = 0;
      }
    }
    while (c.out.length >= CHUNK) {
      const samples = c.out.splice(0, CHUNK), pcm = new Int16Array(CHUNK);
      for (let i = 0; i < CHUNK; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 0x7fff;
      if (c.playing) {
        c.backlog.push(pcm);
        if (c.backlog.length > 5) c.backlog.shift();
      } else if (c.ws?.readyState === 1) c.ws.send(pcm.buffer);
    }
    const lvl = level(frame);
    callDot.style.transform = `scale(${1 + Math.min(lvl * 8, 0.9)})`;
    // Le client parle fort pendant que l'assistant parle : on lui laisse la parole.
    const seconds = frame.length / c.ctx.sampleRate;
    if (c.playing) {
      c.loud = lvl > BARGE_LEVEL ? c.loud + seconds : Math.max(0, c.loud - seconds);
      if (c.loud > 0.3) interrupt(c);
    }
  }

  function stopPlayback(c) {
    for (const s of c.sources) { try { s.onended = null; s.stop(); } catch {} }
    c.sources = [];
    c.playing = false;
    c.nextAt = 0;
  }

  function interrupt(c) {
    stopPlayback(c);
    c.loud = 0;
    c.muted = true; // les morceaux déjà en route sont ignorés jusqu'au prochain état envoyé par le serveur
    if (c.ws?.readyState === 1) {
      c.ws.send(JSON.stringify({ type: "interrupt" }));
      for (const pcm of c.backlog) c.ws.send(pcm.buffer);
    }
    c.backlog = [];
    showCallState(c);
  }

  function play(c, b64) {
    c.chain = c.chain.then(async () => {
      if (call !== c || c.muted) return;
      let buffer;
      try { buffer = await c.ctx.decodeAudioData(b64ToBuffer(b64)); } catch { return; }
      if (call !== c || c.muted) return;
      const src = c.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(c.ctx.destination);
      const at = Math.max(c.ctx.currentTime + 0.05, c.nextAt);
      src.start(at);
      c.nextAt = at + buffer.duration;
      c.sources.push(src);
      c.playing = true;
      showCallState(c);
      src.onended = () => {
        c.sources = c.sources.filter((s) => s !== src);
        if (!c.sources.length) {
          c.playing = false;
          c.backlog = []; // le micro pendant que l'assistant parlait : son écho, pas le client
          showCallState(c);
        }
      };
    });
  }

  function onCallMessage(c, raw) {
    if (call !== c) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.type === "ready") {
      const started = Date.now();
      c.timer = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        callTime.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      }, 500);
    } else if (m.type === "state") {
      c.state = m.state;
      c.muted = false;
      showCallState(c);
    } else if (m.type === "heard") {
      logEl.querySelector(".chips")?.remove();
      push({ from: "me", text: "🎤 " + m.text });
    } else if (m.type === "replies") {
      for (const r of m.replies || []) {
        if (r.type === "image") push({ type: "image", url: r.url, caption: r.caption });
        else if (r.type === "link") push({ type: "link", url: r.url, label: r.label });
        else push({ from: "bot", text: r.text });
      }
    } else if (m.type === "audio") {
      play(c, m.data);
    } else if (m.type === "timing") {
      console.debug?.("Wakil appel (ms)", m);
    } else if (m.type === "end") {
      // Laisse finir la dernière phrase avant de raccrocher.
      c.chain.then(() => setTimeout(() => endCall(c, m.reason), Math.max(0, (c.nextAt - c.ctx.currentTime) * 1000)));
      c.ws.onclose = null;
    }
  }

  function endCall(c, reason) {
    if (!c || call !== c) return;
    call = null;
    clearInterval(c.timer);
    if (c.ws) {
      c.ws.onclose = null;
      try { if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type: "bye" })); c.ws.close(); } catch {}
    }
    stopPlayback(c);
    c.stream?.getTracks().forEach((t) => t.stop());
    for (const n of c.nodes) { try { n.disconnect(); } catch {} }
    c.ctx.close().catch(() => {});
    callTime.textContent = "00:00";
    callDot.style.transform = "";
    setCallUI(false);
    if (CALL_ENDS[reason]) push({ from: "error", text: CALL_ENDS[reason] });
  }

  dial.addEventListener("click", startCall);
  $(".hang").addEventListener("click", () => { endCall(call, "hangup"); dial.focus(); });

  launcher.addEventListener("click", () => setOpen(panel.hidden));
  $(".close").addEventListener("click", () => { setOpen(false); launcher.focus(); });
  // Sur le document : Échap ferme le chat même quand le focus est ailleurs dans la page.
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !panel.hidden) { setOpen(false); launcher.focus(); } });
  teaser.addEventListener("click", (e) => {
    if (e.target.closest(".x")) { teaser.hidden = true; session.set("teased", "1"); return; }
    setOpen(true);
  });
  $(".reset").addEventListener("click", () => {
    if (call) endCall(call, "hangup");
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
    // Ouvre le chat et lance l'appel en direct quand la voix est prête ; sinon, ouvre simplement le chat.
    call: () => { setOpen(true); if (canCall && config.call && !call) startCall(); },
  };

  fetch(`${API}/chat/config?tenant=${encodeURIComponent(tenant)}`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((c) => {
      config = { ...config, ...c };
      dial.hidden = !canCall || !config.call || !!call;
      $(".title").textContent = script.dataset.title || `Assistant ${config.businessName}`.trim();
      panel.setAttribute("aria-label", $(".title").textContent);
      if (!panel.hidden) render();
    })
    .catch(() => {});

  if (session.get("open") === "1") setOpen(true);
  else if (script.dataset.teaser !== "off" && !session.get("teased") && !log.length) {
    // Propose le chat une fois par visite, après quelques secondes.
    setTimeout(() => {
      if (!panel.hidden) return;
      $(".tx").textContent = script.dataset.teaser || "Une question ? Je vous réponds tout de suite.";
      teaser.hidden = false;
    }, 6000);
  }
})();
