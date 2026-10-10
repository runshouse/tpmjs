import { prisma } from '@tpmjs/db';
import { z } from 'zod';
import { GOOGLE_TOOLS, googleApi, googleToken } from './connection';

/** GA4 accepts ISO dates and its relative forms: today, yesterday, NdaysAgo. */
const analyticsDate = z
  .string()
  .regex(
    /^(\d{4}-\d{2}-\d{2}|today|yesterday|\d{1,4}daysAgo)$/,
    'YYYY-MM-DD, today, yesterday, or NdaysAgo'
  );
/** GA4 API names of metrics and dimensions, such as activeUsers, sessions, or pagePath. */
const analyticsField = z.string().regex(/^[A-Za-z][A-Za-z0-9_:]{0,99}$/);

const schemas = {
  drive_search: z.object({
    query: z.string().min(1).max(200),
    pageToken: z.string().max(1000).optional(),
  }),
  drive_read: z.object({ fileId: z.string().min(1).max(256) }),
  gmail_search: z.object({
    query: z.string().min(1).max(500),
    pageToken: z.string().max(1000).optional(),
  }),
  gmail_read: z.object({ messageId: z.string().min(1).max(256) }),
  gmail_send: z.object({
    to: z.array(z.email()).min(1).max(20),
    subject: z.string().min(1).max(300),
    body: z.string().min(1).max(100_000),
  }),
  analytics_properties: z.object({ pageToken: z.string().max(1000).optional() }),
  analytics_report: z.object({
    property: z
      .string()
      .regex(/^(properties\/)?\d{1,20}$/, 'A GA4 property ID, such as properties/123'),
    startDate: analyticsDate,
    endDate: analyticsDate,
    metrics: z.array(analyticsField).min(1).max(10),
    dimensions: z.array(analyticsField).max(9).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  }),
} as const;

export const GOOGLE_TOOL_SCHEMAS: Record<string, unknown> = {
  drive_search: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text in file name or content' },
      pageToken: { type: 'string' },
    },
    required: ['query'],
  },
  drive_read: { type: 'object', properties: { fileId: { type: 'string' } }, required: ['fileId'] },
  gmail_search: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search syntax' },
      pageToken: { type: 'string' },
    },
    required: ['query'],
  },
  gmail_read: {
    type: 'object',
    properties: { messageId: { type: 'string' } },
    required: ['messageId'],
  },
  gmail_send: {
    type: 'object',
    properties: {
      to: { type: 'array', items: { type: 'string', format: 'email' } },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['to', 'subject', 'body'],
  },
  analytics_properties: {
    type: 'object',
    properties: { pageToken: { type: 'string' } },
  },
  analytics_report: {
    type: 'object',
    properties: {
      property: {
        type: 'string',
        description: 'GA4 property, as properties/123 or 123 (from analytics_properties)',
      },
      startDate: {
        type: 'string',
        description: 'YYYY-MM-DD, today, yesterday, or NdaysAgo (for example 7daysAgo)',
      },
      endDate: { type: 'string', description: 'YYYY-MM-DD, today, yesterday, or NdaysAgo' },
      metrics: {
        type: 'array',
        items: { type: 'string' },
        description: 'GA4 metric API names, for example activeUsers, sessions, screenPageViews',
      },
      dimensions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional GA4 dimension API names, for example date, pagePath, sessionSource',
      },
      limit: { type: 'integer', description: 'Most rows to return (1-1000, default 100)' },
    },
    required: ['property', 'startDate', 'endDate', 'metrics'],
  },
};

