import { copyTextToClipboard, htmlToPlainText, styleHtmlTables } from '@/utils/client/clipboard';

describe('clipboard utils', () => {
  const originalClipboard = { ...global.navigator.clipboard };
  const mockWriteText = jest.fn();
  const mockWrite = jest.fn();

  beforeEach(() => {
    // Mock ClipboardItem
    const ClipboardItemMock = jest.fn().mockImplementation((data) => ({
      types: Object.keys(data),
      getType: jest.fn(),
    })) as jest.Mock & { supports: jest.Mock };
    ClipboardItemMock.supports = jest.fn().mockReturnValue(true);

    // Assign our mock to global - this needs a type assertion since we're not implementing the full interface
    global.ClipboardItem =
      ClipboardItemMock as unknown as typeof global.ClipboardItem;

    // Mock clipboard API
    Object.defineProperty(global.navigator, 'clipboard', {
      value: {
        writeText: mockWriteText,
        write: mockWrite,
      },
      writable: true,
    });
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original clipboard
    Object.defineProperty(global.navigator, 'clipboard', {
      value: originalClipboard,
      writable: true,
    });
    // Clean up ClipboardItem mock
    delete (global as Partial<typeof globalThis>).ClipboardItem;
  });

  it('copies plain text to clipboard', async () => {
    const text = 'Hello, World!';
    await copyTextToClipboard(text);
    expect(mockWriteText).toHaveBeenCalledWith(text);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('copies HTML to clipboard with both HTML and plain text formats', async () => {
    const html = '<p>Hello, World!</p>';
    await copyTextToClipboard(html, true);
    expect(mockWrite).toHaveBeenCalledWith([
      expect.objectContaining({
        // Now provides both text/html and text/plain for cross-app compatibility
        types: ['text/html', 'text/plain'],
      }),
    ]);
    expect(mockWriteText).not.toHaveBeenCalled();
  });

  it('falls back to writeText when write is not available', async () => {
    // Remove write method to simulate older browsers
    Object.defineProperty(global.navigator, 'clipboard', {
      value: {
        writeText: mockWriteText,
      },
      writable: true,
    });

    const html = '<p>Hello, World!</p>';
    await copyTextToClipboard(html, true);
    expect(mockWriteText).toHaveBeenCalledWith(html);
  });

  it('handles errors gracefully', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    mockWriteText.mockRejectedValueOnce(new Error('Clipboard error'));

    await copyTextToClipboard('test');

    expect(consoleSpy).toHaveBeenCalledWith(
      'Copy to clipboard failed:',
      'Clipboard error',
    );

    consoleSpy.mockRestore();
  });
});

describe('styleHtmlTables', () => {
  it('adds border and styling attributes to tables', () => {
    const html = '<table><tr><th>Header</th></tr><tr><td>Data</td></tr></table>';
    const result = styleHtmlTables(html);
    expect(result).toContain('border-collapse: collapse');
    expect(result).toContain('border="1"');
    expect(result).toContain('cellpadding="8"');
  });

  it('adds styling to header cells', () => {
    const html = '<table><tr><th>Header</th></tr></table>';
    const result = styleHtmlTables(html);
    expect(result).toContain('background-color: #f5f5f5');
    expect(result).toContain('font-weight: bold');
  });

  it('adds styling to data cells', () => {
    const html = '<table><tr><td>Data</td></tr></table>';
    const result = styleHtmlTables(html);
    expect(result).toContain('border: 1px solid #ccc');
    expect(result).toContain('padding: 8px');
  });

  it('preserves non-table content', () => {
    const html = '<p>Hello</p><table><tr><td>Data</td></tr></table><p>World</p>';
    const result = styleHtmlTables(html);
    expect(result).toContain('<p>Hello</p>');
    expect(result).toContain('<p>World</p>');
  });

  it('handles content without tables', () => {
    const html = '<p>No tables here</p>';
    const result = styleHtmlTables(html);
    expect(result).toBe('<p>No tables here</p>');
  });
});

describe('htmlToPlainText', () => {
  it('converts simple paragraphs to plain text', () => {
    const html = '<p>Hello, World!</p>';
    const result = htmlToPlainText(html);
    expect(result).toBe('Hello, World!');
  });

  it('converts HTML table to pipe-delimited markdown format', () => {
    const html = `
      <table>
        <tr><th>Name</th><th>Value</th></tr>
        <tr><td>Item 1</td><td>100</td></tr>
        <tr><td>Item 2</td><td>200</td></tr>
      </table>
    `;
    const result = htmlToPlainText(html);
    expect(result).toContain('| Name | Value |');
    expect(result).toContain('| --- | --- |');
    expect(result).toContain('| Item 1 | 100 |');
    expect(result).toContain('| Item 2 | 200 |');
  });

  it('converts lists to bullet points', () => {
    const html = '<ul><li>First item</li><li>Second item</li></ul>';
    const result = htmlToPlainText(html);
    expect(result).toContain('• First item');
    expect(result).toContain('• Second item');
  });

  it('handles nested content', () => {
    const html = '<div><p>Paragraph 1</p><p>Paragraph 2</p></div>';
    const result = htmlToPlainText(html);
    expect(result).toContain('Paragraph 1');
    expect(result).toContain('Paragraph 2');
  });

  it('handles empty content gracefully', () => {
    const html = '';
    const result = htmlToPlainText(html);
    expect(result).toBe('');
  });

  it('removes excessive whitespace', () => {
    const html = '<p>First</p><p></p><p></p><p>Second</p>';
    const result = htmlToPlainText(html);
    // Should not have more than 2 consecutive newlines
    expect(result).not.toMatch(/\n{3,}/);
  });
});
