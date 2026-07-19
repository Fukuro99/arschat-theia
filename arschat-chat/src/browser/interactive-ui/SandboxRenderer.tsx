import * as React from 'react';
import { useEffect, useMemo, useRef } from 'react';
import type { SandboxHTMLBlock } from './types';

interface SandboxRendererProps {
  block: SandboxHTMLBlock;
  onAction?: (uiId: string, action: string, data: Record<string, any>) => void;
  onIframeReady?: (uiId: string, iframe: HTMLIFrameElement | null) => void;
  isFinished?: boolean;
}

export const SANDBOX_CSP_CONTENT = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;";

export function injectSandboxCsp(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const meta = document.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', SANDBOX_CSP_CONTENT);
  document.head.insertBefore(meta, document.head.firstChild);
  const doctype = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '';
  return `${doctype}${document.documentElement.outerHTML}`;
}

export function SandboxRenderer({ block, onAction, onIframeReady, isFinished = false }: SandboxRendererProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const blobUrl = useMemo(() => {
    const blob = new Blob([injectSandboxCsp(block.html)], { type: 'text/html' });
    return URL.createObjectURL(blob);
  }, [block.html]);

  useEffect(() => () => URL.revokeObjectURL(blobUrl), [blobUrl]);

  useEffect(() => {
    onIframeReady?.(block.id, iframeRef.current);
    return () => onIframeReady?.(block.id, null);
  }, [block.id, onIframeReady]);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (!block.interactive || isFinished || !e.data || typeof e.data !== 'object') {
        return;
      }
      if (e.source !== iframeRef.current?.contentWindow) {
        return;
      }
      if (e.data.type !== 'interactive-ui-action' || e.data.uiId !== block.id) {
        return;
      }
      onAction?.(block.id, String(e.data.action || ''), e.data.data || {});
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [block.id, block.interactive, isFinished, onAction]);

  return (
    <div className={`iui-block${block.interactive ? ' iui-block-live' : ''}${isFinished ? ' iui-block-finished' : ''}`}>
      {block.title && (
        <div className="iui-block-title">
          {block.title}
          {block.interactive && (
            <span className={`iui-live-badge${isFinished ? ' iui-live-badge-finished' : ''}`}>
              {isFinished ? 'Finished' : 'LIVE'}
            </span>
          )}
        </div>
      )}
      <div className={`iui-sandbox-wrapper${isFinished ? ' iui-block-content-disabled' : ''}`}>
        <iframe
          ref={iframeRef}
          src={blobUrl}
          sandbox="allow-scripts"
          style={{
            width: block.width || '100%',
            height: block.height || '400px',
            border: 'none',
            borderRadius: '0',
            background: '#fff',
            display: 'block',
            pointerEvents: isFinished ? 'none' : 'auto',
          }}
          title={block.title || `sandbox-${block.id}`}
        />
      </div>
      {isFinished && (
        <div className="iui-block-submitted">
          <span>Finished</span>
        </div>
      )}
    </div>
  );
}
