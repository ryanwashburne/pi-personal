import type { PiAgent, PromptResult } from "./pi";
import type { SendblueClient } from "./sendblue";
import { splitMessage } from "./split";
import type { Hold } from "./tasks";

export type ScheduledTurnOptions = {
  label: string;
  prompt: string;
  pi: PiAgent;
  sendblue: SendblueClient;
  to: string;
  hold: () => Promise<Hold>;
  setBusy: (busy: boolean) => void;
  shouldDeliver: (text: string) => boolean;
};

export async function runScheduledTurn(options: ScheduledTurnOptions): Promise<void> {
  const taskP = options.hold().catch((error) => {
    console.warn(`${options.label} task hold failed`, error);
    return { async heartbeat() {}, async release() {} };
  });
  try {
    const result = await options.pi.prompt(options.prompt);
    await deliverScheduledResult(options, result);
  } catch (error) {
    console.error(`${options.label} turn failed`, error);
  } finally {
    options.setBusy(false);
    const task = await taskP;
    await task.release().catch((releaseError) =>
      console.warn(`${options.label} task release failed`, releaseError),
    );
  }
}

async function deliverScheduledResult(
  options: ScheduledTurnOptions,
  result: PromptResult,
): Promise<void> {
  switch (result.kind) {
    case "injected":
      console.log(`${options.label} injected`);
      return;
    case "reply": {
      if (!options.shouldDeliver(result.text)) {
        console.log(`${options.label} silent`);
        return;
      }
      console.log(`${options.label} reply (${result.text.length} chars)`);
      for (const chunk of splitMessage(result.text)) {
        await options.sendblue.sendMessage(options.to, chunk);
      }
      return;
    }
    default: {
      const _never: never = result;
      throw new Error(`unexpected ${options.label} result ${JSON.stringify(_never)}`);
    }
  }
}
