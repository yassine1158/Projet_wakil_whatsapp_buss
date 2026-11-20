import { describe, expect, it } from "vitest";
import {
  anonymize,
  claudeAction,
  defaultBrain,
  fnv1a,
  loadBrain,
  predict,
  words,
  type BrainFile,
} from "../src/brain";
import modelFile from "../src/brain-model.json";

describe("Wakil Brain", () => {
  it("hache comme la version Python (FNV-1a 32 bits)", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
    expect(fnv1a("a")).toBe(0xe40c292c);
    expect(fnv1a("foobar")).toBe(0xbf9cf968);
  });

  it("découpe le texte comme la version Python", () => {
    expect(words("Ça coûte COMBIEN ? 2,5 tonnes!")).toEqual(["ca", "coute", "combien", "0", "0", "tonnes"]);
    expect(words("مرحبا  بك")).toEqual(["مرحبا", "بك"]);
    expect(words("")).toEqual([]);
  });

  it("donne les mêmes probabilités que le modèle Python (cas exportés avec le modèle)", () => {
    const brain = defaultBrain();
    const file = modelFile as BrainFile;
    expect(file.fixtures.length).toBeGreaterThan(3);
    for (const f of file.fixtures) {
      const { probs } = predict(brain, f.context, f.text);
      probs.forEach((p, i) => expect(p).toBeCloseTo(f.probs[i], 4));
    }
  });

  it("reconnaît les cas simples", () => {
    const brain = defaultBrain();
    const recap = "Récapitulatif : 2 tonnes de sable, livraison à Cocody. Confirmez-vous cette commande ?";
    expect(predict(brain, recap, "oui je confirme").label).toBe("commande");
    expect(predict(brain, "", "je veux parler à un conseiller").label).toBe("humain");
    expect(predict(brain, "", "vous avez une photo du gravier ?").label).toBe("photo");
    expect(predict(brain, "", "c'est combien le sable ?").label).toBe("reponse");
  });

  it("refuse un fichier d'un autre format", () => {
    expect(() => loadBrain({ ...(modelFile as BrainFile), format: "autre" })).toThrow();
  });

  it("traduit les outils de Claude en action", () => {
    expect(claudeAction([])).toBe("reponse");
    expect(claudeAction(["send_product_photo"])).toBe("photo");
    expect(claudeAction(["send_product_photo", "record_order"])).toBe("commande");
    expect(claudeAction(["record_order", "request_human"])).toBe("humain");
  });

  it("retire numéros et e-mails", () => {
    expect(anonymize("Appelez-moi au +225 07 08 09 10 11 ou a.b@mail.ci")).toBe("Appelez-moi au [numéro] ou [email]");
    expect(anonymize("2 tonnes de sable")).toBe("2 tonnes de sable");
  });
});
