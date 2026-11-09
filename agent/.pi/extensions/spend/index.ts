/**
 * Live spend for Pi. Reads session JSONL plus vendor APIs using env keys.
 * Never returns secrets, full phone numbers, or message bodies.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseSpendVendor, runSpend, SPEND_VENDORS } from "./run";

export default function spendExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "spend",
    label: "Spend",
    description:
      "Live spend this agent can actually measure: this iMessage session’s model tokens (from Pi session files), Sendblue line usage, OpenRouter key usage, and Anthropic org cost_report if an admin key is set. Fly has no billing API. Use this when the owner asks what this costs. Do not invent an invoice. Do not read .env or session files with bash for this.",
    promptSnippet: "Get live spend this agent can measure (session tokens, Sendblue, OpenRouter, Anthropic)",
    promptGuidelines: [
      "When the owner asks what this costs, call spend. Quote only numbers the tool returned. If a vendor is missing or failed, say so.",
      "Do not bash/cat .env, invoices, or session JSONL for spend — this tool already reads what it is allowed to.",
    ],
    parameters: Type.Object({
      vendor: Type.Optional(
        Type.String({
          description: `Which source to query. Default all. One of: ${SPEND_VENDORS.join(", ")}`,
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      try {
        const vendor = parseSpendVendor(params.vendor);
        const report = await runSpend(vendor);
        return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
      } catch (error) {
        const text = error instanceof Error ? error.message : "spend failed";
        return { content: [{ type: "text", text }] };
      }
    },
  });
}
