import type Anthropic from "@anthropic-ai/sdk";
import type { Catalog, Order, OrderItem } from "./types";

/** Actions que les outils peuvent déclencher ; fournies par le moteur de conversation. */
export interface ToolContext {
  catalog: Catalog;
  customerPhone: string;
  sendImage(link: string, caption?: string): Promise<void>;
  saveOrder(order: Omit<Order, "reference" | "createdAt" | "customerPhone">): Promise<Order>;
  requestHuman(reason: string, summary: string): Promise<void>;
}

export const TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: "send_product_photo",
    description:
      "Envoie au client la photo d'un produit du catalogue, avec une courte légende. À utiliser quand voir le produit aide le client à choisir.",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "string", description: "id du produit dans le catalogue" },
        caption: { type: "string", description: "Légende courte, dans la langue du client" },
      },
      required: ["product_id"],
      additionalProperties: false,
    },
  },
  {
    name: "record_order",
    description:
      "Enregistre la commande ou la demande de devis du client et prévient l'équipe commerciale. À appeler seulement après que le client a confirmé le récapitulatif. Renvoie la référence à donner au client.",
    input_schema: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Nom du client ou de son entreprise" },
        items: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              product_id: { type: "string", description: "id du produit dans le catalogue" },
              quantity: { type: "number", description: "Quantité, dans l'unité de vente du produit" },
            },
            required: ["product_id", "quantity"],
            additionalProperties: false,
          },
        },
        fulfilment: {
          type: "string",
          enum: ["livraison", "enlevement"],
          description: "livraison sur chantier, ou enlèvement par le client sur site",
        },
        delivery_location: { type: "string", description: "Lieu de livraison (quartier, ville, repère)" },
        desired_date: { type: "string", description: "Date ou moment souhaité, tel que dit par le client" },
        notes: { type: "string", description: "Autres précisions utiles à l'équipe" },
      },
      required: ["customer_name", "items", "fulfilment"],
      additionalProperties: false,
    },
  },
  {
    name: "request_human",
    description:
      "Passe la conversation à un conseiller humain, qui recontactera le client. L'assistant ne répond plus à ce client pendant quelques heures. Après l'appel, dis au client qu'un conseiller va le recontacter.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Pourquoi un humain est nécessaire" },
        summary: { type: "string", description: "Résumé de la demande du client pour le conseiller" },
      },
      required: ["reason", "summary"],
      additionalProperties: false,
    },
  },
];

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "send_product_photo": {
      const product = ctx.catalog.products.find((p) => p.id === args.product_id);
      if (!product) return { content: `Produit inconnu : ${String(args.product_id)}`, isError: true };
      if (!product.imageUrl) return { content: "Pas de photo pour ce produit.", isError: true };
      await ctx.sendImage(product.imageUrl, str(args.caption) ?? product.name);
      return { content: "Photo envoyée au client." };
    }
    case "record_order": {
      const customerName = str(args.customer_name);
      if (!customerName) return { content: "customer_name manquant.", isError: true };
      if (args.fulfilment !== "livraison" && args.fulfilment !== "enlevement") {
        return { content: "fulfilment doit valoir livraison ou enlevement.", isError: true };
      }
      const rawItems = Array.isArray(args.items) ? args.items : [];
      if (!rawItems.length) return { content: "La commande ne contient aucun produit.", isError: true };
      const items: OrderItem[] = [];
      for (const raw of rawItems as Record<string, unknown>[]) {
        const product = ctx.catalog.products.find((p) => p.id === raw?.product_id);
        if (!product) return { content: `Produit inconnu : ${String(raw?.product_id)}`, isError: true };
        const quantity = Number(raw.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          return { content: `Quantité invalide pour ${product.name}.`, isError: true };
        }
        items.push({ productId: product.id, productName: product.name, quantity, unit: product.unit });
      }
      const deliveryLocation = str(args.delivery_location);
      if (args.fulfilment === "livraison" && !deliveryLocation) {
        return { content: "Lieu de livraison manquant : demande-le au client.", isError: true };
      }
      const order = await ctx.saveOrder({
        customerName,
        items,
        fulfilment: args.fulfilment,
        deliveryLocation,
        desiredDate: str(args.desired_date),
        notes: str(args.notes),
      });
      return {
        content: `Commande enregistrée. Référence : ${order.reference}. L'équipe a été prévenue et confirmera le prix et la livraison.`,
      };
    }
    case "request_human": {
      await ctx.requestHuman(str(args.reason) ?? "non précisée", str(args.summary) ?? "");
      return { content: "Un conseiller a été prévenu et recontactera le client." };
    }
    default:
      return { content: `Outil inconnu : ${name}`, isError: true };
  }
}
