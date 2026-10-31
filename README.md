# Wakil — commercial IA sur WhatsApp et sur le site web

Wakil répond aux clients d'une entreprise sur WhatsApp et dans un chat sur son site web. Il comprend les messages, les vocaux et les photos, conseille les produits du catalogue, estime les quantités et prend les commandes. Le patron reçoit chaque commande sur son propre WhatsApp.

Clients : **SICAR SARL** (carrière) et **SANA** (nutrition animale et élevage, chat sur https://sana-sa.ci). Le catalogue est lu directement sur le site (`data/products.json` et `data/site.json`), donc une modification faite dans l'administration du site est prise en compte par Wakil en moins de 5 minutes.

## L'application (`/app`) : votre espace de travail

À l'adresse `https://wakil-whatsapp.<votre-compte>.workers.dev/app/`, sur ordinateur ou téléphone. Deux sortes de connexion :

- **l'administrateur de Wakil** (identifiant `admin`, mot de passe `ADMIN_PASSWORD`) voit toutes les entreprises, les demandes et la page **Entreprises** ;
- **le patron d'une entreprise** (identifiant = celui de son entreprise, mot de passe donné par l'administrateur) ne voit que son entreprise : accueil, conversations, commandes, essai, réglages.

| Onglet | Ce que vous y faites |
|---|---|
| **Accueil** | Ce qui demande votre attention : commandes à traiter, clients qui attendent l'équipe |
| **Conversations** | Tout ce que les clients ont écrit et ce que Wakil a répondu. **Prendre la main** (Wakil se tait), **Rendre à Wakil**, **répondre au client** sur WhatsApp depuis l'application |
| **Commandes** | Confirmer, marquer livrée, annuler ; écrire au client |
| **Tester** | Parler à votre assistant comme un client, avant vos clients. Rien n'est enregistré, personne n'est prévenu |
| **Réglages** | Le numéro WhatsApp relié, la ligne du chat à copier, le catalogue que Wakil connaît |
| **Demandes** (admin) | Les entreprises qui ont rempli « Essayer Wakil » sur le site de Wakil |
| **Entreprises** (admin) | Créer et modifier les entreprises clientes, sans toucher au code (voir plus bas) |

Pour l'activer : `ADMIN_PASSWORD` dans les secrets (choisissez un mot de passe long). Il sert aussi à signer les connexions : le changer déconnecte tous les appareils, patrons compris.

## Ajouter une entreprise cliente

Dans l'application, **Entreprises → Nouvelle entreprise** :

