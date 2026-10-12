import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { FooterContent } from '../../src/client/FooterContent.js';

function render(text: string): string {
  return renderToStaticMarkup(<FooterContent text={text} />);
}

describe('FooterContent', () => {
  it('preserves legacy plain text, including literal entities and angle brackets', () => {
    expect(render('Example Company &amp; Partners © 2026')).toBe('Example Company &amp;amp; Partners © 2026');
    expect(render('旧内容 <文字> & "引号"')).toBe('旧内容 &lt;文字&gt; &amp; &quot;引号&quot;');
    expect(render('')).toBe('');
  });

  it('renders the requested GitHub link with fixed safe attributes', () => {
    const markup = render('自豪地采用 <a href="https://github.com/laohiog/navlume">navlume</a>');
    expect(markup).toBe('自豪地采用 <a href="https://github.com/laohiog/navlume" target="_blank" rel="noopener noreferrer">navlume</a>');
  });

  it('supports multiple HTTP/HTTPS links and entities without changing surrounding text', () => {
    const markup = render('链接 &amp; <a href="https://example.com/?a=1&amp;b=2">A &amp; B</a> 和 <a href=\'http://example.org\'>第二个</a>');
    expect(markup.match(/<a /g)).toHaveLength(2);
    expect(markup).toContain('链接 &amp;amp;');
    expect(markup).toContain('href="https://example.com/?a=1&amp;b=2"');
    expect(markup).toContain('href="http://example.org/"');
    expect(markup).toContain('>A &amp; B</a>');
  });

  it('supports case, spacing and the opposite quote inside a URL', () => {
    const markup = render(`前文 <A HREF = "HTTPS://EXAMPLE.COM/a'b" >链接</A > 后文`);
    expect(markup).toContain('href="https://example.com/a&#x27;b"');
    expect(markup).toContain('>链接</a> 后文');
    expect(markup).toMatch(/^前文 <a /);
  });

  it.each([
    'javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javaScript:alert(1)',
    'data:text/html,hi', 'DATA:text/html,hi', 'file:///etc/passwd',
    'ftp://example.com', 'mailto:admin@example.com', 'tel:12345',
    'vbscript:msgbox(1)', 'java&#x73;cript:alert(1)', '&#106;avascript:alert(1)',
    'java&#x09;script:alert(1)', 'java&#10;script:alert(1)', 'java\nscript:alert(1)',
  ])('keeps dangerous and encoded protocols as text: %s', (href) => {
    const markup = render(`<a href="${href}">点击</a>`);
    expect(markup).not.toContain('<a ');
    expect(markup).toContain('&lt;a');
  });

  it.each(['', '/relative', '//example.com', '#section', 'example.com', 'https://', 'https://[invalid']) (
    'keeps missing, relative and malformed URLs as text: %s', (href) => {
      const markup = render(`<a href="${href}">链接</a>`);
      expect(markup).not.toContain('<a ');
      expect(markup).toContain('&lt;a');
    },
  );

  it.each(['onclick="alert(1)"', 'onmouseover="alert(1)"', 'ONFOCUS="alert(1)"', 'style="color:red"', 'target="_self"', 'download']) (
    'does not interpret extra attributes, even after a URL ending with a slash: %s', (attribute) => {
      const markup = render(`<a href="https://example.com/" ${attribute}>链接</a>`);
      expect(markup).not.toContain('<a ');
      expect(markup).toContain('&lt;a');
    },
  );

  it('never renders scripts, images, iframe, SVG or styles mixed with a safe link', () => {
    const markup = render('<script>alert(1)</script><img src=x onerror=alert(1)><svg onload=alert(1)></svg><iframe srcdoc="x"></iframe><style>body{display:none}</style><a href="https://example.com">正常链接</a>');
    expect(markup).not.toMatch(/<(?:script|img|svg|iframe|style)\b/i);
    expect(markup.match(/<a /g)).toHaveLength(1);
    expect(markup).toContain('>正常链接</a>');
  });

  it('keeps nested markup inside a link as escaped text', () => {
    const markup = render('<a href="https://example.com"><img src=x onerror=alert(1)><b>加粗</b></a>');
    expect(markup).not.toContain('<a ');
    expect(markup).not.toMatch(/<(?:img|b)\b/i);
    expect(markup).toContain('&lt;img');
    expect(markup).toContain('&lt;b&gt;');
  });

  it('escapes decoded label markup instead of creating active elements', () => {
    const markup = render('<a href="https://example.com">&#20013;&#x6587; &lt;img src=x onerror=alert(1)&gt;</a>');
    expect(markup).toContain('>中文 &lt;img src=x onerror=alert(1)&gt;</a>');
    expect(markup).not.toContain('<img');
  });

  it('keeps decoded quotes within the href value', () => {
    const markup = render('<a href="https://example.com/?q=&quot; onclick=&quot;alert(1)">链接</a>');
    expect(markup).toContain('href="https://example.com/?q=%22%20onclick=%22alert(1)"');
    expect(markup).not.toContain('" onclick="');
    expect(markup).toContain('rel="noopener noreferrer"');
  });
});
