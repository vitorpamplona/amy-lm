// markdown.js — convert a markdown string to a DOM element.
// Handles: headings, bold/italic, code blocks, inline code, lists,
// blockquotes, horizontal rules, links, and paragraphs.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inlineMarkdown(text) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\x01C${codes.length - 1}\x01`; });
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/_(.+?)_/g, '<em>$1</em>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safe = /^javascript:/i.test(href.trim()) ? '#' : href;
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  s = s.replace(/\x01C(\d+)\x01/g, (_, i) => `<code>${escapeHtml(codes[+i])}</code>`);
  return s;
}

export function markdown(text) {
  const root = document.createElement('div');
  root.className = 'md';

  // Pull fenced code blocks out before any other processing.
  const fenced = [];
  let src = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    fenced.push({ lang, code: code.replace(/\n$/, '') });
    return `\x00F${fenced.length - 1}\x00`;
  });

  for (const block of src.split(/\n{2,}/)) {
    const t = block.trim();
    if (!t) continue;

    // Fenced code block placeholder
    const fMatch = t.match(/^\x00F(\d+)\x00$/);
    if (fMatch) {
      const { lang, code } = fenced[+fMatch[1]];
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      if (lang) codeEl.className = `language-${lang}`;
      codeEl.textContent = code;
      pre.append(codeEl);
      root.append(pre);
      continue;
    }

    // Heading
    const hMatch = t.match(/^(#{1,6})\s+(.*)/);
    if (hMatch) {
      const h = document.createElement(`h${hMatch[1].length}`);
      h.innerHTML = inlineMarkdown(hMatch[2]);
      root.append(h);
      continue;
    }

    // Horizontal rule
    if (/^([-*_])\s*\1\s*\1[\s\1]*$/.test(t)) {
      root.append(document.createElement('hr'));
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(t)) {
      const bq = document.createElement('blockquote');
      bq.innerHTML = inlineMarkdown(t.replace(/^>\s?/gm, '').trim());
      root.append(bq);
      continue;
    }

    // Unordered list
    if (/^[-*+]\s/.test(t)) {
      const ul = document.createElement('ul');
      for (const line of t.split('\n')) {
        const m = line.match(/^[-*+]\s+(.*)/);
        if (m) { const li = document.createElement('li'); li.innerHTML = inlineMarkdown(m[1]); ul.append(li); }
      }
      root.append(ul);
      continue;
    }

    // Ordered list
    if (/^\d+[.)]\s/.test(t)) {
      const ol = document.createElement('ol');
      for (const line of t.split('\n')) {
        const m = line.match(/^\d+[.)]\s+(.*)/);
        if (m) { const li = document.createElement('li'); li.innerHTML = inlineMarkdown(m[1]); ol.append(li); }
      }
      root.append(ol);
      continue;
    }

    // Paragraph (join soft-wrapped lines)
    const p = document.createElement('p');
    p.innerHTML = inlineMarkdown(t.replace(/\n/g, ' '));
    root.append(p);
  }

  return root;
}
