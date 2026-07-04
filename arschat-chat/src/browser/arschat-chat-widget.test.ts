import 'reflect-metadata';
import { ContainerModule, Container } from '@theia/core/shared/inversify';
import { ArschatChatWidget } from './arschat-chat-widget';
import { ChatService } from '@theia/ai-chat/lib/common/chat-service';
import { ChatAgentService } from '@theia/ai-chat/lib/common/chat-agent-service';
import { ProviderSwitchService } from 'arschat-providers/lib/browser/provider-switch-service';
import { render } from '@testing-library/react';
import { act } from 'react';

describe('ArschatChatWidget', () => {

    let widget: ArschatChatWidget;

    beforeEach(async () => {
        const module = new ContainerModule(bind => {
            // Minimal stubs: doInit() is async and fired from postConstruct, but render()
            // works off the widget's own fields, so a bare stub is enough for rendering.
            bind(ProviderSwitchService).toConstantValue({
                getActiveProvider: () => 'anthropic',
                getActiveModel: () => '',
                getModelsForProvider: async () => [],
                resolveActiveModelId: () => undefined,
                setActive: async () => undefined,
                onDidChange: () => ({ dispose(): void { /* noop */ } })
            } as unknown as ProviderSwitchService);
            bind(ChatService).toConstantValue({} as ChatService);
            bind(ChatAgentService).toConstantValue({} as ChatAgentService);
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

    it('should show provider options in the header', () => {
        const element = render(widget.render());
        expect(element.queryByText('Anthropic')).toBeTruthy();
        expect(element.queryByText('LM Studio')).toBeTruthy();
    });

});
