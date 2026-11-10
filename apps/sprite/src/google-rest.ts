import type { GoogleFetch } from "./google-oauth";
import type { GoogleMcpName } from "./mcp-config";
import type { McpTool, McpToolResult } from "./mcp-stdio";

export const GOOGLE_MCP_INSTRUCTIONS: Record<GoogleMcpName, string> = {
  gmail: "Gmail REST on this Sprite. Search, read, label, and draft mail. Cannot send. Sprite talks only to Google.",
  calendar: "Google Calendar REST on this Sprite. List, search, create, update, and delete events.",
  drive: "Google Drive REST on this Sprite. Search, read, and create files. Sprite talks only to Google.",
  search: "Search Gmail, Calendar, and Drive together. Sprite talks only to Google APIs.",
};

export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

const TEXT_LIMIT = 80_000;
const DEFAULT_MAX = 10;

export type GoogleRestDeps = {
  token: () => Promise<string>;
  fetchImpl?: GoogleFetch;
  now?: () => number;
};

type GmailTool = "search_emails" | "get_email" | "create_draft" | "list_labels" | "modify_labels";
type CalendarTool =
  | "list_calendars"
  | "list_events"
  | "get_event"
  | "create_event"
  | "update_event"
  | "delete_event"
  | "get_freebusy";
type DriveTool = "search_files" | "get_file" | "get_file_content" | "create_file";
type SearchTool = "search_corpus";

const stringProp = { type: "string" };
const numberProp = { type: "number" };
const stringArray = { type: "array", items: { type: "string" } };

export const GMAIL_TOOLS: McpTool[] = [
  {
    name: "search_emails",
    description: "Search Gmail with Gmail query syntax (from:, newer_than:, in:inbox, …).",
    inputSchema: objectSchema({ q: stringProp, maxResults: numberProp }, ["q"]),
  },
  {
    name: "get_email",
    description: "Read one Gmail message by id.",
    inputSchema: objectSchema({ id: stringProp }, ["id"]),
  },
  {
    name: "create_draft",
    description: "Create a Gmail draft. Cannot send.",
    inputSchema: objectSchema(
      { to: stringArray, cc: stringArray, bcc: stringArray, subject: stringProp, body: stringProp, threadId: stringProp },
      ["to", "subject", "body"],
    ),
  },
  {
    name: "list_labels",
    description: "List Gmail labels.",
    inputSchema: objectSchema({}),
  },
  {
    name: "modify_labels",
    description: "Add or remove Gmail labels on a message.",
    inputSchema: objectSchema(
      { id: stringProp, addLabelIds: stringArray, removeLabelIds: stringArray },
      ["id"],
    ),
  },
];

export const CALENDAR_TOOLS: McpTool[] = [
  {
    name: "list_calendars",
    description: "List calendars on the account.",
    inputSchema: objectSchema({}),
  },
  {
    name: "list_events",
    description: "List or search events. Defaults to the next few weeks on primary.",
    inputSchema: objectSchema({
      calendarId: stringProp,
      timeMin: stringProp,
      timeMax: stringProp,
      q: stringProp,
      maxResults: numberProp,
    }),
  },
  {
    name: "get_event",
    description: "Get one calendar event.",
    inputSchema: objectSchema({ eventId: stringProp, calendarId: stringProp }, ["eventId"]),
  },
  {
    name: "create_event",
    description: "Create a calendar event. start/end are RFC3339 or YYYY-MM-DD for all-day.",
    inputSchema: objectSchema(
      {
        calendarId: stringProp,
        summary: stringProp,
        start: stringProp,
        end: stringProp,
        timeZone: stringProp,
        description: stringProp,
        location: stringProp,
        attendees: stringArray,
      },
      ["summary", "start", "end"],
    ),
  },
  {
    name: "update_event",
    description: "Patch a calendar event. Omit fields you are not changing.",
    inputSchema: objectSchema(
      {
        eventId: stringProp,
        calendarId: stringProp,
        summary: stringProp,
        start: stringProp,
        end: stringProp,
        timeZone: stringProp,
        description: stringProp,
        location: stringProp,
        attendees: stringArray,
      },
      ["eventId"],
    ),
  },
  {
    name: "delete_event",
    description: "Delete a calendar event.",
    inputSchema: objectSchema({ eventId: stringProp, calendarId: stringProp }, ["eventId"]),
  },
  {
    name: "get_freebusy",
    description: "Check free/busy for calendars in a time range.",
    inputSchema: objectSchema(
      { timeMin: stringProp, timeMax: stringProp, calendarIds: stringArray },
      ["timeMin", "timeMax"],
    ),
  },
];

