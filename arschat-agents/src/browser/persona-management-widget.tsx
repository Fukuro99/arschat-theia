// *****************************************************************************
// ArsChat persona management panel (PHASE1_DESIGN.md §6, M4).
//
// A dedicated left-sidebar View for persona CRUD + active switching. Kept small
// and self-contained ON PURPOSE: §6 warns against repeating the old ArsChat
// Settings.tsx (2503-line single mega-screen). This panel does ONLY personas:
//   - list personas, with the active one highlighted and an "使用中" badge;
//   - click a row to activate it (also reflected in the chat header dropdown);
//   - "+ 新規" opens an inline editor to create;
//   - pencil edits name + system prompt inline; trash deletes (last one kept).
//
// All state lives in PersonaService (single source of truth). Its onDidChange
// keeps this panel and the chat header dropdown in sync.
// *****************************************************************************

import * as React from 'react';
import { injectable, postConstruct, inject } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { DisposableCollection } from '@theia/core';
import { PersonaService } from './persona-service';
import { Persona } from '../common/persona';

interface EditorState {
    /** persona id being edited, or 'new' for a create form, or undefined = closed. */
    mode: 'new' | { id: string } | undefined;
    name: string;
    systemPrompt: string;
}

@injectable()
export class ArschatPersonaManagementWidget extends ReactWidget {

    static readonly ID = 'arschat-agents:personas';
    static readonly LABEL = 'ペルソナ';

    @inject(PersonaService)
    protected readonly personaService!: PersonaService;

    protected personas: Persona[] = [];
    protected activeId = '';
    protected editor: EditorState = { mode: undefined, name: '', systemPrompt: '' };

    protected readonly toDispose = new DisposableCollection();

    @postConstruct()
    protected init(): void {
        this.id = ArschatPersonaManagementWidget.ID;
        this.title.label = ArschatPersonaManagementWidget.LABEL;
        this.title.caption = ArschatPersonaManagementWidget.LABEL;
        this.title.iconClass = 'fa fa-user-circle';
        this.title.closable = true;
        this.addClass('arschat-persona-panel');

        this.toDispose.push(this.personaService.onDidChange(() => this.refresh()));
        this.refresh();
    }

    override dispose(): void {
        this.toDispose.dispose();
        super.dispose();
    }

    protected async refresh(): Promise<void> {
        await this.personaService.ready();
        this.personas = this.personaService.getPersonas();
        this.activeId = this.personaService.getActivePersonaId();
        this.update();
    }

    // ---------------------------------------------------------------- actions

    protected async activatePersona(id: string): Promise<void> {
        await this.personaService.setActivePersona(id);
    }

    protected openNew(): void {
        this.editor = { mode: 'new', name: '', systemPrompt: '' };
        this.update();
    }

    protected openEdit(p: Persona): void {
        this.editor = { mode: { id: p.id }, name: p.name, systemPrompt: p.systemPrompt };
        this.update();
    }

    protected closeEditor(): void {
        this.editor = { mode: undefined, name: '', systemPrompt: '' };
        this.update();
    }

    protected async save(): Promise<void> {
        const name = this.editor.name.trim();
        const systemPrompt = this.editor.systemPrompt.trim();
        if (!name) {
            return;
        }
        if (this.editor.mode === 'new') {
            const created = await this.personaService.createPersona({ name, systemPrompt });
            await this.personaService.setActivePersona(created.id);
        } else if (this.editor.mode) {
            await this.personaService.updatePersona(this.editor.mode.id, { name, systemPrompt });
        }
        this.closeEditor();
    }

    protected async remove(id: string): Promise<void> {
        await this.personaService.deletePersona(id);
    }

    // ---------------------------------------------------------------- render

    render(): React.ReactElement {
        return (
            <div className='arschat-persona-root'>
                <div className='arschat-persona-header'>
                    <span className='arschat-persona-title'>ペルソナ</span>
                    <button
                        id='arschat-persona-new-button'
                        className='theia-button secondary'
                        title='ペルソナを作成'
                        onClick={() => this.openNew()}
                    >+ 新規</button>
                </div>
                {this.editor.mode !== undefined && this.renderEditor()}
                <div className='arschat-persona-list'>
                    {this.personas.map(p => this.renderRow(p))}
                </div>
            </div>
        );
    }

    protected renderRow(p: Persona): React.ReactElement {
        const isActive = p.id === this.activeId;
        return (
            <div key={p.id} className={`arschat-persona-item ${isActive ? 'active' : ''}`}>
                <button className='arschat-persona-select-row' title='このペルソナを使用' onClick={() => this.activatePersona(p.id)}>
                    <span className='arschat-persona-name'>{p.name}</span>
                    {isActive && <span className='arschat-persona-badge'>使用中</span>}
                    <span className='arschat-persona-prompt-preview'>{p.systemPrompt.slice(0, 60)}</span>
                </button>
                <div className='arschat-persona-actions'>
                    <button className='arschat-persona-icon' title='編集' onClick={() => this.openEdit(p)}>
                        <i className='fa fa-pencil' />
                    </button>
                    {this.personas.length > 1 && (
                        <button className='arschat-persona-icon' title='削除' onClick={() => this.remove(p.id)}>
                            <i className='fa fa-trash' />
                        </button>
                    )}
                </div>
            </div>
        );
    }

    protected renderEditor(): React.ReactElement {
        const isNew = this.editor.mode === 'new';
        return (
            <div className='arschat-persona-editor'>
                <div className='arschat-persona-editor-title'>{isNew ? '新しいペルソナ' : 'ペルソナを編集'}</div>
                <label className='arschat-persona-field'>
                    <span>名前</span>
                    <input
                        className='theia-input'
                        value={this.editor.name}
                        placeholder='例: コーダー'
                        onChange={e => { this.editor.name = e.target.value; this.update(); }}
                    />
                </label>
                <label className='arschat-persona-field'>
                    <span>システムプロンプト</span>
                    <textarea
                        className='theia-input arschat-persona-prompt-input'
                        value={this.editor.systemPrompt}
                        rows={6}
                        placeholder='このペルソナの振る舞いを記述...'
                        onChange={e => { this.editor.systemPrompt = e.target.value; this.update(); }}
                    />
                </label>
                <div className='arschat-persona-editor-buttons'>
                    <button className='theia-button' disabled={this.editor.name.trim().length === 0} onClick={() => this.save()}>保存</button>
                    <button className='theia-button secondary' onClick={() => this.closeEditor()}>キャンセル</button>
                </div>
            </div>
        );
    }
}
