import 'reflect-metadata';
import { MessageService } from '@theia/core';
import { ContainerModule, Container } from '@theia/core/shared/inversify';
import { ArschatChatWidget } from './arschat-chat-widget';
import { render } from '@testing-library/react';
import { act } from 'react';

describe('ArschatChatWidget', () => {

    let widget: ArschatChatWidget;

    beforeEach(async () => {
        const module = new ContainerModule( bind => {
            bind(MessageService).toConstantValue({
                info(message: string): void {
                    console.log(message);
                }
            } as MessageService);
            bind(ArschatChatWidget).toSelf();
        });
        const container = new Container();
        container.load(module);
        await act(async () => {
            widget = container.resolve<ArschatChatWidget>(ArschatChatWidget);
        });
    });

    it('should render react node correctly', async () => {
        const element = render(widget.render());
        expect(element.queryByText('送信')).toBeTruthy();
    });

    it('should inject \'MessageService\'', () => {
        const spy = jest.spyOn(widget as any, 'displayMessage')
        widget['displayMessage']();
        expect(spy).toHaveBeenCalled();
    });

});
