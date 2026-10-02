// Unit tests for the safe markdown renderer. Run: node md-render.test.mjs
import { renderMarkdown, escapeHtml } from "./md-render.js";

let passed = 0;
function assert(c, m) { if (!c) { console.log("FAIL:", m); process.exit(1); } passed++; console.log("ok:", m); }
function has(html, sub, m) { assert(html.includes(sub), `${m} (got: ${html.slice(0, 120)})`); }
function hasNot(html, sub, m) { assert(!html.includes(sub), `${m} (got: ${html.slice(0, 120)})`); }

// --- escaping / XSS safety (the critical part) ---
has(renderMarkdown("<script>alert(1)</script>"), "&lt;script&gt;", "raw <script> is escaped, not executed");
hasNot(renderMarkdown("<img src=x onerror=alert(1)>"), "<img src=x", "raw HTML img is escaped");
// A javascript: link is neutralized to #
{
  const h = renderMarkdown("[click](javascript:alert(1))");
  has(h, 'href="#"', "javascript: URL neutralized to #");
  hasNot(h, "javascript:", "javascript: scheme removed");
}
// data: non-image neutralized, data:image allowed
has(renderMarkdown("![x](data:image/png;base64,AAA)"), "data:image/png", "data:image allowed for inline images");
has(renderMarkdown("[x](data:text/html,evil)"), 'href="#"', "data:text/html neutralized");

// --- headings ---
has(renderMarkdown("# Title"), "<h1>Title</h1>", "h1");
has(renderMarkdown("### Sub"), "<h3>Sub</h3>", "h3");

// --- emphasis ---
has(renderMarkdown("**bold**"), "<strong>bold</strong>", "bold");
has(renderMarkdown("some *italic* word"), "<em>italic</em>", "italic with *");
has(renderMarkdown("some _italic_ word"), "<em>italic</em>", "italic with _");
has(renderMarkdown("`code`"), "<code>code</code>", "inline code");

// --- links & images ---
has(renderMarkdown("[Kiro](https://kiro.dev)"), '<a href="https://kiro.dev"', "link href");
has(renderMarkdown("[Kiro](https://kiro.dev)"), ">Kiro</a>", "link text");
{
  const h = renderMarkdown("![a storm](media/vin__1__storm.png)");
  has(h, '<img alt="a storm"', "image alt");
  has(h, 'src="media/vin__1__storm.png"', "image src preserved (relative media path)");
  has(h, 'loading="lazy"', "image lazy-loaded");
}

// --- lists ---
{
  const h = renderMarkdown("- one\n- two");
  has(h, "<ul>", "ul open"); has(h, "<li>one</li>", "ul item"); has(h, "</ul>", "ul close");
}
{
  const h = renderMarkdown("1. first\n2. second");
  has(h, "<ol>", "ol open"); has(h, "<li>first</li>", "ol item");
}

// --- paragraphs, line breaks, hr, blockquote ---
has(renderMarkdown("line one\nline two"), "<br />", "soft line break within a paragraph");
has(renderMarkdown("para one\n\npara two"), "<p>para one</p>", "paragraph split on blank line");
has(renderMarkdown("---"), "<hr />", "horizontal rule");
has(renderMarkdown("> quoted"), "<blockquote>quoted</blockquote>", "blockquote");

// --- a realistic assembled story with an image renders coherently ---
{
  const story = "# Chapter 1\n\nThe lighthouse **stood** alone.\n\n![view](media/a__1__view.png)\n\nThe end.";
  const h = renderMarkdown(story);
  has(h, "<h1>Chapter 1</h1>", "story heading");
  has(h, "<strong>stood</strong>", "story bold");
  has(h, '<img alt="view" src="media/a__1__view.png"', "story image");
}

// escapeHtml direct
assert(escapeHtml(`<>&"'`) === "&lt;&gt;&amp;&quot;&#39;", "escapeHtml covers all five chars");

console.log(`\nALL ${passed} MD-RENDER TESTS PASSED`);