export const DRIVE_TOOLS: McpTool[] = [
  {
    name: "search_files",
    description: "Search Drive. Plain text matches name/fullText; Drive query syntax is passed through.",
    inputSchema: objectSchema({ q: stringProp, pageSize: numberProp }, ["q"]),
  },
  {
    name: "get_file",
    description: "Get Drive file metadata.",
    inputSchema: objectSchema({ fileId: stringProp }, ["fileId"]),
  },
  {
    name: "get_file_content",
    description: "Download a Drive file as text (Google Docs exported as plain text).",
    inputSchema: objectSchema({ fileId: stringProp }, ["fileId"]),
  },
  {
    name: "create_file",
    description: "Create a file owned by this app (drive.file). Text content only.",
    inputSchema: objectSchema(
      { name: stringProp, content: stringProp, mimeType: stringProp, parentId: stringProp },
      ["name", "content"],
    ),
  },
];

export const SEARCH_TOOLS: McpTool[] = [
  {
    name: "search_corpus",
    description: "Search Gmail, Calendar, and Drive in one call. Sprite talks only to Google APIs.",
    inputSchema: objectSchema({
      query: stringProp,
      sources: stringArray,
      maxPerSource: numberProp,
    }, ["query"]),
  },
];

export function toolsForGoogleService(service: GoogleMcpName): McpTool[] {
  switch (service) {
    case "gmail":
      return GMAIL_TOOLS;
    case "calendar":
      return CALENDAR_TOOLS;
    case "drive":
      return DRIVE_TOOLS;
    case "search":
      return SEARCH_TOOLS;
    default: {
      const _exhaustive: never = service;
      throw new Error(`Unknown Google MCP: ${_exhaustive}`);
    }
  }
}

export async function callGoogleTool(
  service: GoogleMcpName,
  name: string,
  args: Record<string, unknown>,
  deps: GoogleRestDeps,
): Promise<McpToolResult> {
  switch (service) {
    case "gmail":
      return callGmailTool(asTool(name, gmailTools), args, deps);
    case "calendar":
      return callCalendarTool(asTool(name, calendarTools), args, deps);
    case "drive":
      return callDriveTool(asTool(name, driveTools), args, deps);
    case "search":
      return callSearchTool(asTool(name, searchTools), args, deps);
    default: {
      const _exhaustive: never = service;
      throw new Error(`Unknown Google MCP: ${_exhaustive}`);
    }
  }
}

const gmailTools = ["search_emails", "get_email", "create_draft", "list_labels", "modify_labels"] as const;
const calendarTools = [
  "list_calendars",
  "list_events",
  "get_event",
  "create_event",
  "update_event",
  "delete_event",
  "get_freebusy",
] as const;
const driveTools = ["search_files", "get_file", "get_file_content", "create_file"] as const;
const searchTools = ["search_corpus"] as const;

async function callGmailTool(
  name: GmailTool,
  args: Record<string, unknown>,
  deps: GoogleRestDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "search_emails":
      return searchEmails(args, deps);
    case "get_email":
      return getEmail(str(args, "id", true), deps);
    case "create_draft":
      return createDraft(args, deps);
    case "list_labels":
      return jsonResult(await googleJson(deps, "GET", `${GMAIL_API}/users/me/labels`));
    case "modify_labels":
      return jsonResult(
        await googleJson(deps, "POST", `${GMAIL_API}/users/me/messages/${encodeURIComponent(str(args, "id", true))}/modify`, {
          addLabelIds: strs(args.addLabelIds),
          removeLabelIds: strs(args.removeLabelIds),
        }),
      );
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown Gmail tool: ${_exhaustive}`);
    }
  }
}

async function callCalendarTool(
  name: CalendarTool,
  args: Record<string, unknown>,
  deps: GoogleRestDeps,
): Promise<McpToolResult> {
  const calendarId = encodeURIComponent(str(args, "calendarId") || "primary");
  switch (name) {
    case "list_calendars":
      return jsonResult(await googleJson(deps, "GET", `${CALENDAR_API}/users/me/calendarList`));
    case "list_events":
      return listEvents(args, deps);
    case "get_event":
      return jsonResult(
        await googleJson(
          deps,
          "GET",
          `${CALENDAR_API}/calendars/${calendarId}/events/${encodeURIComponent(str(args, "eventId", true))}`,
        ),
      );
    case "create_event":
      return jsonResult(await googleJson(deps, "POST", `${CALENDAR_API}/calendars/${calendarId}/events`, eventBody(args)));
    case "update_event":
      return jsonResult(
        await googleJson(
          deps,
          "PATCH",
          `${CALENDAR_API}/calendars/${calendarId}/events/${encodeURIComponent(str(args, "eventId", true))}`,
          eventBody(args, true),
        ),
      );
    case "delete_event":
      await googleJson(
        deps,
        "DELETE",
        `${CALENDAR_API}/calendars/${calendarId}/events/${encodeURIComponent(str(args, "eventId", true))}`,
      );
      return textResult("Deleted.");
    case "get_freebusy":
      return jsonResult(
        await googleJson(deps, "POST", `${CALENDAR_API}/freeBusy`, {
          timeMin: str(args, "timeMin", true),
          timeMax: str(args, "timeMax", true),
          items: (strs(args.calendarIds).length > 0 ? strs(args.calendarIds) : ["primary"]).map((id) => ({ id })),
        }),
      );
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown Calendar tool: ${_exhaustive}`);
    }
  }
}

