/**
 * Turns a simulated server's page into a document the Web Browser can show in a sandboxed iframe
 * without it ever reaching the real network or running code. An allowlist keeps the tags and
 * attributes a hand-written page uses; a Content-Security-Policy backs it up. Links and GET forms
 * stay, for the browser to follow on the simulated network: see `followIn`.
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
  ...['form', 'input', 'button', 'label'],
]);

/** Tags dropped with everything inside them. Any other unknown tag is unwrapped. */
const DROPPED = new Set([
  ...['script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed'],
  ...['applet', 'portal', 'select', 'textarea', 'option'],
  ...['base', 'meta', 'link', 'audio', 'video', 'source', 'track', 'canvas', 'svg', 'math'],
]);

const ATTRIBUTES = new Set([
  ...['id', 'class', 'title', 'lang', 'dir', 'style', 'alt', 'name'],
  ...['align', 'valign', 'width', 'height', 'border', 'bgcolor', 'color', 'face', 'size'],
  ...['cellpadding', 'cellspacing', 'colspan', 'rowspan', 'scope', 'headers', 'span'],
  ...['start', 'type', 'reversed', 'open', 'datetime', 'href', 'src'],
  ...['action', 'method', 'value', 'placeholder', 'for'],
]);

/** A link the browser follows on the simulated network: in the page, on the site, or plain HTTP. */
const SIMULATED_LINK = /^(?:#|\/|\?|http:\/\/)/i;

/** The inputs a form keeps: text a person types, and the buttons that send it. */
const INPUT_TYPES = new Set(['text', 'password', 'hidden', 'submit', 'search', 'number', 'email']);

/** An image the page carries inline. Anything else would be a request to the real network. */
const DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp|bmp|svg\+xml)[;,]/i;

function allowedAttribute(element: Element, name: string, value: string): boolean {
  if (!ATTRIBUTES.has(name)) return false;
  if (name === 'href') return element.localName === 'a' && SIMULATED_LINK.test(value.trim());
  if (name === 'action') return element.localName === 'form' && SIMULATED_LINK.test(value.trim());
  if (name === 'method') return value.trim().toLowerCase() === 'get';
  if (name === 'type' && element.localName === 'input') return INPUT_TYPES.has(value.toLowerCase());
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

/**
 * A full HTML document, safe for `<iframe sandbox="allow-same-origin" srcdoc>`: it runs no script,
 * and the browser reaches into it only to follow its links and forms.
 */
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

/**
 * Follows the page's links and GET forms on the simulated network: a click on a link, or a submit
 * button or Enter in a form, calls `navigate` with the address it leads to, resolved against
 * `base`. A link within the page scrolls as usual. Returns a function that stops it.
 */
export function followIn(doc: Document, base: string, navigate: (url: string) => void) {
  // The frame's nodes come from its own realm, so `instanceof` against this window's classes fails.
  const elementOf = (target: EventTarget | null) =>
    target && 'closest' in target ? (target as Element) : null;
  const submit = (form: Element) => {
    const query = new URLSearchParams();
    for (const field of form.querySelectorAll('input')) {
      if (field.type === 'checkbox' && !field.checked) continue;
      if (!field.name || field.type === 'submit') continue;
      query.append(field.name, field.value);
    }
    const action = new URL(form.getAttribute('action') || '', base);
    action.search = query.toString();
    navigate(action.href);
  };
  const onClick = (event: MouseEvent) => {
    const target = elementOf(event.target);
    const link = target?.closest('a[href]');
    if (link) {
      const href = link.getAttribute('href') ?? '';
      if (href.startsWith('#')) return;
      event.preventDefault();
      navigate(new URL(href, base).href);
      return;
    }
    const button = target?.closest('button, input[type="submit"]');
    const form = button?.closest('form');
    if (button && form && (button.getAttribute('type') ?? 'submit') === 'submit') {
      event.preventDefault();
      submit(form);
    }
  };
  const onKey = (event: KeyboardEvent) => {
    const form = elementOf(event.target)?.closest('form');
    if (event.key !== 'Enter' || !form || elementOf(event.target)?.localName !== 'input') return;
    event.preventDefault();
    submit(form);
  };
  doc.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKey);
  return () => {
    doc.removeEventListener('click', onClick);
    doc.removeEventListener('keydown', onKey);
  };
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
