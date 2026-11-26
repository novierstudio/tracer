import { describe, expect, it } from 'vitest';
import { PAGE_CSP, plainTextPage, sanitizePage } from './sanitize';

/** The sanitized page, parsed back, to ask what survived. */
const page = (html: string) => new DOMParser().parseFromString(sanitizePage(html), 'text/html');

describe('sanitizePage', () => {
  it('keeps a hand-written page: structure, text, tables, lists and inline styles', () => {
    const doc = page(`<!doctype html><html lang="en"><head><title>Lab</title>
      <style>h1 { color: teal }</style></head>
      <body class="home"><h1 style="font-size:2em">It works</h1>
      <table border="1"><tr><td colspan="2">cell</td></tr></table>
      <ul><li><a href="#top">Top</a></li></ul></body></html>`);
    expect(doc.title).toBe('Lab');
    expect(doc.documentElement.lang).toBe('en');
    expect(doc.querySelector('style')?.textContent).toContain('teal');
    expect(doc.querySelector('h1')?.getAttribute('style')).toBe('font-size:2em');
    expect(doc.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('#top');
    expect(doc.body.className).toBe('home');
  });

  it('puts the CSP first in the head, so nothing loads from the network', () => {
    const doc = page('<p>hi</p>');
    const first = doc.head.firstElementChild;
    expect(first?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(first?.getAttribute('content')).toBe(PAGE_CSP);
    expect(doc.querySelectorAll('meta')).toHaveLength(1);
  });

  it('drops scripts, frames, forms and the page’s own head tags, with their content', () => {
    const doc =
      page(`<head><base href="http://evil/"><meta http-equiv="refresh" content="0;url=http://evil/">
      <link rel="stylesheet" href="http://evil/x.css"></head>
      <body><script>alert(1)</script><iframe src="http://evil/"></iframe>
      <object data="x"></object><embed src="x"><form action="http://evil/"><input name="q"></form>
      <svg><script>alert(2)</script></svg><noscript>no</noscript><p>kept</p></body>`);
    for (const tag of [
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'base',
      'link',
      'svg',
    ]) {
      expect(doc.querySelector(tag), tag).toBeNull();
    }
    expect(doc.querySelectorAll('meta')).toHaveLength(1);
    expect(doc.body.textContent?.trim()).toBe('kept');
  });

  it('drops event handlers, and every URL but a fragment or an inline image', () => {
    const doc = page(`<p onclick="alert(1)" onmouseover="x()">t</p>
      <a href="javascript:alert(1)">js</a><a href="http://example.com/">out</a>
      <a href=" JAVASCRIPT:alert(1)">js2</a>
      <img src="http://example.com/x.png" onerror="alert(1)">
      <img src="data:image/png;base64,iVBORw0KGgo=" alt="dot">
      <img src="data:text/html,<script>alert(1)</script>">
      <div srcset="x" formaction="y" background="http://e/x.png">d</div>`);
    const p = doc.querySelector('p')!;
    expect(p.getAttributeNames()).toEqual([]);
    for (const a of doc.querySelectorAll('a')) expect(a.hasAttribute('href')).toBe(false);
    const images = [...doc.querySelectorAll('img')];
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      null,
      'data:image/png;base64,iVBORw0KGgo=',
      null,
    ]);
    expect(images[0]!.hasAttribute('onerror')).toBe(false);
    expect(doc.querySelector('div')!.getAttributeNames()).toEqual([]);
  });

  it('unwraps a tag it does not know, keeping its cleaned content', () => {
    const doc = page('<marquee><b onclick="x()">moving</b><script>bad()</script></marquee>');
    expect(doc.querySelector('marquee')).toBeNull();
    expect(doc.querySelector('b')?.outerHTML).toBe('<b>moving</b>');
    expect(doc.body.textContent).toBe('moving');
  });

  it('shows text that is not HTML as text', () => {
    const doc = new DOMParser().parseFromString(
      plainTextPage('<script>alert(1)</script> 404 Not Found'),
      'text/html',
    );
    expect(doc.querySelector('script')).toBeNull();
    expect(doc.querySelector('pre')?.textContent).toBe('<script>alert(1)</script> 404 Not Found');
  });
});