async function callDriveTool(
  name: DriveTool,
  args: Record<string, unknown>,
  deps: GoogleRestDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "search_files":
      return searchFiles(args, deps);
    case "get_file":
      return jsonResult(
        await googleJson(
          deps,
          "GET",
          `${DRIVE_API}/files/${encodeURIComponent(str(args, "fileId", true))}?fields=${driveFieldList()}`,
        ),
      );
    case "get_file_content":
      return getFileContent(str(args, "fileId", true), deps);
    case "create_file":
      return createFile(args, deps);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown Drive tool: ${_exhaustive}`);
    }
  }
}

async function callSearchTool(
  name: SearchTool,
  args: Record<string, unknown>,
  deps: GoogleRestDeps,
): Promise<McpToolResult> {
  switch (name) {
    case "search_corpus":
      return searchCorpus(args, deps);
    default: {
      const _exhaustive: never = name;
      throw new Error(`Unknown search tool: ${_exhaustive}`);
    }
  }
}

async function searchEmails(args: Record<string, unknown>, deps: GoogleRestDeps): Promise<McpToolResult> {
  const maxResults = clampInt(args.maxResults, DEFAULT_MAX, 25);
  const listed = (await googleJson(deps, "GET", `${GMAIL_API}/users/me/messages?${gmailListQuery(args, maxResults)}`)) as {
    messages?: Array<{ id?: string }>;
    nextPageToken?: string;
    resultSizeEstimate?: number;
  };
  const ids = (listed.messages ?? []).map((message) => message.id).filter((id): id is string => Boolean(id));
  const messages = [];
  for (const id of ids) {
    messages.push(await gmailMetadata(id, deps));
  }
  return jsonResult({ resultSizeEstimate: listed.resultSizeEstimate, nextPageToken: listed.nextPageToken, messages });
}

async function getEmail(id: string, deps: GoogleRestDeps): Promise<McpToolResult> {
  const message = (await googleJson(
    deps,
    "GET",
    `${GMAIL_API}/users/me/messages/${encodeURIComponent(id)}?format=full`,
  )) as GmailMessage;
  return jsonResult({
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    labelIds: message.labelIds,
    headers: pickHeaders(message),
    body: clip(gmailText(message.payload)),
  });
}

async function createDraft(args: Record<string, unknown>, deps: GoogleRestDeps): Promise<McpToolResult> {
  const to = strs(args.to);
  if (to.length === 0) throw new Error("to is required.");
  const raw = encodeBase64Url(
    [
      `To: ${to.join(", ")}`,
      ...(strs(args.cc).length ? [`Cc: ${strs(args.cc).join(", ")}`] : []),
      ...(strs(args.bcc).length ? [`Bcc: ${strs(args.bcc).join(", ")}`] : []),
      `Subject: ${str(args, "subject", true)}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      str(args, "body", true),
    ].join("\r\n"),
  );
  const threadId = str(args, "threadId");
  return jsonResult(
    await googleJson(deps, "POST", `${GMAIL_API}/users/me/drafts`, {
      message: { raw, ...(threadId ? { threadId } : {}) },
    }),
  );
}

