import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Marked } from 'marked';
import { memo, useMemo, type MouseEvent } from 'react';
import { post } from './vscode';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** `src/app.ts`, `src/app.ts:42`, `package.json` — things worth making clickable. */
const PATH_RE = /^(?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?::(\d+)(?:-\d+)?)?$/;

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? '').trim().split(/\s+/)[0] ?? '';
      let body: string;
      try {
        body =
          language && hljs.getLanguage(language)
            ? hljs.highlight(text, { language, ignoreIllegals: true }).value
            : escapeHtml(text);
      } catch {
        body = escapeHtml(text);
      }
      return (
        `<div class="codeblock"><div class="codeblock__head"><span>${escapeHtml(language || 'text')}</span>` +
        `<button class="codeblock__copy" data-copy="1" type="button">Copy</button></div>` +
        `<pre><code>${body}</code></pre></div>`
      );
    },
    codespan({ text }) {
      // `text` is already HTML-escaped by marked.
      const plain = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const match = PATH_RE.exec(plain);
      if (match && plain.length < 200 && !/^\d+(\.\d+)*$/.test(plain)) {
        const file = plain.replace(/:\d+(-\d+)?$/, '');
        const line = match[1] ? ` data-line="${match[1]}"` : '';
        return `<code class="path" data-path="${escapeHtml(file)}"${line} title="Open file">${text}</code>`;
      }
      return `<code>${text}</code>`;
    },
  },
});

export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['data-path', 'data-line', 'data-copy'],
    FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'img', 'video', 'audio', 'svg', 'math'],
    FORBID_ATTR: ['style', 'onerror', 'onclick'],
  });
}

function onClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement;

  const copy = target.closest<HTMLElement>('[data-copy]');
  if (copy) {
    const code = copy.closest('.codeblock')?.querySelector('pre');
    if (code) {
      post({ type: 'copy', text: code.textContent ?? '' });
      copy.textContent = 'Copied';
      window.setTimeout(() => {
        copy.textContent = 'Copy';
      }, 1400);
    }
    return;
  }

  const file = target.closest<HTMLElement>('code.path');
  if (file?.dataset.path) {
    post({ type: 'openFile', path: file.dataset.path, line: file.dataset.line ? Number(file.dataset.line) : undefined });
    return;
  }

  const link = target.closest('a');
  if (link) {
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) post({ type: 'openExternal', url: href });
    else if (href && !href.startsWith('#') && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      const [path, line] = href.replace(/^\.\//, '').split(/[#:]L?/);
      if (path) post({ type: 'openFile', path, line: line ? Number(line) : undefined });
    }
  }
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  // The HTML is sanitised above; this is the single place it is inserted.
  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
