/**
 * Turns a simulated server's page into a document the Web Browser can show in a sandboxed iframe
 * without it ever reaching the real network or running code. An allowlist keeps the tags and
 * attributes a hand-written page uses; a Content-Security-Policy backs it up.
 */

export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** Tags kept, with their allowed attributes. */
const TAGS = new Set([
  ...['html', 'head', 'body', 'title', 'style'],
  ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'br', 'hr', 'a', 'img'],
  ...['b', 'strong', 'i', 'em', 'u', 's', 'small', 'big', 'mark', 'sub', 'sup', 'center', 'font'],
  ...['code', 'pre', 'kbd', 'samp', 'var', 'blockquote', 'q', 'cite', 'abbr', 'address', 'time'],
  ...['ul', 'ol', 'li', 'dl', 'dt', 'dd', 'details', 'summary', 'figure', 'figcaption'],
  ...['table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td'],
  ...['header', 'footer', 'main', 'nav', 'section', 'article', 'aside'],
]);

/** Tags dropped with everything inside them. Any other unknown tag is unwrapped. */
const DROPPED = new Set([
  ...['script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed'],
  ...['applet', 'portal', 'form', 'input', 'button', 'select', 'textarea', 'option'],
  ...['base', 'meta', 'link', 'audio', 'video', 'source', 'track', 'canvas', 'svg', 'math'],
]);

const ATTRIBUTES = new Set([
  ...['id', 'class', 'title', 'lang', 'dir', 'style', 'alt', 'name'],
  ...['align', 'valign', 'width', 'height', 'border', 'bgcolor', 'color', 'face', 'size'],
  ...['cellpadding', 'cellspacing', 'colspan', 'rowspan', 'scope', 'headers', 'span'],
  ...['start', 'type', 'reversed', 'open', 'datetime', 'href', 'src'],
]);

/** An image the page carries inline. Anything else would be a request to the real network. */
const DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|bmp|svg\+xml)[;,]/i;

function allowedAttribute(element: Element, name: string, value: string): boolean {
  if (!ATTRIBUTES.has(name)) return false;
  if (name === 'href') return element.localName === 'a' && value.trim().startsWith('#');
  if (name === 'src') return element.localName === 'img' && DATA_IMAGE.test(value.trim());
  return true;
}

function clean(parent: Node) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (!(node instanceof Element)) {
      node.remove();
      continue;
    }
    const tag = node.localName;
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml' || DROPPED.has(tag)) {
      node.remove();
      continue;
    }
    if (!TAGS.has(tag)) {
      // Keep the text of a tag we do not know, cleaned like the rest.
      clean(node);
      node.replaceWith(...node.childNodes);
      continue;
    }
    for (const { name, value } of [...node.attributes]) {
      if (!allowedAttribute(node, name, value)) node.removeAttribute(name);
    }
    clean(node);
  }
}

/** A full HTML document, safe for `<iframe sandbox="" srcdoc>`. */
export function sanitizePage(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  clean(doc.documentElement);
  for (const { name } of [...doc.documentElement.attributes]) {
    if (name !== 'lang' && name !== 'dir') doc.documentElement.removeAttribute(name);
  }
  const csp = doc.createElement('meta');
  csp.httpEquiv = 'Content-Security-Policy';
  csp.content = PAGE_CSP;
  doc.head.prepend(csp);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/** A response that is not HTML, shown as its text, as browsers show `text/plain`. */
export function plainTextPage(text: string): string {
  const doc = document.implementation.createHTMLDocument('');
  const pre = doc.createElement('pre');
  pre.textContent = text;
  pre.style.whiteSpace = 'pre-wrap';
  doc.body.append(pre);
  return sanitizePage(doc.documentElement.outerHTML);
}