async function listEvents(args: Record<string, unknown>, deps: GoogleRestDeps): Promise<McpToolResult> {
  const calendarId = encodeURIComponent(str(args, "calendarId") || "primary");
  const now = deps.now?.() ?? Date.now();
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: String(clampInt(args.maxResults, DEFAULT_MAX, 50)),
    timeMin: str(args, "timeMin") || new Date(now - 7 * 86_400_000).toISOString(),
    timeMax: str(args, "timeMax") || new Date(now + 21 * 86_400_000).toISOString(),
  });
  const q = str(args, "q");
  if (q) params.set("q", q);
  return jsonResult(await googleJson(deps, "GET", `${CALENDAR_API}/calendars/${calendarId}/events?${params}`));
}

async function searchFiles(args: Record<string, unknown>, deps: GoogleRestDeps): Promise<McpToolResult> {
  const q = driveQuery(str(args, "q", true));
  const params = new URLSearchParams({
    q,
    pageSize: String(clampInt(args.pageSize, DEFAULT_MAX, 25)),
    fields: `nextPageToken,files(${driveFieldList()})`,
  });
  return jsonResult(await googleJson(deps, "GET", `${DRIVE_API}/files?${params}`));
}

async function getFileContent(fileId: string, deps: GoogleRestDeps): Promise<McpToolResult> {
  const meta = (await googleJson(
    deps,
    "GET",
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType`,
  )) as { mimeType?: string; name?: string };
  const exportMime = exportMimeFor(meta.mimeType);
  const path = exportMime
    ? `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`
    : `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`;
  const text = await googleText(deps, "GET", path);
  return jsonResult({ id: fileId, name: meta.name, mimeType: meta.mimeType, content: clip(text) });
}

async function createFile(args: Record<string, unknown>, deps: GoogleRestDeps): Promise<McpToolResult> {
  const mimeType = str(args, "mimeType") || "text/plain";
  const metadata: Record<string, unknown> = { name: str(args, "name", true), mimeType };
  const parentId = str(args, "parentId");
  if (parentId) metadata.parents = [parentId];
  const created = (await googleJson(deps, "POST", `${DRIVE_API}/files`, metadata)) as { id?: string };
  if (!created.id) throw new Error("Drive did not return a file id.");
  await googleJson(
    deps,
    "PATCH",
    `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(created.id)}?uploadType=media`,
    str(args, "content", true),
    mimeType,
  );
  return jsonResult(
    await googleJson(deps, "GET", `${DRIVE_API}/files/${encodeURIComponent(created.id)}?fields=${driveFieldList()}`),
  );
}

async function searchCorpus(args: Record<string, unknown>, deps: GoogleRestDeps): Promise<McpToolResult> {
  const query = str(args, "query", true);
  const maxPerSource = clampInt(args.maxPerSource, 5, 10);
  const sources = requestedSources(args.sources);
  const result: Record<string, unknown> = { query };
  await Promise.all(
    sources.map(async (source) => {
      try {
        result[source] = await searchSource(source, query, maxPerSource, deps);
      } catch (error) {
        result[source] = { error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  return jsonResult(result);
}

async function searchSource(
  source: Exclude<GoogleMcpName, "search">,
  query: string,
  maxPerSource: number,
  deps: GoogleRestDeps,
): Promise<unknown> {
  switch (source) {
    case "gmail":
      return jsonParse(await searchEmails({ q: query, maxResults: maxPerSource }, deps));
    case "calendar":
      return jsonParse(await listEvents({ q: query, maxResults: maxPerSource }, deps));
    case "drive":
      return jsonParse(await searchFiles({ q: query, pageSize: maxPerSource }, deps));
    default: {
      const _exhaustive: never = source;
      throw new Error(`Unknown search source: ${_exhaustive}`);
    }
  }
}

function requestedSources(value: unknown): Array<Exclude<GoogleMcpName, "search">> {
  const allowed = ["gmail", "calendar", "drive"] as const;
  const listed = strs(value).map((entry) => entry.trim().toLowerCase());
  if (listed.length === 0) return [...allowed];
  const picked = allowed.filter((name) => listed.includes(name));
  if (picked.length === 0) throw new Error("sources must be gmail, calendar, and/or drive.");
  return picked;
}

async function gmailMetadata(id: string, deps: GoogleRestDeps): Promise<unknown> {
  const message = (await googleJson(
    deps,
    "GET",
    `${GMAIL_API}/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
  )) as GmailMessage;
  return {
    id: message.id,
    threadId: message.threadId,
    snippet: message.snippet,
    labelIds: message.labelIds,
    headers: pickHeaders(message),
  };
}

