import { expect, test } from "bun:test";
import { isStopCommand } from "./stop-command";

test("treats short cancel texts as a stop", () => {
  for (const message of ["STOP", "stop.", "Cancel!", "abort", "quit", "never mind", "nevermind", "stop it", "please stop", "stop please"]) {
    expect(isStopCommand(message)).toBe(true);
  }
});

test("does not treat ordinary sentences as a stop", () => {
  for (const message of ["stop by the store", "don't stop", "cancel the reservation", "use the other tab", "STOP clicking checkout"]) {
    expect(isStopCommand(message)).toBe(false);
  }
});
