import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPlaygroundOutcomeRecorder,
  trackCollectionMcpCopy,
  trackEvent,
  trackInstallCommandCopy,
  trackPlaygroundExecution,
  trackSignup,
} from './analytics';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('activation-funnel analytics', () => {
  it('is a no-op during server rendering', () => {
    vi.stubGlobal('window', undefined);
    expect(() => trackEvent('tool_view', { tool: 'pkg::tool' })).not.toThrow();
  });

  it('is fail-open before gtag loads or when it throws', () => {
    vi.stubGlobal('window', {});
    expect(() => trackEvent('tool_view')).not.toThrow();

    vi.stubGlobal('window', {
      gtag: () => {
        throw new Error('analytics unavailable');
      },
    });
    expect(() => trackEvent('tool_view')).not.toThrow();
  });

  it('emits privacy-safe, stable activation events', () => {
    const gtag = vi.fn();
    vi.stubGlobal('window', { gtag });

    trackInstallCommandCopy('tool-id', 'mcp', 'Connect with Claude Code');
    trackPlaygroundExecution('tool-id', 'success');
    trackCollectionMcpCopy('collection-id', 'http_url');
    trackSignup('started');
    trackSignup('completed');

    expect(gtag.mock.calls).toEqual([
      [
        'event',
        'install_command_copy',
        { tool: 'tool-id', surface: 'mcp', snippet: 'Connect with Claude Code' },
      ],
      ['event', 'playground_execute', { tool: 'tool-id', outcome: 'success' }],
      ['event', 'collection_mcp_copy', { collection: 'collection-id', format: 'http_url' }],
      ['event', 'signup_started', { method: 'email' }],
      ['event', 'signup_completed', { method: 'email' }],
    ]);
  });

  it('records exactly one terminal outcome for each playground attempt', () => {
    const gtag = vi.fn();
    vi.stubGlobal('window', { gtag });
    const recordOutcome = createPlaygroundOutcomeRecorder('tool-id');

    recordOutcome('success');
    recordOutcome('failure');

    expect(gtag).toHaveBeenCalledOnce();
    expect(gtag).toHaveBeenCalledWith('event', 'playground_execute', {
      tool: 'tool-id',
      outcome: 'success',
    });
  });
});