export async function googleJson(
  deps: GoogleRestDeps,
  method: string,
  url: string,
  body?: unknown,
  contentType = "application/json",
): Promise<unknown> {
  const response = await googleRequest(deps, method, url, body, contentType);
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

async function googleText(deps: GoogleRestDeps, method: string, url: string): Promise<string> {
  const response = await googleRequest(deps, method, url);
  return response.text();
}

async function googleRequest(
  deps: GoogleRestDeps,
  method: string,
  url: string,
  body?: unknown,
  contentType = "application/json",
): Promise<Response> {
  const token = await deps.token();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let payload: BodyInit | undefined;
  if (body !== undefined && method !== "GET" && method !== "DELETE") {
    if (typeof body === "string") {
      headers["content-type"] = contentType;
      payload = body;
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
  }
  const response = await fetchImpl(url, { method, headers, body: payload });
  if (!response.ok) {
    throw new Error(await googleError(response));
  }
  return response;
}

async function googleError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string" && parsed.error.message.trim()) {
      return parsed.error.message;
    }
  } catch {
    // Use the status line when the body is not Google's JSON error shape.
  }
  return `Google API failed (${response.status}).`;
}

function eventBody(args: Record<string, unknown>, patch = false): Record<string, unknown> {
  const timeZone = str(args, "timeZone") || undefined;
  const body: Record<string, unknown> = {};
  const summary = str(args, "summary");
  const description = str(args, "description");
  const location = str(args, "location");
  const start = str(args, "start");
  const end = str(args, "end");
  if (summary) body.summary = summary;
  if (description) body.description = description;
  if (location) body.location = location;
  if (start) body.start = eventTime(start, timeZone);
  if (end) body.end = eventTime(end, timeZone);
  if (args.attendees !== undefined) {
    body.attendees = strs(args.attendees).map((email) => ({ email }));
  }
  if (!patch && (!body.summary || !body.start || !body.end)) {
    throw new Error("summary, start, and end are required.");
  }
  return body;
}

function eventTime(value: string, timeZone?: string): Record<string, string> {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  return timeZone ? { dateTime: value, timeZone } : { dateTime: value };
}

function gmailListQuery(args: Record<string, unknown>, maxResults: number): string {
  const params = new URLSearchParams({ maxResults: String(maxResults), q: str(args, "q", true) });
  return params.toString();
}

function driveQuery(q: string): string {
  if (/[=:]/.test(q) || /\bcontains\b/i.test(q)) return q;
  const escaped = q.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  return `fullText contains '${escaped}' or name contains '${escaped}'`;
}

function driveFieldList(): string {
  return "id,name,mimeType,modifiedTime,webViewLink,parents,size";
}

function exportMimeFor(mimeType: string | undefined): string | undefined {
  switch (mimeType) {
    case "application/vnd.google-apps.document":
      return "text/plain";
    case "application/vnd.google-apps.spreadsheet":
      return "text/csv";
    case "application/vnd.google-apps.presentation":
      return "text/plain";
    default:
      return undefined;
  }
}

type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  payload?: GmailPart;
};

type GmailPart = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: Array<{ name?: string; value?: string }>;
};

function pickHeaders(message: GmailMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const header of message.payload?.headers ?? []) {
    if (!header.name || header.value === undefined) continue;
    const name = header.name.toLowerCase();
    if (name === "from" || name === "to" || name === "cc" || name === "subject" || name === "date") {
      headers[name] = header.value;
    }
  }
  return headers;
}

function gmailText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType?.startsWith("text/plain") && part.body?.data) return decodeBase64Url(part.body.data);
  if (part.parts) {
    for (const child of part.parts) {
      const text = gmailText(child);
      if (text) return text;
    }
  }
  if (part.mimeType?.startsWith("text/html") && part.body?.data) return decodeBase64Url(part.body.data);
  return "";
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
}

function asTool<T extends string>(name: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(name)) return name as T;
  throw new Error(`Unknown tool: ${name || "(missing)"}`);
}

function str(args: Record<string, unknown>, key: string, required = false): string {
  const value = args[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (required) throw new Error(`${key} is required.`);
  return "";
}

function strs(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

function clampInt(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

function jsonResult(value: unknown): McpToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function jsonParse(result: McpToolResult): unknown {
  const text = result.content[0]?.text ?? "{}";
  return JSON.parse(text) as unknown;
}

function textResult(text: string): McpToolResult {
  return { content: [{ type: "text", text }] };
}

function clip(text: string): string {
  if (text.length <= TEXT_LIMIT) return text;
  return `${text.slice(0, TEXT_LIMIT)}\n…[truncated]`;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}
