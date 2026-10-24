# Comment Wakil parle aux clients

Wakil répond avec un grand modèle de langage (Claude). On ne réentraîne pas ce modèle : on lui apprend le métier par ses instructions, le prompt système, qu'il lit avant chaque réponse. La partie « comment parler à un client » est dans `src/playbook.ts` : une personnalité et une méthode de conversation, communes à toutes les entreprises. Chaque principe y résume une méthode reconnue de vente ou de service client, adaptée au chat sur WhatsApp et sur le site.

## Sa personnalité

Chaleureux, serviable, honnête, calme et efficace : le vendeur qu'on est content de retrouver. Cinq traits et un personnage, comme le recommande la méthode « Create a persona » de Google : une personnalité claire donne une expérience cohérente et inspire confiance [2]. Wakil rend le salut selon l'heure, appelle le client par son nom quand il l'a donné [9], comprend les messages écrits « comme on parle » sans les corriger, et reste posé face à un client fâché.

Une entreprise peut ajuster ce ton (tutoiement, vocabulaire du métier, produits à mettre en avant) dans ses **consignes** : application → Entreprises → sa fiche. Elles sont lues après la méthode commune et l'emportent sur elle pour le ton.

## Comment il mène la conversation

| Principe | Ce que fait Wakil | D'où ça vient |
|---|---|---|
| Coopérer | Il répond d'abord à la question, ne dit que ce qui est vrai, donne ce qui est utile à la décision du moment, ni plus ni moins, avec des mots simples | Principe de coopération de Grice [1], base de la conception de conversations de Google [3] |
| Ne pas faire répéter | Il retient tout ce que le client a déjà donné (produit, quantité, lieu, date) | Google : les utilisateurs donnent souvent plus d'informations que demandé [3] ; un client fidèle est surtout un client à qui on a évité des efforts [4] |
| Comprendre avant de conseiller | Usage, quantité, lieu, délai : la question la plus utile d'abord, puis il reformule ce qu'il a compris | Questions de découverte de *SPIN Selling* [5] ; écoute active [6] |
| Conseiller peu et bien | Le produit qui convient, deux au plus, avec la raison en une phrase | Maximes de quantité et de pertinence [1][3] |
| Objections (prix, délai, confiance) | Il écoute, montre qu'il a compris, demande ce qui gêne vraiment, puis répond avec les faits du catalogue ; remise ou délai : l'équipe | Méthode LAER : *Listen, Acknowledge, Explore, Respond* [7] |
| Client mécontent | Il le laisse s'exprimer, montre qu'il comprend, s'excuse du désagrément sans accuser personne, passe la main à l'équipe et dit ce qui va se passer | Méthode HEARD du Disney Institute : *Hear, Empathize, Apologize, Resolve, Diagnose* [8] |
| Conclure sans forcer | Une seule étape suivante, claire ; s'il veut réfléchir, il respecte et laisse la porte ouverte | *SPIN Selling* : viser une « avancée » concrète plutôt que des techniques de pression pour conclure [5] |
| Pas de manipulation | Pas de fausse urgence (« plus que 2 », « aujourd'hui seulement »), pas de pression, pas de dénigrement des concurrents | Pratiques trompeuses ou agressives, interdites par le droit de la consommation [10][11] |
| La langue du client | Il répond dans la langue du client (règle déjà en place) | 76 % des acheteurs en ligne préfèrent acheter avec des informations dans leur langue [12] |

Trois exemples de ton (« c'est trop cher », client fâché, « je vais réfléchir ») accompagnent la méthode. Ils sont volontairement neutres : aucun produit d'une entreprise n'y figure, ce que vérifie `test/playbook.test.ts`.

Les règles commerciales restent au-dessus de tout : ne jamais inventer un prix, un stock ou un délai, faire confirmer le récapitulatif avant d'enregistrer, passer la main à l'équipe pour une négociation ou une réclamation (`src/prompt.ts`).

## Vérifier le résultat

1. Dans l'application, onglet **Tester**, jouer les situations difficiles : un client vague, « c'est trop cher », un client fâché, « je vais réfléchir », un message plein d'abréviations.
2. Regarder ensuite les vraies conversations (onglet **Conversations**) et noter ce qui ne va pas : une règle qui manque se corrige ici, une particularité d'une entreprise dans ses consignes.

Coût : la méthode ajoute environ 1 000 jetons au prompt système, mis en cache comme le reste, donc presque rien par message.

## Sources

1. H. P. Grice, « Logic and Conversation », dans P. Cole et J. Morgan (dir.), *Syntax and Semantics*, vol. 3, Academic Press, 1975.
2. Google, Conversation Design, « Create a persona » : https://developers.google.com/assistant/conversation-design/create-a-persona
3. Google, Conversation Design, « Learn about conversation » (principe de coopération et maximes) : https://developers.google.com/assistant/conversation-design/learn-about-conversation
4. M. Dixon, K. Freeman et N. Toman, « Stop Trying to Delight Your Customers », *Harvard Business Review*, juillet-août 2010 : https://hbr.org/2010/07/stop-trying-to-delight-your-customers
5. N. Rackham, *SPIN Selling*, McGraw-Hill, 1988 (recherche Huthwaite sur 35 000 entretiens de vente) : https://en.wikipedia.org/wiki/Neil_Rackham
6. C. R. Rogers et R. E. Farson, *Active Listening*, Industrial Relations Center, Université de Chicago, 1957.
7. Méthode LAER, enseignée par Carew International ; présentation : https://thinkinsights.net/commercial-excellence/laer-model
8. Méthode HEARD du Disney Institute ; présentation : https://wp.customerservicegroup.com/2025/05/15/service-recovery-the-disney-way/
9. D. Carnegie, *How to Win Friends and Influence People*, 1936 (se souvenir du nom de la personne et l'utiliser).
10. Directive 2005/29/CE sur les pratiques commerciales déloyales, annexe I, point 7 (fausse disponibilité limitée pour forcer une décision immédiate) : https://eur-lex.europa.eu/legal-content/FR/TXT/?uri=CELEX:32005L0029
11. Côte d'Ivoire, loi n° 2016-412 du 15 juin 2016 relative à la consommation, livre 1, titre 2 (pratiques commerciales interdites, dont les pratiques déloyales, trompeuses et agressives) : https://leap.unep.org/en/countries/ci/national-legislation/loi-ndeg2016-412-du-15-juin-2016-relative-la-consommation
12. CSA Research, « Can't Read, Won't Buy – B2C », 2020 (8 709 consommateurs, 29 pays) : https://csa-research.com/Blogs-Events/CSA-in-the-Media/Press-Releases/Consumers-Prefer-their-Own-Language