function url(base: string, params: Record<string, string>) {
  const target = new URL(base);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  return target.toString();
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function messageBody(payload: unknown): string {
  const parts: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }[] = [];
  function walk(part: unknown, depth: number) {
    if (depth > 8 || !part || typeof part !== 'object') return;
    const node = part as { mimeType?: string; body?: { data?: string }; parts?: unknown[] };
    parts.push(node);
    for (const child of node.parts ?? []) walk(child, depth + 1);
  }
  walk(payload, 0);
  const selected =
    parts.find((part) => part.mimeType === 'text/plain' && part.body?.data) ??
    parts.find((part) => part.body?.data);
  return selected?.body?.data ? decodeBase64Url(selected.body.data).slice(0, 80_000) : '';
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Each named operation has a separate validated schema and a fixed Google endpoint.
export async function executeGoogleTool(
  userId: string,
  connectionId: string,
  name: string,
  input: unknown
) {
  const tool = GOOGLE_TOOLS.find((item) => item.name === name);
  if (!tool) throw new Error('Unknown Google tool');
  const token = await googleToken(userId, connectionId, tool.scope);
  switch (name) {
    case 'drive_search': {
      const args = schemas.drive_search.parse(input);
      const escaped = args.query.replaceAll('\\', '\\\\').replaceAll("'", "\\'");
      return JSON.parse(
        await googleApi(
          token,
          url('https://www.googleapis.com/drive/v3/files', {
            q: `trashed = false and (name contains '${escaped}' or fullText contains '${escaped}')`,
            pageSize: '30',
            fields:
              'nextPageToken,files(id,name,mimeType,webViewLink,description,modifiedTime,size)',
            ...(args.pageToken ? { pageToken: args.pageToken } : {}),
          })
        )
      );
    }
    case 'drive_read': {
      const args = schemas.drive_read.parse(input);
      const fileId = encodeURIComponent(args.fileId);
      const file = JSON.parse(
        await googleApi(
          token,
          url(`https://www.googleapis.com/drive/v3/files/${fileId}`, {
            fields: 'id,name,mimeType,webViewLink,description,size',
          })
        )
      ) as { mimeType: string; size?: string };
      if (file.size && Number(file.size) > 2_000_000)
        throw new Error('File is too large for this tool');
      const mime = file.mimeType;
      const exportType: Record<string, string> = {
        'application/vnd.google-apps.document': 'text/plain',
        'application/vnd.google-apps.spreadsheet': 'text/csv',
      };
      const content = exportType[mime]
        ? await googleApi(
            token,
            url(`https://www.googleapis.com/drive/v3/files/${fileId}/export`, {
              mimeType: exportType[mime],
            })
          )
        : mime.startsWith('text/') || mime === 'application/json'
          ? await googleApi(
              token,
              url(`https://www.googleapis.com/drive/v3/files/${fileId}`, { alt: 'media' })
            )
          : null;
      return {
        file,
        content: content?.slice(0, 100_000) ?? null,
        note: content === null ? 'Preview unavailable for this file type' : undefined,
      };
    }
    case 'gmail_search': {
      const args = schemas.gmail_search.parse(input);
      const result = JSON.parse(
        await googleApi(
          token,
          url('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
            q: args.query,
            maxResults: '30',
            ...(args.pageToken ? { pageToken: args.pageToken } : {}),
          })
        )
      ) as {
        messages?: { id: string; threadId: string }[];
        nextPageToken?: string;
        resultSizeEstimate?: number;
      };
      const messages = await Promise.all(
        (result.messages ?? []).slice(0, 20).map(async (item) => {
          const detail = JSON.parse(
            await googleApi(
              token,
              url(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}`,
                { format: 'metadata' }
              )
            )
          ) as { snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
          return {
            ...item,
            snippet: detail.snippet,
            headers: (detail.payload?.headers ?? []).filter((header) =>
              ['from', 'subject', 'date'].includes(header.name.toLowerCase())
            ),
          };
        })
      );
      return {
        messages,
        nextPageToken: result.nextPageToken,
        resultSizeEstimate: result.resultSizeEstimate,
      };
    }
    case 'gmail_read': {
      const args = schemas.gmail_read.parse(input);
      const message = JSON.parse(
        await googleApi(
          token,
          url(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}`,
            { format: 'full' }
          )
        )
      ) as {
        id: string;
        threadId: string;
        snippet?: string;
        payload?: { headers?: { name: string; value: string }[] };
      };
      return {
        id: message.id,
        threadId: message.threadId,
        snippet: message.snippet,
        headers: message.payload?.headers,
        body: messageBody(message.payload),
      };
    }
    case 'gmail_send': {
      const args = schemas.gmail_send.parse(input);
      const account = await prisma.googleConnection.findFirst({
        where: { id: connectionId, userId },
        select: { email: true },
      });
      if (!account) throw new Error('Google account unavailable');
      const from = z.email().parse(account.email);
      const subject = Buffer.from(args.subject, 'utf8').toString('base64');
      const encodedBody =
        Buffer.from(args.body, 'utf8')
          .toString('base64')
          .match(/.{1,76}/g)
          ?.join('\r\n') ?? '';
      const raw = `From: ${from}\r\nTo: ${args.to.join(', ')}\r\nSubject: =?UTF-8?B?${subject}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodedBody}`;
      return JSON.parse(
        await googleApi(token, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
        })
      );
    }
    case 'analytics_properties': {
      const args = schemas.analytics_properties.parse(input);
      const result = JSON.parse(
        await googleApi(
          token,
          url('https://analyticsadmin.googleapis.com/v1beta/accountSummaries', {
            pageSize: '200',
            ...(args.pageToken ? { pageToken: args.pageToken } : {}),
          })
        )
      ) as {
        accountSummaries?: {
          account: string;
          displayName?: string;
          propertySummaries?: { property: string; displayName?: string; propertyType?: string }[];
        }[];
        nextPageToken?: string;
      };
      return {
        accounts: (result.accountSummaries ?? []).map((summary) => ({
          account: summary.account,
          name: summary.displayName,
          properties: (summary.propertySummaries ?? []).map((property) => ({
            property: property.property,
            name: property.displayName,
            type: property.propertyType,
          })),
        })),
        nextPageToken: result.nextPageToken,
      };
    }
    case 'analytics_report': {
      const args = schemas.analytics_report.parse(input);
      const property = args.property.startsWith('properties/')
        ? args.property
        : `properties/${args.property}`;
      const dimensions = args.dimensions ?? [];
      const result = JSON.parse(
        await googleApi(
          token,
          `https://analyticsdata.googleapis.com/v1beta/${property}:runReport`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              dateRanges: [{ startDate: args.startDate, endDate: args.endDate }],
              metrics: args.metrics.map((name) => ({ name })),
              dimensions: dimensions.map((name) => ({ name })),
              limit: String(args.limit ?? 100),
              metricAggregations: ['TOTAL'],
            }),
          }
        )
      ) as {
        rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[];
        totals?: { metricValues?: { value?: string }[] }[];
        rowCount?: number;
        metadata?: { currencyCode?: string; timeZone?: string };
      };
      // Rows as named values, so a reader does not have to line up headers with positions.
      const named = (names: string[], values: { value?: string }[] | undefined) =>
        Object.fromEntries(names.map((name, index) => [name, values?.[index]?.value ?? null]));
      return {
        property,
        dateRange: { startDate: args.startDate, endDate: args.endDate },
        rows: (result.rows ?? []).map((row) => ({
          ...named(dimensions, row.dimensionValues),
          ...named(args.metrics, row.metricValues),
        })),
        totals: result.totals?.[0] ? named(args.metrics, result.totals[0].metricValues) : null,
        rowCount: result.rowCount ?? 0,
        timeZone: result.metadata?.timeZone,
        currencyCode: result.metadata?.currencyCode,
      };
    }
    default:
      throw new Error('Unknown Google tool');
  }
}
