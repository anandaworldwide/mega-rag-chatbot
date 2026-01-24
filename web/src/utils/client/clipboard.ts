/**
 * Adds inline CSS styles to HTML tables so they render properly in
 * rich text apps like TextEdit, Word, Evernote, and Typora.
 * These apps often ignore <table> tags without explicit styling.
 */
const styleHtmlTables = (html: string): string => {
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  const tables = tempDiv.querySelectorAll('table');
  tables.forEach(table => {
    // Add table styling for proper rendering in rich text apps
    table.setAttribute('style', 'border-collapse: collapse; width: 100%; margin: 1em 0;');
    table.setAttribute('border', '1');
    table.setAttribute('cellpadding', '8');
    table.setAttribute('cellspacing', '0');

    // Style header cells
    table.querySelectorAll('th').forEach(th => {
      th.setAttribute('style', 'border: 1px solid #ccc; padding: 8px; background-color: #f5f5f5; font-weight: bold; text-align: left;');
    });

    // Style data cells
    table.querySelectorAll('td').forEach(td => {
      td.setAttribute('style', 'border: 1px solid #ccc; padding: 8px; text-align: left; vertical-align: top;');
    });

    // Style rows for alternating colors (helps readability)
    table.querySelectorAll('tr').forEach((tr, index) => {
      if (index > 0 && index % 2 === 0) {
        tr.setAttribute('style', 'background-color: #fafafa;');
      }
    });
  });

  return tempDiv.innerHTML;
};

/**
 * Strips HTML tags and converts to plain text.
 * Preserves table structure as pipe-delimited text for readability.
 */
const htmlToPlainText = (html: string): string => {
  // Create a temporary DOM element to parse HTML
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = html;

  // Process tables to preserve structure as pipe-delimited text
  const tables = tempDiv.querySelectorAll('table');
  tables.forEach(table => {
    const rows: string[] = [];
    table.querySelectorAll('tr').forEach(tr => {
      const cells: string[] = [];
      tr.querySelectorAll('th, td').forEach(cell => {
        cells.push((cell.textContent || '').trim());
      });
      if (cells.length > 0) {
        rows.push('| ' + cells.join(' | ') + ' |');
      }
    });
    // Add separator row after header if there are multiple rows
    if (rows.length > 1) {
      const headerCells = rows[0].split('|').filter(c => c.trim()).length;
      const separator = '| ' + Array(headerCells).fill('---').join(' | ') + ' |';
      rows.splice(1, 0, separator);
    }
    // Replace table with text representation
    const textNode = document.createTextNode('\n' + rows.join('\n') + '\n');
    table.parentNode?.replaceChild(textNode, table);
  });

  // Convert other block elements to newlines
  const blockElements = tempDiv.querySelectorAll('p, div, br, h1, h2, h3, h4, h5, h6, li');
  blockElements.forEach(el => {
    if (el.tagName === 'BR') {
      el.replaceWith('\n');
    } else if (el.tagName === 'LI') {
      el.prepend(document.createTextNode('• '));
      el.append(document.createTextNode('\n'));
    } else {
      el.append(document.createTextNode('\n\n'));
    }
  });

  // Get text content and clean up excessive whitespace
  let text = tempDiv.textContent || tempDiv.innerText || '';
  text = text.replace(/\n{3,}/g, '\n\n'); // Max 2 consecutive newlines
  text = text.trim();

  return text;
};

/**
 * Fallback copy using execCommand for browsers that don't support ClipboardItem.
 * Uses a hidden contenteditable div to preserve HTML formatting.
 */
const copyUsingExecCommand = (html: string, _plainText: string): boolean => {
  // Create a hidden container
  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-9999px';
  container.style.top = '0';
  container.setAttribute('contenteditable', 'true');
  container.innerHTML = html;
  document.body.appendChild(container);

  try {
    // Select the content
    const range = document.createRange();
    range.selectNodeContents(container);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }

    // Execute copy command
    const success = document.execCommand('copy');
    return success;
  } finally {
    document.body.removeChild(container);
  }
};

/**
 * Copies text to clipboard with support for both HTML and plain text formats.
 * When isHtml is true, provides both text/html AND text/plain MIME types
 * so the content works in both rich text and plain text applications.
 * Falls back to execCommand for browsers with limited ClipboardItem support.
 */
const copyTextToClipboard = async (text: string, isHtml: boolean = false) => {
  try {
    if (isHtml && navigator.clipboard.write) {
      // Style HTML tables for rich text app compatibility (TextEdit, Word, Evernote)
      const styledHtml = styleHtmlTables(text);
      // Create plain text version for text-only apps
      const plainText = htmlToPlainText(text);

      try {
        // Try the modern ClipboardItem API with both formats
        const clipboardItem = new ClipboardItem({
          'text/html': new Blob([styledHtml], { type: 'text/html' }),
          'text/plain': new Blob([plainText], { type: 'text/plain' }),
        });
        await navigator.clipboard.write([clipboardItem]);
        return;
      } catch (_clipboardItemError) {
        // Some browsers don't support multiple MIME types, try HTML only
        try {
          const htmlOnlyItem = new ClipboardItem({
            'text/html': new Blob([styledHtml], { type: 'text/html' }),
          });
          await navigator.clipboard.write([htmlOnlyItem]);
          return;
        } catch {
          // Fall through to execCommand fallback
        }
      }

      // Fallback: Use execCommand (deprecated but widely supported)
      const success = copyUsingExecCommand(styledHtml, plainText);
      if (!success) {
        // Last resort: just copy plain text
        await navigator.clipboard.writeText(plainText);
      }
    } else {
      await navigator.clipboard.writeText(text);
    }
  } catch (error) {
    console.error('Copy to clipboard failed:', error instanceof Error ? error.message : error);
    // Ultimate fallback: try writeText with plain text version
    try {
      const plainText = isHtml ? htmlToPlainText(text) : text;
      await navigator.clipboard.writeText(plainText);
    } catch (finalError) {
      console.error('All clipboard methods failed:', finalError instanceof Error ? finalError.message : finalError);
    }
  }
};

export { copyTextToClipboard, htmlToPlainText, styleHtmlTables };
