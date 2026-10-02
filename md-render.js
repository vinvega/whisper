// Minimal, dependency-free, SAFE markdown -> HTML renderer.
//
// Safety is the priority: co-authors' post content is untrusted, so we ESCAPE all
// HTML first, then apply a small set of markdown transforms on the escaped text.
// This means raw HTML in a post is shown literally (never executed), and there is
// no innerHTML injection path. Supported: headings (#..######), bold (**),
// italic (*/_), inline code (`), links [text](url), images ![alt](src),
// unordered/ordered lists, blockquotes, horizontal rules, paragraphs, line breaks.
//
// Image `src` values that point at the shared folder (e.g. "media/pic.png") are
// left as-is in the markup; the caller resolves them to object URLs afterward via
// resolveImages() so the files actually display without this module doing I/O.

export function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only allow safe URL schemes in links/images (block javascript:, data:, etc.
// except data:image which is harmless for inline images).
function safeUrl(url) {
  const u = String(url || "").trim();
  if (/^(https?:|mailto:|\.|\/|[\w.-]+\/)/i.test(u)) return u; // http(s), mailto, relative
  if (/^data:image\//i.test(u)) return u;                       // inline images ok
  if (/^[\w.-]+\.[\w.-]+/i.test(u) && !/:/.test(u)) return u;    // bare relative file
  return "#"; // anything else (javascript:, vbscript:, other data:) is neutralized
}

// Inline transforms applied to already-escaped text.
function renderInline(escaped) {
  let s = escaped;

  // Images: ![alt](src)  (do before links so the leading ! is consumed)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
    return `<img alt="${alt}" src="${safeUrl(src)}" loading="lazy" />`;
  });

  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    return `<a href="${safeUrl(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  // Inline code: `code`
  s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);

  // Bold: **text**
  s = s.replace(/\*\*([^*]+)\*\*/g, (_m, t) => `<strong>${t}</strong>`);

  // Italic: *text* or _text_
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, (_m, pre, t) => `${pre}<em>${t}</em>`);
  s = s.replace(/(^|[^\w])_([^_\s][^_]*?)_(?=[^\w]|$)/g, (_m, pre, t) => `${pre}<em>${t}</em>`);

  return s;
}

// Block-level render. Input is raw markdown; output is safe HTML.
export function renderMarkdown(md) {
  const escaped = escapeHtml(md == null ? "" : String(md));
  const lines = escaped.split(/\r?\n/);

  const out = [];
  let i = 0;
  let listType = null; // "ul" | "ol" | null
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${renderInline(paraBuf.join("<br />"))}</p>`);
      paraBuf = [];
    }
  };
  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Blank line: paragraph/list break.
    if (trimmed === "") {
      flushPara();
      closeList();
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^(---|\*\*\*|___)$/.test(trimmed)) {
      flushPara();
      closeList();
      out.push("<hr />");
      i++;
      continue;
    }

    // Heading.
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (h) {
      flushPara();
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote.
    const bq = /^&gt;\s?(.*)$/.exec(trimmed); // ">" was escaped to &gt;
    if (bq) {
      flushPara();
      closeList();
      out.push(`<blockquote>${renderInline(bq[1])}</blockquote>`);
      i++;
      continue;
    }

    // Unordered list item.
    const ul = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (ul) {
      flushPara();
      if (listType !== "ul") {
        closeList();
        out.push("<ul>");
        listType = "ul";
      }
      out.push(`<li>${renderInline(ul[1])}</li>`);
      i++;
      continue;
    }

    // Ordered list item.
    const ol = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (ol) {
      flushPara();
      if (listType !== "ol") {
        closeList();
        out.push("<ol>");
        listType = "ol";
      }
      out.push(`<li>${renderInline(ol[1])}</li>`);
      i++;
      continue;
    }

    // Otherwise: part of a paragraph (soft-wrapped lines join with <br/>).
    closeList();
    paraBuf.push(line.trim());
    i++;
  }
  flushPara();
  closeList();

  return out.join("\n");
}
