const STOP_RE =
  /^(please\s+)?(stop( it| that)?|cancel|abort|quit|never ?mind)(\s+please)?[.!?]*$/i;

export function isStopCommand(message: string): boolean {
  return STOP_RE.test(message.trim());
}