1. **La fiche** : nom, identifiant de connexion (proposé à partir du nom), numéro WhatsApp du patron (il y reçoit les commandes), horaires, adresse, moyens de paiement, consignes pour l'assistant.
2. **Le catalogue** : soit un tableau rempli dans Wakil (ou importé d'un fichier Excel/CSV avec les colonnes Nom, Catégorie, Prix, Unité, Description, Photo, Disponible), soit l'adresse d'un fichier `products.json` tenu à jour sur le site de l'entreprise, comme pour SICAR, soit l'adresse du `data/content.js` d'un site fait comme celui de SANA (produits, horaires, contacts et FAQ dans un seul fichier).
3. **L'accès du patron** : **Générer** un mot de passe, **Enregistrer**, puis **Envoyer sur WhatsApp** au patron l'adresse de l'application, son identifiant et son mot de passe.
4. **WhatsApp** : 
   - **Connecter WhatsApp** (inscription intégrée de Meta) : le patron se connecte à Facebook, choisit ou crée son compte WhatsApp Business et son numéro ; Wakil reçoit un accès à ce numéro, l'active et s'abonne à ses messages. Demande les secrets `META_APP_ID`, `META_CONFIG_ID` et `WHATSAPP_APP_SECRET` (voir « Meta » plus bas) ;
   - ou **Relier à la main** : le Phone number ID d'un numéro ajouté dans le compte WhatsApp de Wakil (il utilise alors `WHATSAPP_TOKEN`), ou d'un autre compte avec son propre jeton.
5. **Le chat sur son site** : ajouter l'adresse de son site dans **Sites autorisés** et lui donner la ligne `<script>` à coller.

Les entreprises de `config/tenants.json` (SICAR, la démonstration) apparaissent aussi dans la liste ; une modification faite dans l'application l'emporte sur le fichier, et **Revenir à l'origine** l'annule. Un numéro WhatsApp ne peut être relié qu'à une seule entreprise.

**Une journée type** : le matin, ouvrez **Accueil** ; confirmez les commandes de la nuit, rappelez les clients qui attendent l'équipe. Dans la journée, les notifications WhatsApp vous préviennent ; quand vous voulez répondre vous-même, **Prendre la main**, puis **Rendre à Wakil**. Après chaque changement de catalogue, un tour dans **Tester**.

## Ce que fait la version actuelle (MVP)

| Fonction | Détail |
|---|---|
| Messages texte | Réponse en quelques secondes, dans la langue du client |
| Vocaux | Transcrits par Whisper (Workers AI), avec les noms des produits comme vocabulaire |
| Réponses vocales | À un client qui envoie un vocal, Wakil répond aussi en vocal (MeloTTS, français), après le texte. Réglable par entreprise : après un vocal, à chaque message, ou jamais |
| Photos | Le client peut envoyer une photo de son chantier ; Wakil la voit |
| Position | Une position partagée est comprise comme lieu de livraison |
| Messages en rafale | Wakil attend 4 s de calme (15 s au plus) et répond une seule fois |
| Photo produit | Wakil peut envoyer la photo d'un produit du catalogue |
| Commande / devis | Récapitulatif, confirmation du client, référence `W-XXXXXX`, envoi au patron |
| Passage à un humain | Sur demande, réclamation, négociation… : le patron est prévenu et Wakil se tait 12 h |
| Prix | Jamais inventés : « sur devis » quand le site n'en affiche pas |
| Appel vocal (chat du site) | Bouton 🎤 : le visiteur parle, Wakil répond à voix haute (voir « Appel vocal » plus bas) |
| Chat du site web | Même assistant, même catalogue ; il demande le numéro du client avant d'enregistrer une commande, puis propose au visiteur un bouton pour envoyer aussi sa demande sur le WhatsApp de l'entreprise (numéro relié à Wakil, sinon celui du site) |

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
| `src/api.ts`, `src/auth.ts` | API de l'application, connexions (administrateur, patrons) |
| `src/companies.ts` | Fiche d'une entreprise (vérification), inscription WhatsApp de Meta |
| `src/registry.ts` | Registre des entreprises : fichier de configuration + base, numéro WhatsApp de chacune |
| `src/inbox-do.ts` | Boîte de réception (SQLite) : conversations, commandes, demandes, entreprises |
| `public/app/index.html` | L'application |
| `src/web.ts` | Chat du site web : `/chat` et `/chat/config`, contrôle du site d'origine et du débit |
| `src/voice.ts` | Appel vocal du chat : `/voice` (Whisper → même conversation → voix MeloTTS) |
| `public/wakil-chat.js` | Le chat à intégrer dans un site (une seule balise `<script>`) |
| `public/index.html` | Le site de Wakil (servi à l'adresse du Worker) |
| `src/leads.ts` | Formulaire « Essayer Wakil » du site : `/leads` |
| `config/wakil.json` | Où envoyer les demandes reçues par le formulaire |
| `src/conversation-do.ts` | Durable Object : une conversation par client, traitée dans l'ordre |
| `src/engine.ts` | File d'attente, vocaux/photos, réponse, notifications au patron |
| `src/agent.ts` | Appel à Claude et boucle d'outils |
| `src/free-model.ts` | Relais gratuit (Workers AI) quand Claude ne répond pas |
| `src/tools.ts` | Outils : `send_product_photo`, `record_order`, `request_human` |
| `src/prompt.ts` | Le « caractère » du commercial et ses règles |
| `src/catalog.ts` | Lecture et mise en forme du catalogue |
| `src/whatsapp.ts` | Client de l'API WhatsApp Cloud |
| `config/tenants.json` | Entreprises de départ (SICAR, démonstration) ; les autres se créent dans l'application |

## Appel vocal dans le chat du site

Le chat du site a un bouton **🎤** : le visiteur parle, Wakil l'écoute et lui répond **à voix haute** (le texte reste affiché). Pas de numéro de téléphone ni de compte en plus : tout passe par Cloudflare.

```
🎤 navigateur (MediaRecorder) ──► POST /voice?tenant=…&session=…
      Whisper (Workers AI) : voix → texte
      la même conversation que le chat écrit : catalogue, commandes, conseiller
      MeloTTS (Workers AI, français) : réponse → voix (MP3)
◄── { transcript, replies, audio }   le chat affiche et lit la réponse
```

- L'enregistrement s'arrête tout seul après une courte pause (ou au toucher du bouton rouge), 30 secondes au plus. Toucher le micro pendant que Wakil parle le coupe.
- Le message arrive marqué `[Appel vocal]` : le modèle répond en 1 à 3 phrases courtes, sans liste ni émoji, fait répéter ce qui est mal compris et relit le numéro de téléphone chiffre par chiffre. Avant la voix, les émojis, liens et mises en forme sont retirés, et `m3`, `5/15`, `25 000 FCFA` sont rendus faciles à dire.
- Mêmes protections que le chat : sites autorisés, 20 requêtes par minute et par adresse, 60 messages par jour et par visiteur, enregistrement de 2 Mo au plus.
- Coût : la transcription et la voix utilisent Workers AI (quota gratuit quotidien, puis facturé à l'usage) ; la réponse elle-même coûte comme un message écrit.
- `data-voice="off"` sur la balise `<script>` masque le bouton.

Limites : ce n'est pas une conversation en continu (le visiteur parle, puis Wakil répond) ; la voix de synthèse reste un peu robotique ; la transcription peut se tromper sur les noms propres et les accents. Le navigateur demande l'autorisation du micro, et la page doit être en HTTPS.

## Mise en ligne depuis GitHub (recommandé)

Tout se règle dans GitHub ; Cloudflare fait tourner Wakil sans qu'on ait à y retourner.

**Une seule fois, sur Cloudflare** (compte gratuit) :
1. Créer un compte sur dash.cloudflare.com, puis ouvrir **Workers & Pages** une fois pour choisir le sous-domaine `workers.dev`.
2. Noter l'**Account ID** (colonne de droite de **Workers & Pages**).
3. **My Profile → API Tokens → Create Token** → modèle **Edit Cloudflare Workers** → **Create Token**, et copier le jeton.

**Dans GitHub** : **Settings → Secrets and variables → Actions → New repository secret**, un par un :

| Nom | Valeur | Obligatoire |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | le jeton créé ci-dessus | oui |
| `CLOUDFLARE_ACCOUNT_ID` | l'Account ID | oui |
| `ANTHROPIC_API_KEY` | la clé de console.anthropic.com | oui |
| `ADMIN_PASSWORD` | le mot de passe de l'application | oui |
| `WHATSAPP_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | les valeurs de Meta | quand WhatsApp est prêt |
| `META_APP_ID`, `META_CONFIG_ID` | l'App ID et la configuration de l'inscription intégrée | pour le bouton « Connecter WhatsApp » |

**Lancer** : onglet **Actions → Mettre en ligne → Run workflow**. Ensuite, chaque changement sur `main` est vérifié (tests) puis mis en ligne tout seul. Le résumé de chaque mise en ligne donne les adresses du site, de l'application et du webhook. Une clé ajoutée ou changée dans GitHub part au prochain lancement.

## Mise en route

### 1. Meta (WhatsApp Cloud API)

1. Sur [developers.facebook.com](https://developers.facebook.com), créer une application de type **Business** et lui ajouter le produit **WhatsApp**.
2. Dans **WhatsApp → API Setup** : noter le **Phone number ID** du numéro de test et ajouter votre numéro personnel comme destinataire de test.
3. Créer un **jeton permanent** : Business Settings → System users → créer un utilisateur système admin, lui donner l'application et le compte WhatsApp, générer un jeton avec les permissions `whatsapp_business_messaging` et `whatsapp_business_management`. (Le jeton temporaire de la page API Setup expire en 24 h.)
4. Noter la **clé secrète de l'application** : App settings → Basic → App secret.
5. Pour **Connecter WhatsApp** (chaque client relie son propre numéro) : ajouter le produit **Facebook Login for Business**, y créer une **configuration** de type « WhatsApp Embedded Signup » et noter son **Configuration ID** (`META_CONFIG_ID`) ; noter l'**App ID** (`META_APP_ID`). Dans Facebook Login → Settings, ajouter l'adresse du Worker aux domaines autorisés. L'application doit passer la vérification d'entreprise de Meta (Tech Provider) avant d'être utilisée par de vrais clients.

### 2. Configuration

Dans l'application, **Entreprises → SICAR SARL** : le numéro WhatsApp du patron, puis **WhatsApp → Relier à la main** avec le Phone number ID. Dans `config/wakil.json`, le numéro qui reçoit les demandes du formulaire « Essayer Wakil » et le Phone number ID qui les envoie.

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
- **Wakil en direct** : le chat de la page est Wakil lui-même (`wakil` dans `config/tenants.json`), qui présente l'offre aux patrons, répond à leurs questions et peut jouer le rôle de leur assistant ; il les invite à remplir le formulaire ;
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
| `data-tenant` | Identifiant de l'entreprise (identifiant de connexion, visible dans **Entreprises**), obligatoire |
| `data-accent` | Couleur du chat |
| `data-position` | `left` ou `right` |
| `data-offset` | Distance au bas de l'écran, en pixels (24 par défaut) |
| `data-title` | Titre de la fenêtre (par défaut « Assistant » + nom de l'entreprise) |
| `data-teaser` | Phrase de la bulle d'invitation affichée une fois par visite |
| `data-greeting` | Message d'accueil du chat (par défaut : présentation de l'assistant de l'entreprise) |
| `data-suggestions` | Questions proposées sous l'accueil, séparées par `|` (ex. `Réserver des poussins|Prix et acompte`) |
| `data-on-accent` | Couleur du texte et des icônes posés sur la couleur du chat (blanc par défaut) |

La page peut aussi piloter le chat : `WakilChat.open()`, `WakilChat.send("Bonjour")`.

Le site doit être déclaré dans **Sites autorisés** de la fiche de l'entreprise, par exemple `"https://yassine1158.github.io"`. Avec un nom de domaine (ex. `https://sicar-sarl.ci`), l'ajouter aussi.

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
2. Une fois le modèle approuvé, l'ajouter à l'entreprise dans `config/tenants.json` (pour une entreprise créée dans l'application, il est gardé quand on modifie sa fiche) :
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
| `FREE_MODEL` | `@cf/google/gemma-4-26b-a4b-it` | Modèle gratuit de Cloudflare qui prend le relais quand Claude ne répond pas |

### Relais gratuit

Sans clé Anthropic, sans crédit, ou pendant une panne de Claude, Wakil répond avec un modèle gratuit de Cloudflare (Workers AI) : les 10 000 « neurones » offerts chaque jour couvrent une centaine de réponses environ, remis à zéro chaque nuit (minuit UTC). Les réponses sont plus simples et les photos envoyées par les clients ne sont pas vues. Dès que du crédit est ajouté sur console.anthropic.com, Claude reprend la main tout seul (au plus tard 10 minutes après). **Réglages → Vérifier la connexion à Claude** indique lequel des deux répond.

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
2. Lien de paiement mobile money (Wave, Orange Money, MTN MoMo).
3. Laisser le patron modifier lui-même ses prix et son catalogue depuis son espace.
4. Abonnement et facturation par entreprise.
