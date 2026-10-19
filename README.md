# Wakil — commercial IA sur WhatsApp et sur le site web

Wakil répond aux clients d'une entreprise sur WhatsApp et dans un chat sur son site web. Il comprend les messages, les vocaux et les photos, conseille les produits du catalogue, estime les quantités et prend les commandes. Le patron reçoit chaque commande sur son propre WhatsApp.

Premier client : **SICAR SARL**. Le catalogue est lu directement sur le site (`data/products.json` et `data/site.json`), donc une modification faite dans l'administration du site est prise en compte par Wakil en moins de 5 minutes.

## L'application (`/app`) : votre espace de travail

À l'adresse `https://wakil-whatsapp.<votre-compte>.workers.dev/app/`, sur ordinateur ou téléphone, protégée par un mot de passe :

| Onglet | Ce que vous y faites |
|---|---|
| **Accueil** | Ce qui demande votre attention : commandes à traiter, clients qui attendent l'équipe |
| **Conversations** | Tout ce que les clients ont écrit et ce que Wakil a répondu. **Prendre la main** (Wakil se tait), **Rendre à Wakil**, **répondre au client** sur WhatsApp depuis l'application |
| **Commandes** | Confirmer, marquer livrée, annuler ; écrire au client |
| **Tester** | Parler à votre assistant comme un client, avant vos clients. Rien n'est enregistré, personne n'est prévenu |
| **Demandes** | Les entreprises qui ont rempli « Essayer Wakil » sur le site de Wakil |
| **Réglages** | L'adresse du webhook et la ligne du chat à copier, le catalogue que Wakil connaît |

Pour l'activer : `npx wrangler secret put ADMIN_PASSWORD` (choisissez un mot de passe long). Changer ce mot de passe déconnecte tous les appareils.

**Une journée type** : le matin, ouvrez **Accueil** ; confirmez les commandes de la nuit, rappelez les clients qui attendent l'équipe. Dans la journée, les notifications WhatsApp vous préviennent ; quand vous voulez répondre vous-même, **Prendre la main**, puis **Rendre à Wakil**. Après chaque changement de catalogue, un tour dans **Tester**.

## Ce que fait la version actuelle (MVP)

| Fonction | Détail |
|---|---|
| Messages texte | Réponse en quelques secondes, dans la langue du client |
| Vocaux | Transcrits par Whisper (Workers AI), avec les noms des produits comme vocabulaire |
| Photos | Le client peut envoyer une photo de son chantier ; Wakil la voit |
| Position | Une position partagée est comprise comme lieu de livraison |
| Messages en rafale | Wakil attend 4 s de calme (15 s au plus) et répond une seule fois |
| Photo produit | Wakil peut envoyer la photo d'un produit du catalogue |
| Commande / devis | Récapitulatif, confirmation du client, référence `W-XXXXXX`, envoi au patron |
| Passage à un humain | Sur demande, réclamation, négociation… : le patron est prévenu et Wakil se tait 12 h |
| Prix | Jamais inventés : « sur devis » quand le site n'en affiche pas |
| Chat du site web | Même assistant, même catalogue ; il demande le numéro du client avant d'enregistrer une commande |

## Architecture

```
Client WhatsApp ──► Meta (WhatsApp Cloud API) ──► Cloudflare Worker  /webhook
                                                     │  vérifie la signature de Meta
                                                     ▼
                                     Durable Object (1 par client)
                                     file d'attente + historique + commandes
                                                     │  alarme après 4 s
                                                     ▼
                         Claude (API Anthropic) + outils ──► réponses WhatsApp
                         catalogue lu sur le site            notifications au patron
                                                     ▲
Visiteur du site ──► wakil-chat.js ──► POST /chat ───┘  (même moteur, réponse immédiate)
```

