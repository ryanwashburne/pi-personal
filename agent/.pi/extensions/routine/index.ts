/**
 * Create, list, and remove scheduled routines.
 * Talks to the Sprite loopback gateway; the gateway pushes cron to the home daemon.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseRoutineAction, runRoutineTool, ROUTINE_ACTIONS } from "./run";

export default function routineExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "routine",
    label: "Routine",
    description:
      "Schedule a repeating prompt on the home daemon (Raspberry Pi / Mac). Convert the owner's plain language into a 5-field cron, then upsert. Use silent mode when they only want a text if something happens. Use always mode when they asked to be sent something on a schedule. List or remove existing routines here. Do not invent crontab on the Sprite.",
    promptSnippet: "Create, list, or remove a scheduled routine (plain language → cron on the home box)",
    promptGuidelines: [
      "When the owner asks to be reminded, checked, or emailed-on-a-schedule, call routine. Follow ROUTINES.md.",
      "Convert the schedule to a 5-field cron yourself (America/New_York unless they say otherwise). morning=08:00, afternoon=15:00, evening=19:00.",
      "mode=always for 'send me / remind me / summary'. mode=silent for 'text me if / watch / unless it changes'.",
      "Confirm the human schedule in the iMessage reply. Do not curl the public Sprite URL or read HEARTBEAT_SECRET.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: `list, upsert, or remove. Default list. One of: ${ROUTINE_ACTIONS.join(", ")}`,
        }),
      ),
      id: Type.Optional(
        Type.String({
          description: "Short id like weekend-spend. Required for upsert and remove.",
        }),
      ),
      title: Type.Optional(Type.String({ description: "Short label for list/confirm" })),
      cron: Type.Optional(
        Type.String({ description: "5-field cron in the routine timezone (required for upsert)" }),
      ),
      timezone: Type.Optional(Type.String({ description: "IANA timezone. Default America/New_York" })),
      prompt: Type.Optional(
        Type.String({
          description: "What Pi should do when the routine fires (required for upsert)",
        }),
      ),
      mode: Type.Optional(Type.String({ description: "always or silent. Default silent" })),
      enabled: Type.Optional(Type.Boolean({ description: "Set false to pause without deleting" })),
    }),
    async execute(_toolCallId, params) {
      try {
        parseRoutineAction(params.action);
        const text = await runRoutineTool({
          action: params.action,
          id: params.id,
          title: params.title,
          cron: params.cron,
          timezone: params.timezone,
          prompt: params.prompt,
          mode: params.mode,
          enabled: params.enabled,
        });
        return { content: [{ type: "text", text }] };
      } catch (error) {
        const text = error instanceof Error ? error.message : "routine failed";
        return { content: [{ type: "text", text }] };
      }
    },
  });
}
