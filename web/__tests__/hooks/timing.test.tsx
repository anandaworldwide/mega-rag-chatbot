import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { useCallback, useState } from 'react';

import { formatTimingMetricsDisplay } from "@/utils/client/chatPageUtils";

const TimingDisplay = ({
  timing,
}: {
  timing: {
    ttfb?: number;
    tokensPerSecond?: number;
  } | null;
}) => {
  const formattedTiming = formatTimingMetricsDisplay(timing);
  if (!formattedTiming) return null;
  return <div data-testid="timing-display">{formattedTiming}</div>;
};

describe('Timing Metrics Display', () => {
  test('formats timing metrics correctly', () => {
    const timingData = {
      ttfb: 1500,
      tokensPerSecond: 50,
    };

    render(<TimingDisplay timing={timingData} />);

    const display = screen.getByTestId('timing-display');
    expect(display).toHaveTextContent(
      '1.50 secs to first character, then 50 chars/sec streamed',
    );
  });

  test('handles null timing data', () => {
    render(<TimingDisplay timing={null} />);

    // The component should not render anything
    const display = screen.queryByTestId('timing-display');
    expect(display).not.toBeInTheDocument();
  });

  test('handles incomplete timing data', () => {
    const incompleteData = {
      ttfb: 1500,
    };

    render(<TimingDisplay timing={incompleteData} />);

    // The component should not render anything
    const display = screen.queryByTestId('timing-display');
    expect(display).not.toBeInTheDocument();
  });

  test('handles edge cases: zero values', () => {
    const zeroData = {
      ttfb: 0,
      tokensPerSecond: 0,
    };

    render(<TimingDisplay timing={zeroData} />);

    const display = screen.getByTestId('timing-display');
    expect(display).toHaveTextContent(
      '0.00 secs to first character, then 0 chars/sec streamed',
    );
  });

  test('handles edge cases: extremely large values', () => {
    const largeData = {
      ttfb: 10000,
      tokensPerSecond: 9999,
    };

    render(<TimingDisplay timing={largeData} />);

    const display = screen.getByTestId('timing-display');
    expect(display).toHaveTextContent(
      '10.00 secs to first character, then 9999 chars/sec streamed',
    );
  });
});

// Test that timing metrics work correctly in a stateful component
const StatefulTimingComponent = () => {
  const [timingMetrics, setTimingMetrics] = useState<{
    ttfb?: number;
    tokensPerSecond?: number;
  } | null>(null);

  const updateTiming = useCallback(() => {
    setTimingMetrics({
      ttfb: 2000,
      tokensPerSecond: 100,
    });
  }, []);

  return (
    <div>
      <button onClick={updateTiming} data-testid="update-timing">
        Update Timing
      </button>
      {timingMetrics && (
        <div data-testid="timing-display">
          {formatTimingMetricsDisplay(timingMetrics)}
        </div>
      )}
    </div>
  );
};

describe('Stateful Timing Component', () => {
  test('updates timing metrics correctly', async () => {
    render(<StatefulTimingComponent />);

    // Initially no timing display
    expect(screen.queryByTestId('timing-display')).not.toBeInTheDocument();

    // Update timing (wrapped in act)
    await act(async () => {
      fireEvent.click(screen.getByTestId('update-timing'));
      // Small delay to ensure the state update completes
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Now timing display should be shown
    const display = screen.getByTestId('timing-display');
    expect(display).toBeInTheDocument();
    expect(display).toHaveTextContent(
      '2.00 secs to first character, then 100 chars/sec streamed',
    );
  });
});