| Fichier | Rôle |
|---|---|
| `src/index.ts` | Webhook (vérification Meta, signature), commandes du patron |
| `src/api.ts`, `src/auth.ts` | API de l'application, connexion par mot de passe |
| `src/inbox-do.ts` | Boîte de réception (SQLite) : conversations, commandes, demandes |
| `public/app/index.html` | L'application |
| `src/web.ts` | Chat du site web : `/chat` et `/chat/config`, contrôle du site d'origine et du débit |
| `public/wakil-chat.js` | Le chat à intégrer dans un site (une seule balise `<script>`) |
| `public/index.html` | Le site de Wakil (servi à l'adresse du Worker) |
| `src/leads.ts` | Formulaire « Essayer Wakil » du site : `/leads` |
| `config/wakil.json` | Où envoyer les demandes reçues par le formulaire |
| `src/conversation-do.ts` | Durable Object : une conversation par client, traitée dans l'ordre |
| `src/engine.ts` | File d'attente, vocaux/photos, réponse, notifications au patron |
| `src/agent.ts` | Appel à Claude et boucle d'outils |
| `src/tools.ts` | Outils : `send_product_photo`, `record_order`, `request_human` |
| `src/prompt.ts` | Le « caractère » du commercial et ses règles |
| `src/catalog.ts` | Lecture et mise en forme du catalogue |
| `src/whatsapp.ts` | Client de l'API WhatsApp Cloud |
| `config/tenants.json` | Les entreprises clientes (une par numéro WhatsApp) |

## Mise en route

### 1. Meta (WhatsApp Cloud API)

1. Sur [developers.facebook.com](https://developers.facebook.com), créer une application de type **Business** et lui ajouter le produit **WhatsApp**.
2. Dans **WhatsApp → API Setup** : noter le **Phone number ID** du numéro de test et ajouter votre numéro personnel comme destinataire de test.
3. Créer un **jeton permanent** : Business Settings → System users → créer un utilisateur système admin, lui donner l'application et le compte WhatsApp, générer un jeton avec les permissions `whatsapp_business_messaging` et `whatsapp_business_management`. (Le jeton temporaire de la page API Setup expire en 24 h.)
4. Noter la **clé secrète de l'application** : App settings → Basic → App secret.

### 2. Configuration

Dans `config/tenants.json`, remplacer `REMPLACER_PAR_PHONE_NUMBER_ID` par le Phone number ID, et `ownerPhone` par le numéro WhatsApp du patron (format international sans `+`, ex. `2250701020304`).

### 3. Cloudflare

```bash
npm install
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY      # clé de console.anthropic.com
npx wrangler secret put WHATSAPP_TOKEN         # jeton permanent (étape 1.3)
npx wrangler secret put WHATSAPP_APP_SECRET    # App secret (étape 1.4)
npx wrangler secret put WHATSAPP_VERIFY_TOKEN  # un mot de passe que vous choisissez
npx wrangler secret put ADMIN_PASSWORD         # le mot de passe de l'application /app
npm run deploy
```

Le déploiement affiche l'adresse du Worker, par exemple `https://wakil-whatsapp.<votre-compte>.workers.dev`.

> Les clés se mettent uniquement avec `wrangler secret put`. Ne jamais les écrire dans le code, dans `wrangler.jsonc` ni dans un message.

### 4. Brancher le webhook

Dans **WhatsApp → Configuration** sur Meta :
- Callback URL : `https://wakil-whatsapp.<votre-compte>.workers.dev/webhook`
- Verify token : la valeur de `WHATSAPP_VERIFY_TOKEN`
- Puis **Webhook fields → messages → Subscribe**.

Envoyez « Bonjour » au numéro de test : Wakil répond.

## Le site de Wakil

Le Worker sert aussi le site de présentation de Wakil (`public/index.html`), à sa propre adresse : `https://wakil-whatsapp.<votre-compte>.workers.dev/`. On y trouve :
- **une démonstration en direct** : le chat joue le commercial de « Carrière Démo », une entreprise fictive (`DEMO` dans `config/tenants.json`) qui reprend le catalogue de SICAR. Personne n'est prévenu pour ses « commandes » ;
- **le formulaire « Essayer Wakil »** : chaque demande est gardée, et envoyée sur WhatsApp au numéro indiqué dans `config/wakil.json` (`ownerPhone`, avec `senderPhoneNumberId` = le Phone number ID qui envoie le message).

Les messages de la démonstration sont de vrais appels au modèle : les limites du chat web s'appliquent aussi.

## Chat du site web

### Sur le site SICAR

Une fois le Worker déployé : **Administration → Informations → « Assistant Wakil : adresse du chat »**, coller l'adresse du Worker (`https://wakil-whatsapp.<votre-compte>.workers.dev`), puis publier. Le chat apparaît en bas à droite, au-dessus du bouton WhatsApp. Laisser le champ vide le désactive.

### Sur n'importe quel site

```html
<script src="https://wakil-whatsapp.<votre-compte>.workers.dev/wakil-chat.js"
        data-tenant="sicar" data-accent="#e30613" data-position="right" defer></script>
```

| Attribut | Rôle |
|---|---|
| `data-tenant` | Identifiant de l'entreprise (`id` dans `config/tenants.json`), obligatoire |
| `data-accent` | Couleur du chat |
| `data-position` | `left` ou `right` |
| `data-offset` | Distance au bas de l'écran, en pixels (24 par défaut) |
| `data-title` | Titre de la fenêtre (par défaut « Assistant » + nom de l'entreprise) |
| `data-teaser` | Phrase de la bulle d'invitation affichée une fois par visite |
| `data-on-accent` | Couleur du texte et des icônes posés sur la couleur du chat (blanc par défaut) |

La page peut aussi piloter le chat : `WakilChat.open()`, `WakilChat.send("Bonjour")`.

Le site doit être déclaré dans `webOrigins` de l'entreprise (`config/tenants.json`), par exemple `"https://yassine1158.github.io"`. Avec un nom de domaine (ex. `https://sicar-sarl.ci`), l'ajouter aussi.

### Protections contre les abus

Chaque message coûte un appel au modèle, et l'adresse du chat est publique. Plusieurs limites s'appliquent donc :
- seuls les sites listés dans `webOrigins` sont acceptés ;
- 20 messages par minute au plus par adresse IP (`CHAT_LIMITER` dans `wrangler.jsonc`) ;
- 60 messages par jour au plus par visiteur, et 1 000 caractères au plus par message ;
- une conversation web inactive pendant 30 jours est effacée.

Le contrôle du site d'origine arrête les autres sites web, pas un script lancé hors navigateur. Les limites de débit et de messages par jour plafonnent ce cas.

## Commandes du patron

Depuis le WhatsApp du patron (`ownerPhone`), en écrivant au numéro de Wakil :

| Message | Effet |
|---|---|
| `#pause 2250701020304` | Wakil ne répond plus à ce client (12 h) : le patron prend la main |
| `#reprendre 2250701020304` | Wakil reprend la conversation |

Tout autre message du patron est traité comme celui d'un client, ce qui est pratique pour tester.

## Notifications au patron et fenêtre de 24 h

WhatsApp n'autorise un message libre que dans les 24 h qui suivent le dernier message du destinataire. Pour que le patron reçoive les commandes à tout moment :
1. Dans WhatsApp Manager, créer un modèle de catégorie **Utility**, en français, avec ce corps : `Nouvelle notification Wakil : {{1}}`.
2. Une fois le modèle approuvé, l'ajouter à l'entreprise dans `config/tenants.json` :
   ```json
   "ownerNotifyTemplate": { "name": "nom_du_modele", "language": "fr" }
   ```

Sans modèle, le patron doit avoir écrit au numéro de Wakil dans les dernières 24 h.

## Réglages

Dans `wrangler.jsonc`, section `vars` :

| Variable | Défaut | Rôle |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | Modèle utilisé |
| `ANTHROPIC_BASE_URL` | (vide) | Facultatif : adresse d'un Cloudflare AI Gateway, pour suivre les appels et leur coût |
| `CLAUDE_EFFORT` | `low` | Profondeur de réflexion (`low` suffit pour une conversation commerciale) |
| `DEBOUNCE_MS` | `4000` | Attente avant de répondre à un client qui écrit en plusieurs messages |
| `GRAPH_API_VERSION` | `v23.0` | Version de l'API WhatsApp |

Coût du modèle : `claude-opus-5-5` coûte 4 $ / 20 $ par million de jetons (entrée / sortie), `claude-haiku-5-5` 0,10 $ / 0,50 $. Le prompt et le catalogue sont mis en cache, ce qui réduit fortement le coût d'une conversation. Pour passer à Haiku, changer `CLAUDE_MODEL` puis comparer la qualité des réponses sur de vraies conversations avant de garder ce choix.

## Développement

```bash
npm test           # tests (vitest)
npm run typecheck  # vérification TypeScript
npm run dev        # Worker en local (copier .dev.vars.example en .dev.vars)
```

En local, la transcription des vocaux demande d'être connecté à Cloudflare (`npx wrangler login`).

## À vérifier avec un vrai numéro

- **Vocaux** : WhatsApp envoie des fichiers OGG/Opus. Le format est accepté par Whisper, mais la qualité sur l'accent ivoirien et le nouchi reste à mesurer avec de vrais vocaux de clients.
- **Indicateur « en train d'écrire »** : nécessite une version récente de l'API ; s'il est refusé, l'erreur est seulement journalisée.
- **Chat web** : testé dans Chromium (ordinateur et téléphone, thème clair et sombre) contre le Worker en local, avec de fausses clés. Une vraie conversation avec le modèle reste à faire après le déploiement.

## Prochaines étapes

1. Tester avec le numéro de test Meta, puis avec de vrais clients de SICAR.
2. Tableau de bord du patron (commandes, conversations) : les commandes sont déjà gardées dans chaque conversation.
3. Lien de paiement mobile money (Wave, Orange Money, MTN MoMo).
4. Inscription d'une nouvelle entreprise sans toucher au code (aujourd'hui : `config/tenants.json`).
