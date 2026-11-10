const FIELD =
  /^(?:\*|\d+)(?:-\d+)?(?:\/\d+)?(?:,(?:\*|\d+)(?:-\d+)?(?:\/\d+)?)*$/;

const RANGES = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 },
] as const;

export const DEFAULT_TIMEZONE = "America/New_York";

export function validateCron(value: string): string | undefined {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) {
    return "Cron must be 5 fields: minute hour day-of-month month day-of-week.";
  }
  for (let i = 0; i < RANGES.length; i += 1) {
    const field = fields[i] ?? "";
    const range = RANGES[i];
    if (!range) continue;
    const error = validateCronField(field, range.min, range.max, range.name);
    if (error) return error;
  }
  return undefined;
}

function validateCronField(expr: string, min: number, max: number, name: string): string | undefined {
  if (!FIELD.test(expr)) {
    return `Invalid ${name} cron field.`;
  }
  try {
    expandCronField(expr, min, max);
  } catch (error) {
    return error instanceof Error ? error.message : `Invalid ${name} cron field.`;
  }
  return undefined;
}

export function expandCronField(expr: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of expr.split(",")) {
    const [rangePart, stepRaw] = splitStep(part);
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error("Cron step must be a positive integer.");
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart.includes("-")) {
      const [left, right] = rangePart.split("-");
      start = Number(left);
      end = Number(right);
    } else {
      start = Number(rangePart);
      end = start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error("Cron fields must be integers.");
    }
    if (start < min || end > max || start > end) {
      throw new Error(`Cron value out of range (${min}-${max}).`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  return [...values].sort((a, b) => a - b);
}

function splitStep(part: string): [string, string | undefined] {
  const slash = part.indexOf("/");
  if (slash === -1) return [part, undefined];
  return [part.slice(0, slash), part.slice(slash + 1)];
}
