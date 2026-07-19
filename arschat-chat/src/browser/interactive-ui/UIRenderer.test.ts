import * as React from 'react';
import { render } from '@testing-library/react';
import { UIRenderer } from './UIRenderer';
import type { UINode } from './types';

describe('UIRenderer', () => {
  it('keeps hook order stable when showIf changes from false to true', () => {
    const node: UINode = {
      primitive: 'text',
      showIf: 'visible',
      props: { content: 'Visible now' }
    };
    const props = {
      node,
      state: { visible: false },
      onAction: jest.fn(),
      onStateChange: jest.fn()
    };
    const element = render(React.createElement(UIRenderer, props));

    expect(element.queryByText('Visible now')).toBeFalsy();
    expect(() => element.rerender(React.createElement(UIRenderer, {
      ...props,
      state: { visible: true }
    }))).not.toThrow();
    expect(element.queryByText('Visible now')).toBeTruthy();
  });
});
