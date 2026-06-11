import { logEvent } from '@/utils/client/analytics';
import { event } from 'nextjs-google-analytics';

// Mock nextjs-google-analytics
jest.mock('nextjs-google-analytics', () => ({
  event: jest.fn(),
}));

describe('analytics utils', () => {
  const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    consoleSpy.mockRestore();
    Object.defineProperty(process, 'env', {
      value: originalEnv,
      writable: true,
    });
  });

  it('logs to console in development mode', () => {
    Object.defineProperty(process, 'env', {
      value: { ...originalEnv, NODE_ENV: 'development' },
      writable: true,
    });

    logEvent('test_action', 'test_category', 'test_label', 123);

    expect(consoleSpy).toHaveBeenCalledWith(
      'skipping logEvent in dev mode',
      'test_action',
      'test_category',
      'test_label',
      123,
      undefined,
    );
    expect(event).not.toHaveBeenCalled();
  });

  it('sends event to Google Analytics in production mode', () => {
    Object.defineProperty(process, 'env', {
      value: { ...originalEnv, NODE_ENV: 'production' },
      writable: true,
    });

    logEvent('test_action', 'test_category', 'test_label', 123);

    expect(event).toHaveBeenCalledWith('test_action', {
      category: 'test_category',
      label: 'test_label',
      value: 123,
    });
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('handles events without value parameter', () => {
    Object.defineProperty(process, 'env', {
      value: { ...originalEnv, NODE_ENV: 'production' },
      writable: true,
    });

    logEvent('test_action', 'test_category', 'test_label');

    expect(event).toHaveBeenCalledWith('test_action', {
      category: 'test_category',
      label: 'test_label',
      value: undefined,
    });
  });

  it('forwards optional GA4 event parameters', () => {
    Object.defineProperty(process, 'env', {
      value: { ...originalEnv, NODE_ENV: 'production' },
      writable: true,
    });

    logEvent('task_popover_submit', 'Tasks', 'research', undefined, {
      task_id: 'research',
    });

    expect(event).toHaveBeenCalledWith('task_popover_submit', {
      category: 'Tasks',
      label: 'research',
      value: undefined,
      task_id: 'research',
    });
  });
});
