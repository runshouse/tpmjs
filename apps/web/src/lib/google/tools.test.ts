import { beforeEach, describe, expect, it, vi } from 'vitest';

const googleApi = vi.fn();
vi.mock('@tpmjs/db', () => ({ prisma: {} }));
vi.mock('./connection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./connection')>();
  return {
    ...actual,
    googleToken: vi.fn(async () => 'access-token'),
    googleApi: (...args: unknown[]) => googleApi(...args),
  };
});

const { executeGoogleTool } = await import('./tools');

describe('Google Analytics tools', () => {
  beforeEach(() => googleApi.mockReset());

  it('lists accounts with their properties', async () => {
    googleApi.mockResolvedValueOnce(
      JSON.stringify({
        accountSummaries: [
          {
            account: 'accounts/1',
            displayName: 'Lord Ajax',
            propertySummaries: [
              {
                property: 'properties/42',
                displayName: 'lordajax.com',
                propertyType: 'PROPERTY_TYPE_ORDINARY',
              },
            ],
          },
        ],
      })
    );
    const result = await executeGoogleTool('user', 'connection', 'analytics_properties', {});
    expect(result).toEqual({
      accounts: [
        {
          account: 'accounts/1',
          name: 'Lord Ajax',
          properties: [
            { property: 'properties/42', name: 'lordajax.com', type: 'PROPERTY_TYPE_ORDINARY' },
          ],
        },
      ],
      nextPageToken: undefined,
    });
    expect(String(googleApi.mock.calls[0]?.[1])).toContain(
      'https://analyticsadmin.googleapis.com/v1beta/accountSummaries'
    );
  });

  it('runs a report and names each row value by its metric or dimension', async () => {
    googleApi.mockResolvedValueOnce(
      JSON.stringify({
        rows: [
          {
            dimensionValues: [{ value: '20261009' }],
            metricValues: [{ value: '12' }, { value: '30' }],
          },
        ],
        totals: [{ metricValues: [{ value: '12' }, { value: '30' }] }],
        rowCount: 1,
        metadata: { timeZone: 'Australia/Sydney' },
      })
    );
    const result = await executeGoogleTool('user', 'connection', 'analytics_report', {
      property: '42',
      startDate: 'yesterday',
      endDate: 'yesterday',
      metrics: ['activeUsers', 'sessions'],
      dimensions: ['date'],
    });
    expect(result).toMatchObject({
      property: 'properties/42',
      rows: [{ date: '20261009', activeUsers: '12', sessions: '30' }],
      totals: { activeUsers: '12', sessions: '30' },
      rowCount: 1,
      timeZone: 'Australia/Sydney',
    });
    const [, endpoint, init] = googleApi.mock.calls[0] as [string, string, RequestInit];
    expect(endpoint).toBe('https://analyticsdata.googleapis.com/v1beta/properties/42:runReport');
    expect(JSON.parse(String(init.body))).toMatchObject({
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }],
      dimensions: [{ name: 'date' }],
      limit: '100',
    });
  });

  it('refuses a property or date Google would not accept, before calling it', async () => {
    for (const input of [
      { property: 'lordajax.com', startDate: 'today', endDate: 'today', metrics: ['sessions'] },
      { property: '42', startDate: 'last week', endDate: 'today', metrics: ['sessions'] },
      { property: '42', startDate: 'today', endDate: 'today', metrics: [] },
    ]) {
      await expect(
        executeGoogleTool('user', 'connection', 'analytics_report', input)
      ).rejects.toThrow();
    }
    expect(googleApi).not.toHaveBeenCalled();
  });
});
